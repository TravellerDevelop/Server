import { ObjectId } from "mongodb";
import { Request, Response, NextFunction } from "express";
import { DB_NAME, mongoConnection } from "../server";
import { Cache } from "../types/common";
import { TravelDocument } from "../types/travel";
import { UserDocument } from "../types/user";
import {
    PostDocument,
    PostWithCreatorData,
    CreatePostBody,
    UpdateVoteBody,
    UpdatePaymentBody,
    UpdatePinPostBody,
    DeletePostBody,
    AddPostImageBody,
    UpdateToDoBody,
    PayedGroupByTravel,
    PostDestinator,
} from "../types/post";
import { invalidateMoneyCache } from "./money";
import { notify, notifyTravel } from "./notifications";
import { emitToTravel, emitMoneyChanged, isTravelParticipant } from "./realtime";
import { invalidateUnseenCache } from "./travels";
import { TRAVEL_EVENTS } from "../types/realtime";
import { isSelf } from "./socketAuth";
import { contentTypeFromExtension, deleteStoredImage, uploadBuffer } from "../util/s3";
import { validateImageUpload } from "../util/imageValidation";
import { parseObjectId } from "../util/mongoIds";

/** Cartella legacy: immagini dei post caricate prima della migrazione a S3. */
const POST_IMAGE_DIR = "./static/userImage/posts/";
/** Prefisso della key S3 per le immagini dei post. */
const POST_IMAGE_S3_PREFIX = "userImage/posts/";

/*

-----------
Cached data
-----------
"latest-post=" + user_id -> Ultimi post per ogni utente (Da rimuovere, rischio di incongruenze)
"travel-post=" + travel_id -> Post relativi ad un viaggio

*/

function postsCollection() {
    return mongoConnection.db(DB_NAME).collection<PostDocument>("posts");
}

function travelsCollection() {
    return mongoConnection.db(DB_NAME).collection<TravelDocument>("travels");
}

function userCollection() {
    return mongoConnection.db(DB_NAME).collection<UserDocument>("user");
}

/** Proiezione dei dati utente del creatore, senza email/password/notifToken. */
const CREATOR_DATA_PROJECTION = {
    "creatorData.email": false,
    "creatorData.notifToken": false,
    "creatorData.password": false,
};

export async function createPost(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const body: CreatePostBody = req.body;
    const authUserId = req.auth?.userId;
    if (!authUserId) {
        res.status(401).send("Non autenticato");
        next();
        return;
    }

    // Mutato "alla vecchia maniera" (come il codice originale): travel/creator arrivano come
    // stringhe e vengono convertite in ObjectId; se la conversione fallisce l'errore viene
    // solo loggato e l'inserimento prosegue comunque (comportamento preesistente preservato).
    const now = new Date();
    const param: any = { ...body.param, dateTime: now, updatedAt: now };
    try {
        param.travel = new ObjectId(body.param.travel);
    } catch (ex) {
        console.error('Incorrect data format')
    }
    // Il creatore è sempre chi ha chiamato l'API, mai quello dichiarato nel
    // body: prima chiunque poteva far comparire un post (incluse le spese,
    // vedi types/post.ts) come creato da un altro utente.
    param.creator = new ObjectId(authUserId);

    if (param.travel instanceof ObjectId) {
        const allowed = await isTravelParticipant(authUserId, param.travel.toString());
        if (!allowed) {
            res.status(403).send("Non fai parte di questo viaggio");
            next();
            return;
        }
    }

    postsCollection().insertOne(param, function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
            next();
        } else {
            // La risposta va inviata una sola volta, subito dopo l'inserimento:
            // le notifiche push (sotto) vengono inviate a ciascun partecipante in
            // modo asincrono e NON devono determinare quando/quante volte si
            // risponde alla request, altrimenti res.send() verrebbe chiamato una
            // volta per partecipante causando "Cannot set headers after they are
            // sent to the client" su ogni post con più di un destinatario.
            res.status(200).send(data);

            // Notifiche: delegate al dispatcher (func/notifications.ts).
            // Il codice che stava qui costruiva l'array `messages` DENTRO il ciclo
            // sui token e lo rispediva a ogni iterazione, quindi un utente con due
            // dispositivi riceveva la prima push due volte, la seconda una; inoltre
            // avvisava anche l'autore del post e non distingueva il tipo di post.
            notifyNewPost(param, data?.insertedId, cache);

            // Realtime: gli altri dispositivi già dentro il viaggio vedono il
            // post comparire senza ricaricare. Prima toccava al client che
            // scriveva rilanciare l'evento agli altri (e nessuna schermata lo
            // faceva davvero), quindi il feed restava fermo fino al
            // pull-to-refresh.
            emitNewPost(data?.insertedId, param.travel, param.creator?.toString());
            if (param.type === "payments") emitMoneyChanged(param.travel, param.creator?.toString());

        }
        cache.del("travel-post=" + param.travel);
        if (param.type === "payments") invalidateMoneyCache(cache, param.travel);
        // Badge "non letti" delle card in home: senza, la cache di
        // takeJoinedTravels degli altri partecipanti resta ferma al valore
        // di prima di questo post (vedi invalidateUnseenCache).
        void invalidateUnseenCache(cache, param.travel);
    });
}

