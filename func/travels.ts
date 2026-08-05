import { Document, ObjectId } from "mongodb";
import { Request, Response, NextFunction } from "express";
import { DB_NAME, mongoConnection } from "../server";
import { Cache } from "../types/common";
import { PostDocument } from "../types/post";
import {
    TravelDocument,
    TravelParticipant,
    CreateTravelBody,
    UpdateTravelBody,
    CloseTravelBody,
    DeleteTravelBody,
    JoinTravelBody,
    LeaveTravelBody,
    SetPersonalBudgetBody,
    UploadTravelImageBody,
    JoinedTravelDocument,
    TravelParticipantInfo,
    MarkTravelSeenBody,
} from "../types/travel";
import { notify, notifyTravel } from "./notifications";
import { emitToTravel, emitToUser, invalidateMembership, isTravelParticipant } from "./realtime";
import { TRAVEL_EVENTS, USER_EVENTS } from "../types/realtime";
import { isSelf } from "./socketAuth";
import { contentTypeFromExtension, deleteStoredImage, uploadBuffer } from "../util/s3";
import { validateImageUpload } from "../util/imageValidation";
import { parseObjectId } from "../util/mongoIds";

// =====================================================================================
// Constants
// =====================================================================================

const TRAVELS_COLLECTION = "travels";
const POSTS_COLLECTION = "posts";
const USER_COLLECTION = "user";
/** Cartella legacy: immagini caricate prima della migrazione a S3, vedi util/s3.ts#deleteStoredImage. */
const IMAGE_DIR = "./static/userImage/";
/** Prefisso della key S3 per le copertine viaggio (vedi anche util/s3.ts). */
const IMAGE_S3_PREFIX = "userImage/";
const GENERIC_ERROR = "Errore esecuzione query";

const CACHE_TTL = {
    JOINED_TRAVELS: 100,
    PARTICIPANTS: 600,
    BY_CREATOR: 600,
};

// =====================================================================================
// Collection helpers
// =====================================================================================

function travelsCollection() {
    return mongoConnection.db(DB_NAME).collection<TravelDocument>(TRAVELS_COLLECTION);
}

function postsCollection() {
    return mongoConnection.db(DB_NAME).collection<PostDocument>(POSTS_COLLECTION);
}

function sendServerError(res: Response, message: string = GENERIC_ERROR) {
    res.status(500).send(message);
}

// =====================================================================================
// Cache invalidation
// =====================================================================================

/**
 * Invalida le cache che dipendono dall'elenco/dati di un viaggio, per ogni
 * partecipante coinvolto: va chiamata da ogni endpoint che crea, modifica,
 * chiude, cancella o cambia la lista partecipanti di un viaggio.
 * Le chiavi rispecchiano quelle usate in questo file e in func/user.ts
 * ("travelsNum-id=").
 */
function invalidateTravelCaches(cache: Cache, travelId: string, participants: TravelParticipant[]) {
    cache.del("takeParticipants=" + travelId);
    for (const participant of participants) {
        const userid = participant.userid?.toString();
        if (!userid) continue;
        cache.del("joined-id=" + userid);
        if (participant.creator) {
            cache.del("takeByCreator=" + userid);
            cache.del("travelsNum-id=" + userid);
        }
    }

    // Realtime, agganciato all'invalidazione perché sono la stessa cosa vista
    // da due lati: quello che diventa stantio in cache è esattamente quello
    // che è stantio sugli schermi già aperti. Chi tocca queste chiavi in un
    // nuovo endpoint ottiene il realtime senza doverci pensare.
    //
    // Due destinatari, come per Money: la stanza del viaggio raggiunge chi lo
    // sta guardando, le stanze personali raggiungono chi è sulla lista viaggi
    // (e chi è appena stato rimosso, che dalla stanza del viaggio non sarebbe
    // più raggiungibile).
    emitToTravel(travelId, TRAVEL_EVENTS.TRAVEL_UPDATED, {});
    for (const participant of participants) {
        emitToUser(participant.userid, USER_EVENTS.TRAVELS_CHANGED, { travelId });
        // La cache di appartenenza decide chi può entrare nella stanza del
        // viaggio: va buttata ora, altrimenti chi è appena entrato aspetta
        // fino a 15s per ricevere gli eventi e chi è appena uscito continua
        // a riceverli.
        invalidateMembership(participant.userid);
    }
}