/**
 * Rilegge il post appena inserito con la stessa pipeline di takePosts e lo
 * manda alla stanza del viaggio.
 *
 * Costa una query in più, ma è l'unico modo perché il payload sia
 * *identico* a quello che il feed riceverebbe da `api/post/takePosts`:
 * mandare il `param` grezzo dell'insert significherebbe un post senza
 * `creatorData`, e il client dovrebbe avere due strade diverse per
 * costruire la stessa riga (con le due che divergono alla prima modifica).
 * Se la rilettura fallisce si emette comunque un evento senza post: il
 * client lo interpreta come "ricarica il feed".
 */
function emitNewPost(postId: ObjectId | undefined, travelId: ObjectId | string | undefined, actorId?: string): void {
    if (!postId || !travelId) return;

    postsCollection()
        .aggregate<PostWithCreatorData>([
            { $match: { _id: postId } },
            { $lookup: { from: "user", localField: "creator", foreignField: "_id", as: "creatorData" } },
            { $project: CREATOR_DATA_PROJECTION },
        ])
        .toArray()
        .then((rows) => {
            emitToTravel(travelId, TRAVEL_EVENTS.POST_NEW, { post: rows[0] ?? null, actorId });
        })
        .catch(() => {
            emitToTravel(travelId, TRAVEL_EVENTS.POST_NEW, { post: null, actorId });
        });
}

/**
 * Traduce un post appena creato nella notifica giusta.
 *
 * I destinatari e il canale cambiano col tipo: un pagamento riguarda solo
 * chi ci ha una quota (e finisce nel centro notifiche, perché richiede
 * un'azione), un post di testo riguarda tutto il gruppo ma resta una push
 * e basta — nel centro notifiche sarebbe rumore.
 *
 * `target` porta solo id: le schermate dell'app vogliono oggetti interi
 * (TravelDetail prende `data`, PaymentInfo prende `item`), quindi è il
 * client a idratarli prima di navigare (vedi components/notifications).
 */
function notifyNewPost(param: any, postId: ObjectId | undefined, cache: Cache): void {
    const travelId: ObjectId = param.travel;
    if (!(travelId instanceof ObjectId)) return;

    (async () => {
        try {
            const travel = await travelsCollection().findOne(
                { _id: travelId },
                { projection: { name: 1, participants: 1, budget: 1 } }
            );
            if (!travel) return;

            const creator = await userCollection().findOne(
                { _id: param.creator },
                { projection: { name: 1, surname: 1, username: 1 } }
            );
            const who = creator
                ? `${creator.name ?? ""} ${creator.surname ?? ""}`.trim() || creator.username
                : "Qualcuno";

            const travelTarget = {
                screen: "TravelDetail",
                params: { travelId: travelId.toString() },
            };
            const common = {
                actor: param.creator,
                actorName: who,
                travelName: travel.name,
                entity: postId ?? null,
                cache,
            };

            switch (param.type) {
                case "payments": {
                    // `amount` è la quota pro capite e `destinator` esclude il creatore
                    // per i pagamenti "normal" (vedi types/money.ts): notifichiamo
                    // solo chi ha davvero una quota da coprire.
                    if (param.paymentType === "personal") return;

                    const debtors: string[] = (param.destinator || [])
                        .map((d: { userid: string }) => d.userid)
                        .filter(Boolean);
                    if (debtors.length === 0) return;

                    const quota = Number(param.amount) || 0;
                    await notify({
                        ...common,
                        type: "payment_new",
                        to: debtors,
                        travel: travelId,
                        title: travel.name,
                        body:
                            `${who} ha aggiunto "${param.description || "una spesa"}"` +
                            (quota > 0 ? `: la tua quota è € ${quota.toFixed(2)}` : ""),
                        target: { screen: "PaymentInfo", params: { postId: postId?.toString() } },
                    });

                    await checkBudget(travel, cache);
                    return;
                }

                case "vote":
                    await notifyTravel(travelId, {
                        ...common,
                        type: "vote_new",
                        title: travel.name,
                        body: `${who} ha aperto un sondaggio: ${param.question || "dai la tua preferenza"}`,
                        target: travelTarget,
                    });
                    return;

                case "todo":
                    await notifyTravel(travelId, {
                        ...common,
                        type: "todo_assigned",
                        title: travel.name,
                        body: `${who} ha creato una lista di cose da fare: ${param.description || ""}`.trim(),
                        target: travelTarget,
                    });
                    return;

                case "itinerary":
                    // Gli eventi itinerario nascono silenziosi (vedi logItineraryEvent):
                    // le notifiche le manda func/itinerary.ts sui singoli casi che contano.
                    return;

                default:
                    await notifyTravel(travelId, {
                        ...common,
                        type: "post_new",
                        title: travel.name,
                        body:
                            param.type === "images"
                                ? `${who} ha condiviso delle foto`
                                : `${who}: ${String(param.content || "ha pubblicato qualcosa").slice(0, 120)}`,
                        target: travelTarget,
                    });
            }
        } catch (err) {
            console.log("Notifiche — nuovo post", err);
        }
    })();
}

/**
 * Avvisa il gruppo quando la spesa complessiva supera il budget del viaggio.
 * Notifica solo l'attraversamento della soglia, non ogni spesa successiva:
 * il groupKey per viaggio impedisce comunque il doppione ravvicinato.
 */
async function checkBudget(travel: TravelDocument, cache: Cache): Promise<void> {
    const budget = Number(travel.budget);
    if (!budget || isNaN(budget) || budget <= 0) return;

    const payments = await postsCollection()
        .find({ travel: travel._id, type: "payments" } as never)
        .toArray();

    // Totale di una spesa = quota pro capite × numero di quote.
    const total = payments.reduce((sum, post: any) => {
        const quota = Number(post.amount) || 0;
        const shares = Array.isArray(post.destinator) ? post.destinator.length : 0;
        return sum + quota * shares;
    }, 0);

    if (total <= budget) return;

    await notifyTravel(travel._id, {
        type: "budget_exceeded",
        actor: null,
        title: travel.name,
        body: `Il budget di € ${budget.toFixed(2)} è stato superato: spesi € ${total.toFixed(2)}`,
        target: { screen: "TravelDetail", params: { travelId: travel._id.toString() } },
        groupKey: "budget:" + travel._id.toString(),
        cache,
    });
}

export async function takePosts(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const travel = req.query.travel as string;
    const authUserId = req.auth?.userId;
    if (!authUserId || !(await isTravelParticipant(authUserId, travel))) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }
    const cachedData = cache.get<PostWithCreatorData[]>("travel-post=" + travel);
    if (cachedData) {
        res.send(cachedData).status(200)
        cache.set("travel-post=" + travel, cachedData, 600);
        next();
    }
    else {
        const travelObjectId = parseObjectId(travel);
        if (!travelObjectId) {
            // In pratica irraggiungibile (isTravelParticipant sopra avrebbe già
            // rifiutato un id malformato con 403), ma un `new ObjectId` diretto
            // dentro una funzione async, sfuggito a un guard più a monte,
            // diventerebbe comunque una unhandled rejection: vedi util/mongoIds.ts.
            res.status(400).send("Parametro travel non valido");
            next();
            return;
        }
        postsCollection().aggregate<PostWithCreatorData>([
            {
                $lookup:
                {
                    from: 'user',
                    localField: 'creator',
                    foreignField: '_id',
                    as: 'creatorData',
                },
            },
            {
                $sort: {
                    dateTime: -1
                }
            },
            {
                $project: CREATOR_DATA_PROJECTION
            },
            {
                $match:
                {
                    "travel": travelObjectId
                }
            }
        ])
            .toArray()
            .then((response) => {
                res.send(response).status(200);
                cache.set("travel-post=" + travel, response)
                next();
            })
            .catch((err) => {
                // Prima rilanciava dentro il .catch: un throw lì non ha più
                // nessuno che lo intercetta, quindi diventava un'altra
                // unhandled rejection invece di una risposta di errore pulita.
                res.status(500).send("Errore esecuzione query");
                next();
            });
    }
}