/**
 * Invalida la cache di takeJoinedTravels ("joined-id=") per ogni
 * partecipante di un viaggio. Va chiamata da ogni endpoint che cambia il
 * campo `unseenCount` calcolato in joinedTravelsPipeline — cioè createPost,
 * updateVote, updatePayment, updateToDo (func/post.ts) — non solo da chi
 * tocca il documento del viaggio.
 *
 * Senza questa invalidazione il badge "non letti" resta fermo alla cache
 * precedente: takeJoinedTravels rinnova il TTL a ogni hit (vedi sotto), che
 * per un utente con la home aperta — quindi che continua a chiamare
 * l'endpoint — equivale a una cache che non scade mai da sola finché non
 * smette di guardare la schermata.
 *
 * Esportata (non `function` locale come invalidateTravelCaches) perché
 * chiamata da func/post.ts, un modulo diverso: qui non c'è già la lista
 * partecipanti sottomano come nei mutatori di travels.ts, va riletta.
 * Fire-and-forget: chi la chiama non la aspetta, stesso principio delle
 * emit realtime — un badge stantio per una query fallita non deve mai far
 * fallire la request che ha scritto il post.
 */
export async function invalidateUnseenCache(cache: Cache, travelId: ObjectId | string | undefined | null): Promise<void> {
    if (!travelId) return;

    try {
        const travel = await travelsCollection().findOne(
            { _id: new ObjectId(travelId) },
            { projection: { participants: 1 } }
        );
        if (!travel) return;

        for (const participant of travel.participants ?? []) {
            const userid = participant.userid?.toString();
            if (userid) cache.del("joined-id=" + userid);
        }
    } catch {
        /* best effort, vedi nota sopra */
    }
}

// =====================================================================================
// Aggregation pipelines
// =====================================================================================

/**
 * Viaggi a cui un utente partecipa, con lo username di ogni partecipante
 * unito tramite lookup sulla collection "user".
 */