export async function updateVote(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { id, vote, travelid }: UpdateVoteBody = req.body;
    const authUserId = req.auth?.userId;
    if (!authUserId || !(await isTravelParticipant(authUserId, travelid))) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    const postId = parseObjectId(id);
    if (!postId) {
        res.status(400).send("Id non valido");
        next();
        return;
    }

    postsCollection().updateOne({ _id: postId }, { $set: { votes: vote, updatedAt: new Date() } }, function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.status(200).send(data);
            cache.del("travel-post=" + travelid);
            void invalidateUnseenCache(cache, travelid);
            // Nessun actorId: il body storico di updateVote non porta chi vota.
            // Non è un problema perché POST_UPDATED fa ricaricare il post, e
            // ricaricare è idempotente — chi ha votato rivede il proprio voto.
            // (POST_NEW invece l'actorId ce l'ha, perché lì un evento non
            // filtrato produrrebbe un post duplicato in lista.)
            emitToTravel(travelid, TRAVEL_EVENTS.POST_UPDATED, { postId: id, reason: "vote" });
        }
        next();
    });
}

export function takeLastsPostByUsername(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const userid = req.query.userid as string;
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    const userObjectId = parseObjectId(userid);
    if (!userObjectId) {
        res.status(400).send("Parametro userid non valido");
        next();
        return;
    }

    travelsCollection().find({ "participants.userid": userObjectId }).toArray(function (err, data) {
        if (err) {
            console.log("Errore esecuzione query");
            res.status(500).send("Errore esecuzione query");
            next();
        }
        else {
            const ausData: ObjectId[] = [];
            const ausName: string[] = [];
            for (const item of data) {
                ausData.push(item._id);
                ausName.push(item.name);
            }

            postsCollection().aggregate<PostWithCreatorData>([
                {
                    $lookup:
                    {
                        from: 'user',
                        localField: 'creator',
                        foreignField: '_id',
                        as: 'creatorData',
                    },
                },
                {
                    $match:
                    {
                        travel: { $in: ausData }
                    }
                },
                {
                    $sort: {
                        dateTime: -1
                    }
                },
                {
                    $limit: 10
                },
                {
                    $project: CREATOR_DATA_PROJECTION
                }
            ])
                .toArray()
                .then((response) => {
                    const otherData: Record<string, string> = {};
                    for (const item in ausData) {
                        otherData[ausData[item].toString()] = ausName[item];
                    }
                    res.status(200).send([response, otherData]);
                    next();
                })
                .catch((err) => {
                    console.log("Errore esecuzione query", err);
                    res.status(500).send("Errore esecuzione query");
                    next();
                });
        }
    });
}

// NOTA: PostDocument è una union discriminata su "type"; il driver mongo non riesce a
// tipizzare filtri/update che toccano solo campi di una variante (es. "destinator",
// "amount") senza restringere prima il tipo, perciò qui si usa "as any" con cognizione
// di causa invece di forzare un narrowing che il codice originale non faceva.

export function updatePayment(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { id, destinator, travelid }: UpdatePaymentBody = req.body;

    const postId = parseObjectId(id);
    if (!postId) {
        res.status(400).send("Id non valido");
        next();
        return;
    }

    // Il travel id serve per invalidare "travel-post=": i client storici non
    // sempre lo mandano, e senza si finiva a cancellare la chiave
    // "travel-post=undefined" lasciando il feed del viaggio con i dati vecchi.
    // Quando manca lo si rilegge dal post stesso.
    postsCollection().findOne({ _id: postId }, function (findErr, post) {
        if (findErr) {
            res.status(500).send("Errore esecuzione query");
            next();
            return;
        }

        // Solo il creatore del pagamento (il creditore) può modificare le
        // quote: è la stessa regola già applicata da settleUp in
        // func/money.ts, qui prima assente del tutto.
        if (!post || post.creator?.toString() !== req.auth?.userId) {
            res.status(403).send("Non autorizzato");
            next();
            return;
        }

        const travel = travelid || post?.travel?.toString();

        postsCollection().updateOne({ _id: postId }, { $set: { destinator, updatedAt: new Date() } } as any, function (err, data) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            } else {
                res.status(200).send(data);
                cache.del("travel-post=" + travel);
                invalidateMoneyCache(cache, travel);
                void invalidateUnseenCache(cache, travel);

                // Il feed mostra lo stato delle quote, e il riepilogo Money
                // di ogni partecipante cambia: due destinatari diversi,
                // perché chi ha la tab Money aperta non è nella stanza del
                // viaggio (vedi emitToTravelParticipants in realtime.ts).
                emitToTravel(travel, TRAVEL_EVENTS.POST_UPDATED, { postId: id, reason: "payment" });
                emitMoneyChanged(travel);

                // Solo il creditore può segnare una quota come saldata (vedi settleUp
                // in func/money.ts): chi passa da "deve" a "saldato" va avvisato,
                // altrimenti scopre di essere a posto solo riaprendo la schermata.
                notifySettled(post as any, destinator, travel, cache);
            }
            next();
        });
    });
}

/** Avvisa chi è passato da "in sospeso" a "saldato" su un pagamento. */
function notifySettled(
    post: { creator?: ObjectId; travel?: ObjectId; description?: string; amount?: number; destinator?: PostDestinator[] } | null,
    next: PostDestinator[],
    travelId: string | undefined,
    cache: Cache
): void {
    if (!post || !Array.isArray(next)) return;

    const before = new Map((post.destinator || []).map((d) => [d.userid, d.payed]));
    const settled = next
        .filter((d) => d.payed && before.get(d.userid) === false)
        .map((d) => d.userid);
    if (settled.length === 0) return;

    const quota = Number(post.amount) || 0;
    notify({
        type: "payment_settled",
        to: settled,
        actor: post.creator ?? null,
        travel: travelId ?? post.travel ?? null,
        title: "Debito saldato",
        body:
            `La tua quota${quota > 0 ? ` di € ${quota.toFixed(2)}` : ""}` +
            `${post.description ? ` per "${post.description}"` : ""} è stata segnata come saldata ✅`,
        target: { screen: "PaymentInfo", params: { postId: (post as any)._id?.toString() } },
        cache,
    });
}

export async function updatePinPost(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { param }: UpdatePinPostBody = req.body;
    const authUserId = req.auth?.userId;
    if (!authUserId || !(await isTravelParticipant(authUserId, param.travel))) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    const postId = parseObjectId(param._id);
    if (!postId) {
        // Qui siamo dopo un `await`: un `new ObjectId` diretto e non protetto
        // diventerebbe una unhandled rejection invece di questo 400 (vedi
        // util/mongoIds.ts).
        res.status(400).send("Id non valido");
        next();
        return;
    }

    postsCollection().updateOne({ _id: postId }, { $set: { "pinned": param.pinned } }, function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.status(200).send(data);
            cache.del("travel-post=" + param.travel);
            emitToTravel(param.travel, TRAVEL_EVENTS.POST_UPDATED, { postId: param._id, reason: "pin" });

            // Solo quando viene fissato: lo "sfissaggio" non interessa nessuno.
            if (param.pinned) {
                notifyTravel(param.travel, {
                    type: "post_pinned",
                    actor: null,
                    title: "Post fissato",
                    body: "Un post è stato fissato in cima al feed del viaggio",
                    entity: param._id,
                    target: { screen: "TravelDetail", params: { travelId: param.travel } },
                    cache,
                });
            }
        }
        next();
    });
}