function joinedTravelsPipeline(userid: string): Document[] {
    const me = new ObjectId(userid);

    return [
        { $match: { "participants.userid": me, closed: false } },
        { $sort: { creation_date: -1 } },
        // ---------------------------------------------------------------
        // Badge "non letti" (vedi unseenCount su JoinedTravelDocument):
        // per ogni viaggio si legge quando *questo* utente lo ha visto per
        // l'ultima volta (lastSeenAt sul suo participant), poi si contano i
        // post di quel viaggio più recenti, esclusi quelli creati da lui
        // stesso — altrimenti pubblicare qualcosa farebbe comparire un
        // badge sul proprio post appena creato.
        // ---------------------------------------------------------------
        {
            $addFields: {
                _myLastSeen: {
                    $let: {
                        vars: {
                            me: {
                                $first: {
                                    $filter: {
                                        input: "$participants",
                                        as: "p",
                                        cond: { $eq: ["$$p.userid", me] },
                                    },
                                },
                            },
                        },
                        in: "$$me.lastSeenAt",
                    },
                },
            },
        },
        {
            $lookup: {
                from: POSTS_COLLECTION,
                let: { travelId: "$_id", since: "$_myLastSeen" },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $eq: ["$travel", "$$travelId"] },
                                    { $ne: ["$creator", me] },
                                    {
                                        $gt: [
                                            { $ifNull: ["$updatedAt", "$dateTime"] },
                                            { $ifNull: ["$$since", new Date(0)] },
                                        ],
                                    },
                                ],
                            },
                        },
                    },
                    { $count: "count" },
                ],
                as: "_unseen",
            },
        },
        {
            $addFields: {
                unseenCount: { $ifNull: [{ $arrayElemAt: ["$_unseen.count", 0] }, 0] },
            },
        },
        {
            $lookup: {
                from: USER_COLLECTION,
                localField: "participants.userid",
                foreignField: "_id",
                as: "participantsInfo",
            },
        },
        {
            $addFields: {
                participants: {
                    $map: {
                        input: "$participants",
                        as: "p",
                        in: {
                            $mergeObjects: [
                                "$$p",
                                {
                                    username: {
                                        $arrayElemAt: [
                                            "$participantsInfo.username",
                                            { $indexOfArray: ["$participantsInfo._id", "$$p.userid"] },
                                        ],
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        },
        { $project: { participantsInfo: 0, _myLastSeen: 0, _unseen: 0 } },
    ];
}

/**
 * Elenco "piatto" dei partecipanti di un singolo viaggio, con i relativi
 * dati utente (username, nome, cognome).
 */
function participantsPipeline(travelId: string): Document[] {
    return [
        { $match: { _id: new ObjectId(travelId) } },
        { $unwind: "$participants" },
        {
            $lookup: {
                from: USER_COLLECTION,
                localField: "participants.userid",
                foreignField: "_id",
                as: "participants",
            },
        },
        { $unwind: "$participants" },
        {
            $project: {
                _id: "$participants._id",
                username: "$participants.username",
                name: "$participants.name",
                surname: "$participants.surname",
            },
        },
    ];
}

// =====================================================================================
// Travel CRUD
// =====================================================================================

/** Converte una data ISO in Date; stringa vuota, null e date non valide diventano null. */
function toDateOrNull(value?: string | null): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
}

/** Crea un nuovo viaggio. */
export async function createTravel(req: Request, res: Response, cache: Cache) {
    const body: CreateTravelBody = req.body;

    // Non si può creare un viaggio "per conto di" qualcun altro senza
    // parteciparvi: chi chiama deve comparire tra i partecipanti che sta
    // per inserire. Non basta da solo a impedire di inventare partecipanti
    // altrui nella lista (restano da whitelisting i campi accettati), ma
    // chiude il caso più semplice.
    const authUserId = req.auth?.userId;
    if (!authUserId || !body.participants?.some((p) => p.userid === authUserId)) {
        res.status(403).send("Non autorizzato");
        return;
    }

    // Costruito prima del `try` sottostante, dentro una funzione `async`: un
    // `new ObjectId` diretto qui sfuggirebbe al try/catch (il throw avviene
    // nella parte sincrona della funzione, ma Express non fa await su questa
    // chiamata) e diventerebbe una unhandled rejection. Si valida prima.
    const participantIds: (ObjectId | null)[] = body.participants.map((p) => parseObjectId(p.userid));
    if (participantIds.some((id) => id === null)) {
        res.status(400).send("Id partecipante non valido");
        return;
    }

    const travel: Omit<TravelDocument, "_id"> = {
        ...body,
        creation_date: new Date(body.creation_date),
        // destination/startDate/endDate arrivano dal flusso "Nuovo viaggio" come
        // stringhe (vuote se non compilate): qui diventano campi tipizzati, perché
        // i giorni della timeline dell'itinerario derivano da startDate/endDate.
        destination: (body.destination || "").trim(),
        startDate: toDateOrNull(body.startDate),
        endDate: toDateOrNull(body.endDate),
        participants: body.participants.map((participant, index): TravelParticipant => ({
            ...participant,
            userid: participantIds[index] as ObjectId,
            // Il viaggio è appena nato, quindi non c'è ancora storia da
            // nascondere: partire da "già visto ora" invece che da "mai
            // visto" evita che il primo post pubblicato prima che qualcuno
            // apra TravelDetail faccia comparire un badge sballato (vedi
            // unseenCount in joinedTravelsPipeline).
            lastSeenAt: new Date(),
        })),
    };

    try {
        const result = await travelsCollection().insertOne(travel as TravelDocument);
        invalidateTravelCaches(cache, result.insertedId.toString(), travel.participants);
        res.status(200).send(result);
    } catch (err) {
        sendServerError(res);
    }
}

/** Aggiorna nome, descrizione, budget e gli altri campi opzionali di un viaggio esistente. */
export async function updateTravel(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { id, param, userid }: UpdateTravelBody = req.body;

    const travelId = parseObjectId(id);
    if (!travelId) {
        res.status(400).send("Id non valido");
        next();
        return;
    }

    // Nome, descrizione e budget arrivano sempre; gli altri campi solo dai
    // client che li gestiscono (es. "Modifica viaggio", "imposta le date"
    // dell'itinerario), quindi vanno aggiornati solo quando presenti per non
    // azzerarli quando la richiesta arriva da un'altra schermata.
    const fields: Record<string, unknown> = {
        name: param.name,
        description: param.description,
        budget: param.budget,
    };

    if (param.destination !== undefined) fields.destination = param.destination;
    if (param.startDate !== undefined) fields.startDate = toDateOrNull(param.startDate);
    if (param.endDate !== undefined) fields.endDate = toDateOrNull(param.endDate);
    if (param.visibility !== undefined) fields.visibility = param.visibility;
    if (param.image !== undefined) fields.image = param.image;

    try {
        // Solo chi ha creato il viaggio può modificarne i dettagli: prima
        // qualunque richiesta con l'id giusto passava, chiunque ne fosse
        // l'autore reale.
        const existing = await travelsCollection().findOne(
            { _id: travelId },
            { projection: { image: 1, participants: 1 } }
        );
        if (!existing) {
            res.status(404).send("Viaggio non trovato");
            next();
            return;
        }
        const isCreator = existing.participants.some(
            (p) => p.userid?.toString() === req.auth?.userId && p.creator
        );
        if (!isCreator) {
            res.status(403).send("Solo chi ha creato il viaggio può modificarlo");
            next();
            return;
        }

        // Se la copertina cambia, la vecchia immagine va rimossa dal disco per
        // non accumulare file orfani (stesso criterio usato in deleteTravel).
        const previousImage: string | undefined = param.image !== undefined ? existing.image : undefined;

        const result = await travelsCollection().updateOne(
            { _id: travelId },
            // Cast necessario: i campi opzionali rendono "fields" un record generico.
            { $set: fields } as never
        );

        if (previousImage && previousImage !== param.image) {
            deleteStoredImage(previousImage, IMAGE_DIR);
        }

        const updated = await travelsCollection().findOne(
            { _id: travelId },
            { projection: { participants: 1 } }
        );
        if (updated) invalidateTravelCaches(cache, id, updated.participants);

        res.status(200).send(result);

        // Una sola notifica anche se l'utente salva più volte di fila: il
        // groupKey fonde le modifiche allo stesso viaggio entro mezz'ora.
        notifyTravel(id, {
            type: "travel_updated",
            actor: req.auth?.userId ?? userid ?? null,
            title: param.name,
            body: "{actor} ha modificato i dettagli del viaggio",
            target: { screen: "TravelDetail", params: { travelId: id } },
            groupKey: "travel_updated:" + id,
            cache,
        });
    } catch (err) {
        res.status(500).send("Errore esecuzione query 1");
    } finally {
        next();
    }
}

/** Marca un viaggio come chiuso. */
export async function closeTravel(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { id, userid }: CloseTravelBody = req.body;

    const travelId = parseObjectId(id);
    if (!travelId) {
        res.status(400).send("Id non valido");
        next();
        return;
    }

    try {
        // Stessa regola di updateTravel: solo il creatore può chiudere il viaggio.
        const existing = await travelsCollection().findOne(
            { _id: travelId },
            { projection: { participants: 1 } }
        );
        if (!existing) {
            res.status(404).send("Viaggio non trovato");
            next();
            return;
        }
        const isCreator = existing.participants.some(
            (p) => p.userid?.toString() === req.auth?.userId && p.creator
        );
        if (!isCreator) {
            res.status(403).send("Solo chi ha creato il viaggio può chiuderlo");
            next();
            return;
        }

        const result = await travelsCollection().updateOne({ _id: travelId }, { $set: { closed: true } });
        // Chiuso = escluso dalla lista "viaggi aperti" (joinedTravelsPipeline
        // filtra closed:false): senza invalidare, resta visibile fino a scadenza cache.
        const updated = await travelsCollection().findOne(
            { _id: travelId },
            { projection: { participants: 1 } }
        );
        if (updated) invalidateTravelCaches(cache, id, updated.participants);
        res.status(200).send(result);

        notifyTravel(id, {
            type: "travel_closed",
            actor: req.auth?.userId ?? userid ?? null,
            title: "Viaggio chiuso",
            body: "{actor} ha chiuso il viaggio: i conti restano consultabili",
            target: { screen: "TravelDetail", params: { travelId: id } },
            cache,
        });
    } catch (err) {
        res.status(500).send("Errore esecuzione query 1");
    } finally {
        next();
    }
}

/** Elimina un viaggio, l'eventuale immagine associata e i post collegati. */
export async function deleteTravel(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { id, userid }: DeleteTravelBody = req.body;

    const travelId = parseObjectId(id);
    if (!travelId) {
        res.status(400).send("Id non valido");
        next();
        return;
    }

    let travels;
    try {
        travels = await travelsCollection().find({ _id: travelId }).toArray();
    } catch (err) {
        res.status(500).send("Errore esecuzione query 1");
        next();
        return;
    }

    const travel = travels[0];
    if (!travel) {
        res.status(404).send("Viaggio non trovato");
        next();
        return;
    }

    // Stessa regola di updateTravel/closeTravel: solo il creatore cancella.
    const isCreator = travel.participants.some(
        (p) => p.userid?.toString() === req.auth?.userId && p.creator
    );
    if (!isCreator) {
        res.status(403).send("Solo chi ha creato il viaggio può eliminarlo");
        next();
        return;
    }

    if (travel.image) {
        deleteStoredImage(travel.image, IMAGE_DIR);
    }

    try {
        await travelsCollection().deleteOne({ _id: travelId });
        // NOTA: "travel" sui post è un ObjectId, ma qui viene confrontato con la
        // stringa "id" così come faceva il codice originale (comportamento preesistente).
        const result = await postsCollection().deleteMany({ travel: id } as any);
        if (travel) invalidateTravelCaches(cache, id, travel.participants);
        cache.del("travel-post=" + id);
        res.status(200).send(result);

        // notifyTravel non serve qui: il viaggio non esiste più, i destinatari
        // vanno presi dalla copia letta prima della deleteOne.
        if (travel) {
            notify({
                type: "travel_deleted",
                to: travel.participants.map((p) => p.userid),
                actor: req.auth?.userId ?? userid ?? null,
                title: travel.name,
                body: `{actor} ha eliminato il viaggio "${travel.name}"`,
                // Nessun target: la schermata di destinazione non esiste più.
                cache,
            });
        }
    } catch (err) {
        res.status(500).send("Errore esecuzione query 1");
    } finally {
        next();
    }
}

// =====================================================================================
// Partecipazione
// =====================================================================================

/** Iscrive l'utente al viaggio identificato dal codice invito. */
export async function joinTravel(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { code, username } = req.body as JoinTravelBody;
    // Ci si iscrive solo a proprio nome: prima "userid" arrivava dal body,
    // quindi bastava mandarne uno diverso dal proprio per aggiungere un
    // altro utente a un viaggio a sua insaputa.
    const userid = req.auth?.userId as string;

    let travels;
    try {
        travels = await travelsCollection().find({ code }).toArray();
    } catch (err) {
        sendServerError(res);
        next();
        return;
    }

    if (travels.length !== 1) {
        res.status(201).send("Codice viaggio non valido");
        next();
        return;
    }

    const travel = travels[0];

    // NOTA: TravelDocument non ha un campo "creator" a livello di documento
    // (solo participants[].creator): confronto preesistente, preservato com'era.
    if ((travel as any).creator == username) {
        res.status(201).send("Non puoi iscriverti al tuo viaggio");
        return;
    }

    const alreadyJoined =
        travel.participants.some((p) => p.userid.toString() == userid) ||
        travel.participants.includes({ userid, username } as any);
    if (alreadyJoined) {
        res.status(202).send("Sei già iscritto a questo viaggio");
        return;
    }

    if (travel.new_members_allowed == "0") {
        res.status(203).send("Non puoi iscriverti a questo viaggio");
        return;
    }

    try {
        // lastSeenAt = ora: chi entra non deve vedersi comparire in un colpo
        // solo un badge con tutta la storia del viaggio precedente al suo
        // ingresso (vedi la stessa scelta in createTravel).
        const newParticipant: TravelParticipant = { userid: new ObjectId(userid), lastSeenAt: new Date() };
        const result = await travelsCollection().updateOne(
            { code },
            { $push: { participants: newParticipant } }
        );
        invalidateTravelCaches(cache, travel._id.toString(), [...travel.participants, newParticipant]);
        res.status(200).send(result);

        // I destinatari sono i partecipanti di prima: chi entra non si autonotifica
        // (e `notify` lo escluderebbe comunque tramite `actor`).
        notify({
            type: "travel_joined",
            to: travel.participants.map((p) => p.userid),
            actor: userid,
            travel: travel._id,
            travelName: travel.name,
            title: travel.name,
            body: "{actor} si è unito al viaggio 🎒",
            target: { screen: "TravelPartecipants", params: { travelId: travel._id.toString() } },
            cache,
        });
    } catch (err) {
        sendServerError(res);
    } finally {
        next();
    }
}

/**
 * Imposta (o rimuove, passando null) il tetto di spesa personale che un
 * partecipante si è dato per un viaggio.
 *
 * Prima di questa route il budget personale viveva solo nello state di
 * BudgetIndicator: spariva a ogni rimontaggio della schermata. Viene salvato
 * sull'elemento di `participants` corrispondente all'utente, così torna
 * indietro insieme al viaggio in takeJoinedTravels senza query aggiuntive.
 */
export async function setPersonalBudget(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { travelid, budget } = req.body as SetPersonalBudgetBody;
    // Il tetto di spesa personale è privato: si può impostare solo il proprio.
    const userid = req.auth?.userId as string;

    if (!travelid || !userid) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }

    const value =
        budget === null || budget === undefined || Number.isNaN(Number(budget))
            ? null
            : Number(budget);

    if (value !== null && value < 0) {
        res.status(400).send("Budget non valido");
        next();
        return;
    }

    const travelObjectId = parseObjectId(travelid);
    const userObjectId = parseObjectId(userid);
    if (!travelObjectId || !userObjectId) {
        res.status(400).send("Id non valido");
        next();
        return;
    }

    try {
        const result = await travelsCollection().updateOne(
            { _id: travelObjectId, "participants.userid": userObjectId },
            { $set: { "participants.$.personalBudget": value } }
        );

        if (result.matchedCount === 0) {
            res.status(404).send("Partecipante non trovato");
            next();
            return;
        }

        // Il viaggio arriva al client dentro la lista "joined": senza
        // invalidare, il budget appena salvato non si vedrebbe fino a scadenza.
        cache.del("joined-id=" + userid);
        cache.del("takeByCreator=" + userid);

        res.status(200).send({ personalBudget: value });

        // Il budget personale è privato: interessa solo gli altri dispositivi
        // dello stesso utente, non il gruppo. Per questo va sulla stanza
        // personale e non su quella del viaggio.
        emitToUser(userid, USER_EVENTS.TRAVELS_CHANGED, { travelId: travelid });
    } catch (err) {
        sendServerError(res);
    } finally {
        next();
    }
}

/**
 * Segna un viaggio come "visto" da un partecipante, azzerando il badge
 * "non letti" che takeJoinedTravels calcola per lui. Chiamata dal client
 * all'apertura di TravelDetail — non è una scrittura critica (vedi
 * CLAUDE.md, "cosa è deliberatamente non in coda offline"): se fallisce o
 * l'utente è offline il badge resta com'era, senza impatto sui dati.
 */
export async function markTravelSeen(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { travelid } = req.body as MarkTravelSeenBody;
    // Si può marcare come "visto" solo il proprio badge, mai quello di un altro.
    const userid = req.auth?.userId as string;

    if (!travelid || !userid) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }

    const travelObjectId = parseObjectId(travelid);
    const userObjectId = parseObjectId(userid);
    if (!travelObjectId || !userObjectId) {
        res.status(400).send("Id non valido");
        next();
        return;
    }

    try {
        await travelsCollection().updateOne(
            { _id: travelObjectId, "participants.userid": userObjectId },
            { $set: { "participants.$.lastSeenAt": new Date() } }
        );

        // Il badge vive dentro la risposta di takeJoinedTravels: senza
        // invalidare resterebbe visibile fino a scadenza cache.
        cache.del("joined-id=" + userid);

        res.status(200).send({ ok: true });

        // Stessa stanza personale che il resto della lista viaggi usa per
        // aggiornarsi da sola (vedi invalidateTravelCaches): la home, già in
        // ascolto su TRAVELS_CHANGED, ricarica e il badge sparisce senza
        // bisogno di un pull-to-refresh.
        emitToUser(userid, USER_EVENTS.TRAVELS_CHANGED, { travelId: travelid });
    } catch (err) {
        sendServerError(res);
    } finally {
        next();
    }
}

/** Rimuove l'utente da un viaggio, eliminando il viaggio stesso se era l'unico partecipante. */
export async function leaveTravel(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { travel: travelId } = req.body as LeaveTravelBody;
    // Ci si può far uscire solo da soli: senza questo, chiunque conoscesse
    // l'id di un viaggio poteva rimuoverne un partecipante a piacere.
    const userid = req.auth?.userId as string;

    const travelObjectId = parseObjectId(travelId);
    if (!travelObjectId) {
        res.status(400).send("Id non valido");
        next();
        return;
    }

    let travel;
    try {
        travel = await travelsCollection().findOne({ _id: travelObjectId });
    } catch (err) {
        res.status(500).send("Errore esecuzione query 1");
        next();
        return;
    }

    try {
        if (travel.participants.length === 1) {
            await travelsCollection().deleteOne({ _id: travelObjectId });
            // NOTA: stesso disallineamento string/ObjectId preesistente descritto in deleteTravel.
            const result = await postsCollection().deleteMany({ travel: travelId } as any);
            invalidateTravelCaches(cache, travelId, travel.participants);
            cache.del("travel-post=" + travelId);
            res.status(200).send(result);
        } else {
            const remainingParticipants = travel.participants.filter((p) => p.userid.toString() != userid);
            const result = await travelsCollection().updateOne(
                { _id: travelObjectId },
                { $set: { participants: remainingParticipants } }
            );
            // Invalida sia per chi resta (partecipanti cambiati) sia per chi è uscito
            // (che altrimenti continuerebbe a vedersi il viaggio tra i suoi).
            invalidateTravelCaches(cache, travelId, travel.participants);
            res.status(200).send(result);

            notify({
                type: "travel_left",
                to: remainingParticipants.map((p) => p.userid),
                actor: userid,
                travel: travel._id,
                travelName: travel.name,
                title: travel.name,
                body: "{actor} ha lasciato il viaggio",
                target: { screen: "TravelPartecipants", params: { travelId } },
                cache,
            });
        }
    } catch (err) {
        res.status(500).send("Errore esecuzione query 1");
    } finally {
        next();
    }
}

// =====================================================================================
// Query
// =====================================================================================

/** Viaggi aperti a cui l'utente partecipa, ordinati dal più recente, con username dei partecipanti. */
export async function takeJoinedTravels(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const userid = req.query.userid as string;
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }
    const cacheKey = "joined-id=" + userid;

    const cachedData = cache.get<JoinedTravelDocument[]>(cacheKey);
    if (cachedData) {
        cache.set(cacheKey, cachedData, CACHE_TTL.JOINED_TRAVELS);
        res.status(200).send(cachedData);
        next();
        return;
    }

    try {
        const data = await travelsCollection().aggregate<JoinedTravelDocument>(joinedTravelsPipeline(userid)).toArray();
        cache.set(cacheKey, data, CACHE_TTL.JOINED_TRAVELS);
        res.status(200).send(data);
    } catch (err) {
        sendServerError(res);
    } finally {
        next();
    }
}

/** Partecipanti di un viaggio con i relativi dati utente. */
export async function takeTravelsParticipants(req: Request, res: Response, cache: Cache) {
    const travel = req.query.travel as string;
    const authUserId = req.auth?.userId;
    if (!authUserId || !(await isTravelParticipant(authUserId, travel))) {
        res.status(403).send("Non autorizzato");
        return;
    }
    const cacheKey = "takeParticipants=" + travel;

    const cachedData = cache.get<TravelParticipantInfo[]>(cacheKey);
    if (cachedData) {
        cache.set(cacheKey, cachedData, CACHE_TTL.PARTICIPANTS);
        res.status(200).send(cachedData);
        return;
    }

    try {
        const data = await travelsCollection().aggregate<TravelParticipantInfo>(participantsPipeline(travel)).toArray();
        cache.set(cacheKey, data, CACHE_TTL.PARTICIPANTS);
        res.status(200).send(data);
    } catch (err) {
        sendServerError(res);
    }
}

/** Viaggi creati dall'utente. */
export async function takeTravelByCreator(req: Request, res: Response, cache: Cache, next?: NextFunction) {
    const userid = req.query.userid as string;
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        return;
    }
    const cacheKey = "takeByCreator=" + userid;

    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        cache.set(cacheKey, cachedData, CACHE_TTL.BY_CREATOR);
        res.status(200).send(cachedData);
        return;
    }

    try {
        const data = await travelsCollection()
            .find(
                { participants: { $elemMatch: { userid: new ObjectId(userid), creator: true } } },
                { projection: { "participants.$": 1, creation_date: 1 } }
            )
            .sort({ creation_date: -1 })
            .toArray();
        cache.set(cacheKey, data, CACHE_TTL.BY_CREATOR);
        res.status(200).send(data);
    } catch (err) {
        sendServerError(res);
    }
}

// =====================================================================================
// Media
// =====================================================================================

/** Carica l'immagine (base64) inviata dal client su S3 e restituisce l'URL pubblico dell'oggetto. */
export async function uploadImage(req: Request, res: Response, next: NextFunction) {
    const { img, imgName }: UploadTravelImageBody = req.body;
    const buffer = Buffer.from(img.replace(/^data:image\/\w+;base64,/, ""), "base64");

    // Whitelist sull'estensione + verifica dei magic bytes: vedi
    // util/imageValidation.ts sul perché servono entrambe.
    const validation = validateImageUpload(imgName, buffer);
    if (!validation.ok) {
        res.status(400).send(validation.reason);
        next();
        return;
    }

    const newName = Math.random().toString(36).substring(2, 20) + Math.random().toString(36).substring(2, 20);
    const ext = imgName.split(".").pop()!.toLowerCase();
    const fileName = `${newName}.${ext}`;

    try {
        const url = await uploadBuffer(IMAGE_S3_PREFIX + fileName, buffer, contentTypeFromExtension(ext));
        res.status(200).send(url);
    } catch (err: any) {
        console.log(err.message);
        res.status(500).send(err.message);
    } finally {
        next();
    }
}