export function deletePost(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { id, travel }: DeletePostBody = req.body;

    const postId = parseObjectId(id);
    if (!postId) {
        res.status(400).send("Id non valido");
        next();
        return;
    }

    postsCollection().findOne({ _id: postId }, function (err, post) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
            next();
        } else if (!post || post.creator?.toString() !== req.auth?.userId) {
            // Solo chi ha creato il post può cancellarlo.
            res.status(403).send("Non autorizzato");
            next();
        } else {
            if (post && post.type == "images") {
                for (const item of post.source) {
                    deleteStoredImage(item, POST_IMAGE_DIR);
                }
            }

            postsCollection().deleteOne({ _id: postId }, function (err, data) {
                if (err) {
                    res.status(500).send("Errore esecuzione query");
                } else {
                    res.status(200).send(data)
                    cache.del("travel-post=" + travel);
                    emitToTravel(travel, TRAVEL_EVENTS.POST_DELETED, { postId: id });
                    if (post?.type === "payments") {
                        invalidateMoneyCache(cache, travel);
                        emitMoneyChanged(travel);
                    }
                }
                next();
            });
        }
    });
}

/**
 * Somma delle quote a carico di un utente in una finestra temporale.
 *
 * @deprecated Usare takeMoneyOverview (func/money.ts). La versione precedente
 * non filtrava per data pur essendo mostrata in app come "spese ultimi 12
 * mesi": ora la finestra è esplicita e configurabile con ?months= (0 = tutto
 * lo storico, come si comportava prima).
 */
export function takeTotalExpenses(req: Request, res: Response) {
    const userid = req.query.userid as string;
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        return;
    }
    const months = req.query.months != null ? Number(req.query.months) : 12;

    const filter: Record<string, unknown> = { type: "payments", "destinator.userid": userid };
    if (!Number.isNaN(months) && months > 0) {
        const now = new Date();
        filter.dateTime = { $gte: new Date(now.getFullYear(), now.getMonth() - (months - 1), 1) };
    }

    postsCollection().find(filter as any).toArray(function (err, data) {
        if (err) {
            console.log("Errore esecuzione query");
            res.status(500).send("Errore esecuzione query");
        }
        else {
            let tot = 0;
            for (const item of data) {
                if (item.type === "payments") {
                    tot += item.amount;
                }
            }

            res.status(200).send(tot.toString());
        }
    });
}

export function takeTotalToPay(req: Request, res: Response) {
    const userid = req.query.userid as string;
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        return;
    }
    postsCollection().find({ destinator: { $elemMatch: { userid: userid, payed: false } } } as any).toArray(function (err, data) {
        if (err) {
            console.log("Errore esecuzione query");
            res.status(500).send("Errore esecuzione query");
        }
        else {
            let sum = 0;
            for (const item of data) {
                if (item.type === "payments") {
                    sum += item.amount;
                }
            }

            res.status(200).send(sum.toString());
        }
    });
}

/**
 * @deprecated Usare takeMoneyOverview (func/money.ts), che calcola questo
 * totale insieme a tutti gli altri con una sola lettura. Mantenuta per i
 * client vecchi.
 */
export function takeTotalToReceive(req: Request, res: Response) {
    const userid = req.query.userid as string;
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        return;
    }

    // "creator" è salvato come ObjectId (vedi createPost): confrontarlo con lo
    // username, come faceva la versione precedente, non restituiva mai nulla e
    // il totale "Da ricevere" risultava sempre 0.
    const creator = parseObjectId(userid);
    if (!creator) {
        res.status(400).send("Parametro userid non valido");
        return;
    }

    postsCollection().find({ creator, type: "payments" } as any).toArray(function (err, data) {
        if (err) {
            console.log("Errore esecuzione query");
            res.status(500).send("Errore esecuzione query");
        }
        else {
            let sum = 0;

            for (const item of data) {
                if (item.type !== "payments") continue;
                for (const i of item.destinator) {
                    if (i.payed === false && i.userid != userid) {
                        sum += item.amount;
                    }
                }
            }

            res.status(200).send(sum.toString());
        }
    });
}

/**
 * Quanto ha speso un utente in un singolo viaggio (somma delle sue quote):
 * alimenta la barra del budget in "Dettaglio viaggio".
 */
export function takeTotalPayedByTravel(req: Request, res: Response) {
    const travelId = req.query.travel as string;
    const userid = req.query.userid as string;
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        return;
    }

    // "travel" è salvato come ObjectId (vedi createPost): con la stringa il
    // filtro non corrispondeva a nessun documento e il budget mostrava sempre
    // "€ 0.00 speso".
    const travel = parseObjectId(travelId);
    if (!travel) {
        res.status(400).send("Parametro travel non valido");
        return;
    }

    postsCollection().find({ travel, "destinator.userid": userid, type: "payments" } as any).toArray(function (err, data) {
        if (err) {
            console.log("Errore esecuzione query");
            res.status(500).send("Errore esecuzione query");
        }
        else {
            let sum = 0;
            for (const item of data) {
                if (item.type === "payments") {
                    sum += item.amount;
                }
            }

            res.status(200).send(sum.toString());
        }
    });
}

export function takePayedGroupByTravel(req: Request, res: Response) {
    const userid = req.query.userid as string;
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        return;
    }

    postsCollection().aggregate<{ _id: ObjectId; total: number }>([
        { $match: { "destinator.userid": userid, type: "payments" } },
        { $unwind: "$destinator" },
        { $match: { "destinator.userid": userid, type: "payments" } },
        {
            $group: {
                _id: "$travel",
                total: { $sum: "$amount" }
            }
        }
    ]).toArray(function (err, data) {
        if (err) {
            console.log("Errore esecuzione query");
            res.status(500).send("Errore esecuzione query");
        }
        else {
            travelsCollection().find({ _id: { $in: data.map((item) => item._id) } }).project<{ _id: ObjectId; name: string }>({
                _id: true,
                name: true
            }).toArray(function (err, data2) {
                if (err) {
                    console.log("Errore esecuzione query");
                    res.status(500).send("Errore esecuzione query");
                }
                else {
                    const ausData: PayedGroupByTravel[] = [];
                    if (data2) {
                        for (const item of data2) {
                            const aus = data.filter((item2) => item2._id.toString() == item._id.toString())
                            ausData.push({ name: item.name, total: (JSON.stringify(aus) != '[]') ? aus[0].total : 0 });
                        }
                    }

                    res.status(200).send(ausData);
                }
            });
        }
    });
}

export async function addPostImage(req: Request, res: Response) {
    const { img, name: imgName }: AddPostImageBody = req.body;

    const imgData = img.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(imgData, "base64");

    // Whitelist sull'estensione + verifica dei magic bytes: vedi
    // util/imageValidation.ts sul perché servono entrambe.
    const validation = validateImageUpload(imgName, buffer);
    if (!validation.ok) {
        res.status(400).send(validation.reason);
        return;
    }

    const newName = Math.random().toString(36).substring(2, 20) + Math.random().toString(36).substring(2, 20) + Math.random().toString(36).substring(2, 20);
    const ext = imgName.split(".").pop()!.toLowerCase();

    try {
        const url = await uploadBuffer(POST_IMAGE_S3_PREFIX + newName + "." + ext, buffer, contentTypeFromExtension(ext));
        res.status(200).send(url);
    } catch (err: any) {
        console.log(err.message);
        res.status(500).send(err.message);
    }
}

export function updateToDo(req: Request, res: Response, cache: Cache) {
    const { id, items }: UpdateToDoBody = req.body;

    const postId = parseObjectId(id);
    if (!postId) {
        res.status(400).send("Id non valido");
        return;
    }

    // Il body non porta il travel id: va letto dal post stesso per poter
    // invalidare la cache "travel-post=" corretta (vedi takePosts).
    postsCollection().findOne({ _id: postId }, async function (findErr, post) {
        if (findErr) {
            res.status(500).send("Errore aggiornamento item");
            return;
        }

        const authUserId = req.auth?.userId;
        if (!post || !authUserId || !(await isTravelParticipant(authUserId, post.travel.toString()))) {
            res.status(403).send("Non autorizzato");
            return;
        }

        postsCollection().updateOne({ _id: postId }, { $set: { items, updatedAt: new Date() } } as any, function (err, data) {
            if (err) {
                res.status(500).send("Errore aggiornamento item");
            }
            else {
                res.status(200).send(data);
                if (post) {
                    cache.del("travel-post=" + post.travel);
                    void invalidateUnseenCache(cache, post.travel);
                    // La checkbox di una to-do è il caso in cui il realtime si
                    // nota di più: due persone che spuntano la stessa lista
                    // devono vederla convergere, non scoprire al refresh che
                    // l'altro aveva già fatto la spesa.
                    emitToTravel(post.travel, TRAVEL_EVENTS.POST_UPDATED, { postId: id, reason: "todo" });
                }
            }
        });
    });
}
