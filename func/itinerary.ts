import axios from "axios";
import { ObjectId } from "mongodb";
import { Request, Response } from "express";
import { DB_NAME, mongoConnection } from "../server";
import { Cache } from "../types/common";
import { ItineraryAction } from "../types/post";
import { TravelDocument } from "../types/travel";
import {
    AssignStopBody,
    CreateStopBody,
    DEFAULT_PERMISSION_MODE,
    DeleteStopBody,
    DuplicateItineraryBody,
    ItineraryRecap,
    RecapDayPhotos,
    ShiftDayBody,
    ITINERARY_PERMISSION_MODES,
    ItineraryDay,
    ItineraryDocument,
    ItineraryPermissionMode,
    ItineraryResponse,
    PlaceSearchResult,
    ReorderStopsBody,
    STOP_CATEGORIES,
    STOP_STATUSES,
    StopCategory,
    StopDocument,
    StopInput,
    StopStatus,
    UpdateChecklistBody,
    UpdateItineraryModeBody,
    UpdateStopBody,
    UpdateStopStatusBody,
    VoteStopBody,
} from "../types/itinerary";
import { notifyTravel } from "./notifications";
import { emitItineraryChanged, emitToTravel } from "./realtime";
import { TRAVEL_EVENTS } from "../types/realtime";

/** Etichette leggibili delle modalità di permesso, per il testo delle notifiche. */
const ITINERARY_MODE_LABELS: Record<string, string> = {
    open: "tutti possono modificare",
    proposal: "le modifiche vanno approvate",
    admin: "solo chi ha creato il viaggio",
};

/* ============================================================
   Itinerario del viaggio
   Idee (day = null) e tappe (day = indice giorno) vivono nella
   stessa collection "stops"; spostare un'idea in un giorno è solo
   una scrittura del campo "day".
   ============================================================ */

const ITINERARIES_COLLECTION = "itineraries";
const STOPS_COLLECTION = "stops";
const TRAVELS_COLLECTION = "travels";
const GENERIC_ERROR = "Errore esecuzione query";

/** Passo tra due tappe consecutive: lascia spazio agli inserimenti in mezzo. */
const ORDER_STEP = 1000;

const PLACE_CACHE_TTL = 60 * 60 * 24; // i luoghi non si spostano
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
/* Nominatim richiede uno User-Agent identificabile: senza, blocca le richieste.
   È anche il motivo per cui la ricerca passa dal server invece che dall'app. */
const NOMINATIM_UA = "TravellerApp/1.0 (https://traveller-ttze.onrender.com)";

function itinerariesCollection() {
    return mongoConnection.db(DB_NAME).collection<ItineraryDocument>(ITINERARIES_COLLECTION);
}

function stopsCollection() {
    return mongoConnection.db(DB_NAME).collection<StopDocument>(STOPS_COLLECTION);
}

function travelsCollection() {
    return mongoConnection.db(DB_NAME).collection<TravelDocument>(TRAVELS_COLLECTION);
}

function sendServerError(res: Response, message: string = GENERIC_ERROR) {
    res.status(500).send(message);
}

// =====================================================================================
// Eventi nel feed
// =====================================================================================

const POSTS_COLLECTION = "posts";
/**
 * Due modifiche alla stessa tappa entro questa finestra diventano un solo
 * post: sistemare titolo, orario e costo uno dopo l'altro non deve
 * riempire il feed di tre righe uguali.
 */
const EVENT_MERGE_WINDOW_MS = 30 * 60 * 1000;

function postsCollection() {
    return mongoConnection.db(DB_NAME).collection(POSTS_COLLECTION);
}

/**
 * Registra nel feed del viaggio un evento dell'itinerario.
 * I post nascono silenziosi (nessuna push): riordinare una giornata
 * non deve far suonare il telefono di tutto il gruppo.
 * Non fallisce mai la richiesta chiamante: se il feed non si aggiorna,
 * la modifica all'itinerario resta comunque valida.
 */
async function logItineraryEvent(
    ctx: ItineraryContext,
    action: ItineraryAction,
    params: { stopId?: ObjectId | null; title: string; day?: number | null; detail: string },
    cache?: Cache
): Promise<void> {
    try {
        const now = new Date();
        const posts = postsCollection();

        const recent = params.stopId
            ? await posts.findOne({
                  type: "itinerary",
                  travel: ctx.travel._id,
                  creator: ctx.userId,
                  stop: params.stopId,
                  action,
                  dateTime: { $gte: new Date(now.getTime() - EVENT_MERGE_WINDOW_MS) },
              } as never)
            : null;

        if (recent) {
            await posts.updateOne(
                { _id: (recent as any)._id },
                {
                    $set: {
                        dateTime: now,
                        detail: params.detail,
                        stopTitle: params.title,
                        day: params.day ?? null,
                    },
                }
            );
        } else {
            await posts.insertOne({
                type: "itinerary",
                pinned: false,
                creator: ctx.userId,
                travel: ctx.travel._id,
                dateTime: now,
                action,
                stop: params.stopId ?? null,
                stopTitle: params.title,
                day: params.day ?? null,
                detail: params.detail,
            } as never);
        }

        // Il feed è in cache senza scadenza (vedi takePosts): senza questa
        // invalidazione l'evento comparirebbe solo al riavvio del server.
        cache?.del("travel-post=" + ctx.travel._id.toString());

        // Realtime. Questo è il punto giusto da cui emettere perché è il
        // collo di bottiglia di *tutte* le mutazioni dell'itinerario che
        // producono un evento: agganciarsi qui significa che una nuova
        // operazione aggiunta domani sarà realtime senza doverselo ricordare.
        // Due eventi distinti perché sono due schermate diverse: chi ha
        // aperto l'itinerario ricarica il piano, chi ha aperto il feed
        // ricarica i post. Solo quella montata reagisce.
        emitItineraryChanged(ctx.travel._id, action, {
            actorId: ctx.userId?.toString(),
            stopId: params.stopId?.toString(),
            day: params.day ?? null,
        });
        emitToTravel(ctx.travel._id, TRAVEL_EVENTS.POST_UPDATED, {
            postId: null,
            reason: "other",
            actorId: ctx.userId?.toString(),
        });
    } catch (err) {
        console.log("Itinerario — evento nel feed non registrato", err);
    }
}

/** "Giorno 3", oppure "le idee" per le tappe senza giorno. */
function dayLabel(day: number | null | undefined): string {
    return day === null || day === undefined ? "le idee" : `Giorno ${day + 1}`;
}

/** Descrive in una riga cosa è cambiato tra due versioni della tappa. */
function describeChanges(before: StopDocument, after: Partial<StopDocument>): string {
    const changes: string[] = [];

    if (after.title !== undefined && after.title !== before.title) changes.push("titolo");
    if (after.place !== undefined && (after.place?.name ?? null) !== (before.place?.name ?? null)) {
        changes.push(after.place?.name ? `luogo (${after.place.name})` : "luogo rimosso");
    }
    if (after.startTime !== undefined && after.startTime !== before.startTime) {
        changes.push(after.startTime ? `orario (${after.startTime})` : "orario tolto");
    }
    if (after.duration !== undefined && after.duration !== before.duration) changes.push("durata");
    if (after.cost !== undefined && after.cost !== before.cost) {
        changes.push(after.cost ? `costo (${after.cost}€)` : "costo tolto");
    }
    if (after.category !== undefined && after.category !== before.category) changes.push("categoria");
    if (after.notes !== undefined && after.notes !== before.notes) changes.push("note");
    if (after.participants !== undefined) changes.push("partecipanti");
    if (after.ticket !== undefined) changes.push("biglietto");
    if (after.paymentPost !== undefined) changes.push("spesa collegata");

    if (changes.length === 0) return "Modifica alla tappa";
    return `Aggiornato: ${changes.join(", ")}`;
}

function toObjectId(value?: string | null): ObjectId | null {
    if (!value) return null;
    try {
        return new ObjectId(value);
    } catch {
        return null;
    }
}

// =====================================================================================
// Contesto e permessi
// =====================================================================================

interface ItineraryContext {
    travel: TravelDocument;
    itinerary: ItineraryDocument;
    mode: ItineraryPermissionMode;
    isAdmin: boolean;
    isParticipant: boolean;
    userId: ObjectId;
}

/** Il documento itinerario viene creato al primo accesso, così il client non deve inizializzarlo. */
async function ensureItinerary(travelId: ObjectId): Promise<ItineraryDocument> {
    const existing = await itinerariesCollection().findOne({ travel: travelId });
    if (existing) return existing;

    const now = new Date();
    const doc = {
        travel: travelId,
        mode: DEFAULT_PERMISSION_MODE,
        creation_date: now,
        update_date: now,
    } as ItineraryDocument;

    const result = await itinerariesCollection().insertOne(doc);
    return { ...doc, _id: result.insertedId };
}

/** Carica viaggio + itinerario e calcola il ruolo dell'utente. Null se i dati non esistono. */
async function loadContext(travelIdRaw: string, useridRaw: string): Promise<ItineraryContext | null> {
    const travelId = toObjectId(travelIdRaw);
    const userId = toObjectId(useridRaw);
    if (!travelId || !userId) return null;

    const travel = await travelsCollection().findOne({ _id: travelId });
    if (!travel) return null;

    const participant = travel.participants?.find((p) => p.userid?.toString() === userId.toString());
    const itinerary = await ensureItinerary(travelId);

    return {
        travel,
        itinerary,
        mode: itinerary.mode || DEFAULT_PERMISSION_MODE,
        isAdmin: Boolean(participant?.creator),
        isParticipant: Boolean(participant),
        userId,
    };
}

/**
 * Chi può cambiare la struttura del piano (assegnare giorni, riordinare,
 * confermare): in "open" tutti i partecipanti, altrimenti solo l'admin.
 */
function canManagePlan(ctx: ItineraryContext): boolean {
    if (!ctx.isParticipant) return false;
    return ctx.mode === "open" || ctx.isAdmin;
}

/** Chi può aggiungere qualcosa: in tutte le modalità i partecipanti possono almeno proporre idee. */
function canContribute(ctx: ItineraryContext): boolean {
    return ctx.isParticipant;
}

/** Stato iniziale di una tappa appena creata, in base a modalità e ruolo. */
function initialStatus(ctx: ItineraryContext, day: number | null): StopStatus {
    if (day === null || day === undefined) return "idea";
    if (ctx.mode === "proposal" && !ctx.isAdmin) return "proposed";
    return "confirmed";
}

function forbidden(res: Response, message: string) {
    res.status(403).send(message);
}

// =====================================================================================
// Giorni della timeline
// =====================================================================================

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function toIsoDay(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Giorni della timeline: derivano dalle date del viaggio.
 * Se il viaggio non ha date si restituisce comunque un giorno per ogni
 * indice già usato dalle tappe, così un piano esistente non sparisce
 * quando le date vengono tolte o accorciate.
 */
function buildDays(travel: TravelDocument, stops: StopDocument[]): ItineraryDay[] {
    const start = travel.startDate ? new Date(travel.startDate) : null;
    const end = travel.endDate ? new Date(travel.endDate) : null;

    let count = 0;
    if (start && end && !isNaN(start.getTime()) && !isNaN(end.getTime())) {
        const diff = startOfDay(end).getTime() - startOfDay(start).getTime();
        count = Math.max(1, Math.floor(diff / 86400000) + 1);
    }

    const maxUsedDay = stops.reduce(
        (max, stop) => (stop.day != null && stop.day + 1 > max ? stop.day + 1 : max),
        0
    );
    count = Math.max(count, maxUsedDay);

    const days: ItineraryDay[] = [];
    for (let i = 0; i < count; i++) {
        let date: string | null = null;
        if (start && !isNaN(start.getTime())) {
            const current = startOfDay(start);
            current.setDate(current.getDate() + i);
            date = toIsoDay(current);
        }
        days.push({ index: i, date, label: `G${i + 1}` });
    }

    return days;
}

// =====================================================================================
// Normalizzazione input
// =====================================================================================

function normalizeCategory(value: unknown): StopCategory {
    return STOP_CATEGORIES.includes(value as StopCategory) ? (value as StopCategory) : "visit";
}

/** Accetta solo "HH:mm"; qualsiasi altro valore diventa "in giornata" (null). */
function normalizeTime(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return match ? value : null;
}

function normalizeNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return isNaN(parsed) ? null : parsed;
}

function normalizeDay(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    if (isNaN(parsed) || parsed < 0) return null;
    return Math.floor(parsed);
}

function normalizePlace(value: StopInput["place"]): StopDocument["place"] {
    if (!value || typeof value !== "object") return null;
    const name = String(value.name || "").trim();
    const address = String(value.address || "").trim();
    if (!name && !address) return null;

    return {
        name: name || address,
        address,
        lat: normalizeNumber(value.lat),
        lon: normalizeNumber(value.lon),
        ...(value.osmId ? { osmId: String(value.osmId) } : {}),
    };
}

function normalizeChecklist(value: StopInput["checklist"]): StopDocument["checklist"] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item) => item && String(item.label || "").trim().length > 0)
        .map((item, index) => ({
            key: normalizeNumber(item.key) ?? index,
            label: String(item.label).trim(),
            checked: Boolean(item.checked),
        }));
}

function normalizeParticipants(value: StopInput["participants"]): ObjectId[] {
    if (!Array.isArray(value)) return [];
    return value.map((id) => toObjectId(String(id))).filter((id): id is ObjectId => id !== null);
}

/** Ordine da assegnare in coda a un giorno (o al backlog). */
async function nextOrder(travelId: ObjectId, day: number | null): Promise<number> {
    const last = await stopsCollection()
        .find({ travel: travelId, day })
        .sort({ order: -1 })
        .limit(1)
        .toArray();

    return last.length > 0 ? (last[0].order || 0) + ORDER_STEP : ORDER_STEP;
}

// =====================================================================================
// Lettura
// =====================================================================================

/** Itinerario completo di un viaggio: permessi, giorni, idee e tappe. */
export async function takeItinerary(req: Request, res: Response) {
    const travel = req.query.travel as string;
    const userid = req.query.userid as string;

    try {
        const ctx = await loadContext(travel, userid);
        if (!ctx) {
            res.status(404).send("Viaggio non trovato");
            return;
        }

        const all = await stopsCollection()
            .find({ travel: ctx.travel._id })
            .sort({ day: 1, order: 1 })
            .toArray();

        const ideas = all.filter((stop) => stop.day === null || stop.day === undefined);
        const stops = all.filter((stop) => stop.day !== null && stop.day !== undefined);

        const plannedCost = stops
            .filter((stop) => stop.status !== "skipped")
            .reduce((sum, stop) => sum + (stop.cost || 0), 0);

        const payload: ItineraryResponse = {
            travel: ctx.travel._id.toString(),
            mode: ctx.mode,
            isAdmin: ctx.isAdmin,
            canEdit: canManagePlan(ctx),
            startDate: ctx.travel.startDate ? new Date(ctx.travel.startDate).toISOString() : null,
            endDate: ctx.travel.endDate ? new Date(ctx.travel.endDate).toISOString() : null,
            days: buildDays(ctx.travel, all),
            ideas,
            stops,
            plannedCost,
            participantsCount: ctx.travel.participants?.length || 0,
        };

        res.status(200).send(payload);
    } catch (err) {
        sendServerError(res);
    }
}

// =====================================================================================
// Impostazioni
// =====================================================================================

/** Cambia la modalità di collaborazione: solo il creatore del viaggio. */
export async function updateItineraryMode(req: Request, res: Response) {
    const { travel, userid, mode }: UpdateItineraryModeBody = req.body;

    if (!ITINERARY_PERMISSION_MODES.includes(mode)) {
        res.status(400).send("Modalità non valida");
        return;
    }

    try {
        const ctx = await loadContext(travel, userid);
        if (!ctx) {
            res.status(404).send("Viaggio non trovato");
            return;
        }
        if (!ctx.isAdmin) {
            forbidden(res, "Solo chi ha creato il viaggio può cambiare i permessi");
            return;
        }

        await itinerariesCollection().updateOne(
            { _id: ctx.itinerary._id },
            { $set: { mode, update_date: new Date() } }
        );

        // Le proposte in sospeso restano tali: è l'admin a chiuderle una per una
        // (comportamento annunciato nella schermata Permessi).
        res.status(200).send({ mode });

        // Non passa da logItineraryEvent (cambiare i permessi non è un evento
        // del feed), quindi l'emit va fatto a mano: senza, gli altri
        // continuerebbero a vedere i pulsanti di modifica finché non riaprono
        // la schermata, e le loro azioni verrebbero poi rifiutate dal server.
        emitItineraryChanged(ctx.travel._id, "mode", { actorId: ctx.userId?.toString() });

        // Cambia cosa il gruppo può fare sull'itinerario: va nel centro
        // notifiche, ma senza push (non è urgente).
        notifyTravel(ctx.travel._id, {
            type: "itinerary_mode_changed",
            actor: userid,
            title: ctx.travel.name,
            body: `{actor} ha cambiato i permessi dell'itinerario: ${ITINERARY_MODE_LABELS[mode] ?? mode}`,
            target: { screen: "Itinerary", params: { travelId: ctx.travel._id.toString() } },
        });
    } catch (err) {
        sendServerError(res);
    }
}

// =====================================================================================
// CRUD tappe
// =====================================================================================

/** Crea un'idea (day assente) o una tappa in un giorno. */
export async function createStop(req: Request, res: Response, cache?: Cache) {
    const { travel, userid, param }: CreateStopBody = req.body;

    if (!param || !String(param.title || "").trim()) {
        res.status(400).send("Il titolo è obbligatorio");
        return;
    }

    try {
        const ctx = await loadContext(travel, userid);
        if (!ctx) {
            res.status(404).send("Viaggio non trovato");
            return;
        }
        if (!canContribute(ctx)) {
            forbidden(res, "Non fai parte di questo viaggio");
            return;
        }

        const day = normalizeDay(param.day);
        if (day !== null && !canManagePlan(ctx) && ctx.mode === "admin") {
            forbidden(res, "Solo l'admin può aggiungere tappe: la tua resta tra le idee");
            return;
        }

        const now = new Date();
        const stop = {
            travel: ctx.travel._id,
            creator: ctx.userId,
            title: String(param.title).trim(),
            category: normalizeCategory(param.category),
            status: initialStatus(ctx, day),
            day,
            startTime: normalizeTime(param.startTime),
            duration: normalizeNumber(param.duration),
            order: await nextOrder(ctx.travel._id, day),
            place: normalizePlace(param.place),
            notes: String(param.notes || "").trim(),
            cost: normalizeNumber(param.cost),
            paymentPost: toObjectId(param.paymentPost),
            ticket: toObjectId(param.ticket),
            checklist: normalizeChecklist(param.checklist),
            participants: normalizeParticipants(param.participants),
            votes: [],
            creation_date: now,
            update_date: now,
        } as Omit<StopDocument, "_id">;

        const result = await stopsCollection().insertOne(stop as StopDocument);

        await logItineraryEvent(
            ctx,
            stop.status === "proposed" ? "proposed" : "added",
            {
                stopId: result.insertedId,
                title: stop.title,
                day: stop.day,
                detail:
                    stop.status === "proposed"
                        ? `Proposta per il ${dayLabel(stop.day)}${stop.startTime ? ` · ${stop.startTime}` : ""} — da votare`
                        : stop.day === null
                          ? "Aggiunta tra le idee del viaggio"
                          : `Aggiunta al ${dayLabel(stop.day)}${stop.startTime ? ` · ${stop.startTime}` : ""}`,
            },
            cache
        );

        res.status(200).send({ ...stop, _id: result.insertedId });
    } catch (err) {
        sendServerError(res);
    }
}

/** Modifica i campi di una tappa. Solo l'autore o chi può gestire il piano. */
export async function updateStop(req: Request, res: Response, cache?: Cache) {
    const { id, userid, param }: UpdateStopBody = req.body;

    const stopId = toObjectId(id);
    if (!stopId || !param) {
        res.status(400).send("Dati non validi");
        return;
    }

    try {
        const stop = await stopsCollection().findOne({ _id: stopId });
        if (!stop) {
            res.status(404).send("Tappa non trovata");
            return;
        }

        const ctx = await loadContext(stop.travel.toString(), userid);
        if (!ctx) {
            res.status(404).send("Viaggio non trovato");
            return;
        }

        const isAuthor = stop.creator?.toString() === ctx.userId.toString();
        if (!canManagePlan(ctx) && !isAuthor) {
            forbidden(res, "Non puoi modificare questa tappa");
            return;
        }

        const fields: Record<string, unknown> = { update_date: new Date() };
        if (param.title !== undefined) fields.title = String(param.title).trim();
        if (param.category !== undefined) fields.category = normalizeCategory(param.category);
        if (param.startTime !== undefined) fields.startTime = normalizeTime(param.startTime);
        if (param.duration !== undefined) fields.duration = normalizeNumber(param.duration);
        if (param.place !== undefined) fields.place = normalizePlace(param.place);
        if (param.notes !== undefined) fields.notes = String(param.notes || "").trim();
        if (param.cost !== undefined) fields.cost = normalizeNumber(param.cost);
        if (param.ticket !== undefined) fields.ticket = toObjectId(param.ticket);
        if (param.paymentPost !== undefined) fields.paymentPost = toObjectId(param.paymentPost);
        if (param.checklist !== undefined) fields.checklist = normalizeChecklist(param.checklist);
        if (param.participants !== undefined) {
            fields.participants = normalizeParticipants(param.participants);
        }

        // Il giorno si cambia da qui solo se chi scrive può gestire il piano;
        // altrimenti si usa /assign, che applica le regole di modalità.
        if (param.day !== undefined && canManagePlan(ctx)) {
            const day = normalizeDay(param.day);
            fields.day = day;
            if (day !== stop.day) {
                fields.order = await nextOrder(ctx.travel._id, day);
                if (day === null) fields.status = "idea";
                else if (stop.status === "idea") fields.status = initialStatus(ctx, day);
            }
        }

        // Cast necessario: "fields" è costruito a chiavi opzionali, il tipo
        // UpdateFilter di mongo pretende invece le chiavi tipizzate del documento.
        await stopsCollection().updateOne({ _id: stopId }, { $set: fields } as never);
        const updated = await stopsCollection().findOne({ _id: stopId });

        // Un cambio di giorno è uno spostamento, non una modifica qualsiasi:
        // per il gruppo è l'informazione che conta.
        const dayChanged = fields.day !== undefined && fields.day !== stop.day;
        await logItineraryEvent(
            ctx,
            dayChanged ? "moved" : "updated",
            {
                stopId,
                title: updated?.title ?? stop.title,
                day: (fields.day as number | null | undefined) ?? stop.day,
                detail: dayChanged
                    ? `Spostata da ${dayLabel(stop.day)} a ${dayLabel(fields.day as number | null)}`
                    : describeChanges(stop, fields as Partial<StopDocument>),
            },
            cache
        );

        res.status(200).send(updated);
    } catch (err) {
        sendServerError(res);
    }
}

/** Elimina una tappa. Solo l'autore o chi può gestire il piano. */
export async function deleteStop(req: Request, res: Response, cache?: Cache) {
    const { id, userid }: DeleteStopBody = req.body;

    const stopId = toObjectId(id);
    if (!stopId) {
        res.status(400).send("Dati non validi");
        return;
    }

    try {
        const stop = await stopsCollection().findOne({ _id: stopId });
        if (!stop) {
            res.status(404).send("Tappa non trovata");
            return;
        }

        const ctx = await loadContext(stop.travel.toString(), userid);
        if (!ctx) {
            res.status(404).send("Viaggio non trovato");
            return;
        }

        const isAuthor = stop.creator?.toString() === ctx.userId.toString();
        if (!canManagePlan(ctx) && !isAuthor) {
            forbidden(res, "Non puoi eliminare questa tappa");
            return;
        }

        const result = await stopsCollection().deleteOne({ _id: stopId });

        // La tappa non esiste più: l'evento resta senza riferimento, così la
        // card nel feed non prova ad aprire un dettaglio inesistente.
        await logItineraryEvent(
            ctx,
            "removed",
            {
                stopId: null,
                title: stop.title,
                day: stop.day,
                detail: `Rimossa da ${dayLabel(stop.day)}`,
            },
            cache
        );

        res.status(200).send(result);
    } catch (err) {
        sendServerError(res);
    }
}

/**
 * Sposta una tappa tra backlog e giorni (e tra giorni).
 * day null riporta la tappa tra le idee senza eliminarla.
 */
export async function assignStop(req: Request, res: Response, cache?: Cache) {
    const { id, userid, day, startTime, index }: AssignStopBody = req.body;

    const stopId = toObjectId(id);
    if (!stopId) {
        res.status(400).send("Dati non validi");
        return;
    }

    try {
        const stop = await stopsCollection().findOne({ _id: stopId });
        if (!stop) {
            res.status(404).send("Tappa non trovata");
            return;
        }

        const ctx = await loadContext(stop.travel.toString(), userid);
        if (!ctx) {
            res.status(404).send("Viaggio non trovato");
            return;
        }
        if (!canManagePlan(ctx)) {
            forbidden(res, "Con questa modalità non puoi spostare le tappe");
            return;
        }

        const targetDay = normalizeDay(day);
        const fields: Record<string, unknown> = {
            day: targetDay,
            update_date: new Date(),
        };

        if (startTime !== undefined) fields.startTime = normalizeTime(startTime);
        if (targetDay === null) fields.status = "idea";
        else if (stop.status === "idea" || stop.status === "proposed") {
            fields.status = initialStatus(ctx, targetDay);
        }

        // Posizione: se non indicata va in fondo al giorno, altrimenti si
        // calcola l'ordine come punto medio tra le due tappe adiacenti.
        if (index === undefined || index === null) {
            fields.order = await nextOrder(ctx.travel._id, targetDay);
        } else {
            const siblings = await stopsCollection()
                .find({ travel: ctx.travel._id, day: targetDay, _id: { $ne: stopId } })
                .sort({ order: 1 })
                .toArray();

            const before = siblings[index - 1];
            const after = siblings[index];
            if (!before && !after) fields.order = ORDER_STEP;
            else if (!before) fields.order = (after.order || ORDER_STEP) - ORDER_STEP / 2;
            else if (!after) fields.order = (before.order || 0) + ORDER_STEP;
            else fields.order = ((before.order || 0) + (after.order || 0)) / 2;
        }

        // Cast necessario: "fields" è costruito a chiavi opzionali, il tipo
        // UpdateFilter di mongo pretende invece le chiavi tipizzate del documento.
        await stopsCollection().updateOne({ _id: stopId }, { $set: fields } as never);
        const updated = await stopsCollection().findOne({ _id: stopId });

        const cameFromBacklog = stop.day === null && targetDay !== null;
        await logItineraryEvent(
            ctx,
            cameFromBacklog ? "added" : "moved",
            {
                stopId,
                title: stop.title,
                day: targetDay,
                detail: cameFromBacklog
                    ? `Dalle idee al ${dayLabel(targetDay)}${updated?.startTime ? ` · ${updated.startTime}` : ""}`
                    : targetDay === null
                      ? `Rimessa tra le idee da ${dayLabel(stop.day)}`
                      : `Spostata da ${dayLabel(stop.day)} a ${dayLabel(targetDay)}`,
            },
            cache
        );

        res.status(200).send(updated);

        // Solo il passaggio "idea → giorno preciso" merita una notifica: le
        // altre modifiche all'itinerario sono già visibili come evento nel feed
        // (logItineraryEvent) e notificarle tutte sarebbe un doppione.
        if (cameFromBacklog) {
            notifyTravel(ctx.travel._id, {
                type: "stop_assigned",
                actor: userid,
                title: ctx.travel.name,
                body: `{actor} ha programmato "${stop.title}" per ${dayLabel(targetDay)}`,
                entity: stopId,
                target: {
                    screen: "ItineraryStopDetail",
                    params: { stopId: stopId.toString(), travelId: ctx.travel._id.toString() },
                },
                cache,
            });
        }
    } catch (err) {
        sendServerError(res);
    }
}

/** Riscrive l'ordine di tutte le tappe di un giorno (usato dallo spostamento manuale). */
export async function reorderStops(req: Request, res: Response) {
    const { travel, userid, day, order }: ReorderStopsBody = req.body;

    if (!Array.isArray(order)) {
        res.status(400).send("Ordine non valido");
        return;
    }

    try {
        const ctx = await loadContext(travel, userid);
        if (!ctx) {
            res.status(404).send("Viaggio non trovato");
            return;
        }
        if (!canManagePlan(ctx)) {
            forbidden(res, "Con questa modalità non puoi riordinare le tappe");
            return;
        }

        const targetDay = normalizeDay(day);
        const operations = order
            .map((stopId, position) => {
                const objectId = toObjectId(stopId);
                if (!objectId) return null;
                return {
                    updateOne: {
                        filter: { _id: objectId, travel: ctx.travel._id },
                        update: {
                            $set: {
                                day: targetDay,
                                order: (position + 1) * ORDER_STEP,
                                update_date: new Date(),
                            },
                        },
                    },
                };
            })
            .filter((op): op is NonNullable<typeof op> => op !== null);

        if (operations.length === 0) {
            res.status(200).send({ modified: 0 });
            return;
        }

        const result = await stopsCollection().bulkWrite(operations as never);
        res.status(200).send({ modified: result.modifiedCount });

        // Il riordino non scrive un evento nel feed (sarebbe rumore a ogni
        // trascinamento), ma cambia l'ordine che tutti vedono: senza emit,
        // due persone che riordinano lo stesso giorno si sovrascrivono a
        // vicenda senza accorgersene.
        emitItineraryChanged(ctx.travel._id, "reorder", {
            actorId: ctx.userId?.toString(),
            day: targetDay,
        });
    } catch (err) {
        sendServerError(res);
    }
}

/**
 * Aggiorna lo stato di una tappa.
 * "done" e "skipped" registrano un fatto avvenuto in viaggio, quindi sono
 * permessi a tutti i partecipanti; confermare o rimettere in proposta
 * cambia il piano e segue le regole di modalità.
 */
export async function updateStopStatus(req: Request, res: Response, cache?: Cache) {
    const { id, userid, status }: UpdateStopStatusBody = req.body;

    const stopId = toObjectId(id);
    if (!stopId || !STOP_STATUSES.includes(status)) {
        res.status(400).send("Dati non validi");
        return;
    }

    try {
        const stop = await stopsCollection().findOne({ _id: stopId });
        if (!stop) {
            res.status(404).send("Tappa non trovata");
            return;
        }

        const ctx = await loadContext(stop.travel.toString(), userid);
        if (!ctx) {
            res.status(404).send("Viaggio non trovato");
            return;
        }

        const isOutcome = status === "done" || status === "skipped";
        const allowed = isOutcome ? ctx.isParticipant : canManagePlan(ctx);
        if (!allowed) {
            forbidden(res, "Non puoi cambiare lo stato di questa tappa");
            return;
        }

        await stopsCollection().updateOne(
            { _id: stopId },
            { $set: { status, update_date: new Date() } }
        );
        const updated = await stopsCollection().findOne({ _id: stopId });

        // Confermare una proposta è una modifica del piano; check-in e
        // "saltata" sono il diario di bordo della giornata.
        const eventAction: ItineraryAction =
            status === "done" ? "done" : status === "skipped" ? "skipped" : "updated";

        await logItineraryEvent(
            ctx,
            eventAction,
            {
                stopId,
                title: stop.title,
                day: stop.day,
                detail:
                    status === "done"
                        ? "Check-in fatto"
                        : status === "skipped"
                          ? `Saltata (${dayLabel(stop.day)})`
                          : status === "confirmed"
                            ? `Confermata nel ${dayLabel(stop.day)}`
                            : "Rimessa in votazione",
            },
            cache
        );

        res.status(200).send(updated);
    } catch (err) {
        sendServerError(res);
    }
}

/** Vota (o ritira il voto su) una proposta. Solo in modalità "proposal". */
export async function voteStop(req: Request, res: Response) {
    const { id, userid }: VoteStopBody = req.body;

    const stopId = toObjectId(id);
    if (!stopId) {
        res.status(400).send("Dati non validi");
        return;
    }

    try {
        const stop = await stopsCollection().findOne({ _id: stopId });
        if (!stop) {
            res.status(404).send("Tappa non trovata");
            return;
        }

        const ctx = await loadContext(stop.travel.toString(), userid);
        if (!ctx || !ctx.isParticipant) {
            forbidden(res, "Non fai parte di questo viaggio");
            return;
        }

        const already = (stop.votes || []).some((v) => v.toString() === ctx.userId.toString());
        const update = already
            ? { $pull: { votes: ctx.userId }, $set: { update_date: new Date() } }
            : { $addToSet: { votes: ctx.userId }, $set: { update_date: new Date() } };

        await stopsCollection().updateOne({ _id: stopId }, update as never);
        const updated = await stopsCollection().findOne({ _id: stopId });
        res.status(200).send(updated);

        // I voti servono proprio a decidere in gruppo: vederli salire in
        // diretta è metà del senso della funzione.
        emitItineraryChanged(stop.travel, "vote", {
            actorId: ctx.userId?.toString(),
            stopId: stopId.toString(),
            day: stop.day ?? null,
        });
    } catch (err) {
        sendServerError(res);
    }
}

/** Spunta/despunta le voci della checklist di una tappa: aperto a tutti i partecipanti. */
export async function updateStopChecklist(req: Request, res: Response) {
    const { id, userid, checklist }: UpdateChecklistBody = req.body;

    const stopId = toObjectId(id);
    if (!stopId) {
        res.status(400).send("Dati non validi");
        return;
    }

    try {
        const stop = await stopsCollection().findOne({ _id: stopId });
        if (!stop) {
            res.status(404).send("Tappa non trovata");
            return;
        }

        const ctx = await loadContext(stop.travel.toString(), userid);
        if (!ctx || !ctx.isParticipant) {
            forbidden(res, "Non fai parte di questo viaggio");
            return;
        }

        await stopsCollection().updateOne(
            { _id: stopId },
            { $set: { checklist: normalizeChecklist(checklist), update_date: new Date() } }
        );
        const updated = await stopsCollection().findOne({ _id: stopId });
        res.status(200).send(updated);

        emitItineraryChanged(stop.travel, "checklist", {
            actorId: ctx.userId?.toString(),
            stopId: stopId.toString(),
            day: stop.day ?? null,
        });
    } catch (err) {
        sendServerError(res);
    }
}

/**
 * "Siamo in ritardo": sposta avanti gli orari delle tappe di un giorno.
 * Tocca solo le tappe con orario (quelle "in giornata" non hanno niente da
 * slittare) e solo da una certa tappa in poi, così quelle già fatte restano
 * con l'orario reale.
 */
export async function shiftDay(req: Request, res: Response, cache?: Cache) {
    const { travel, userid, day, minutes, fromStop }: ShiftDayBody = req.body;

    const targetDay = normalizeDay(day);
    const delta = Number(minutes);
    if (targetDay === null || isNaN(delta) || delta === 0) {
        res.status(400).send("Dati non validi");
        return;
    }

    try {
        const ctx = await loadContext(travel, userid);
        if (!ctx) {
            res.status(404).send("Viaggio non trovato");
            return;
        }
        if (!canManagePlan(ctx)) {
            forbidden(res, "Con questa modalità non puoi spostare gli orari");
            return;
        }

        const stops = await stopsCollection()
            .find({ travel: ctx.travel._id, day: targetDay })
            .sort({ order: 1 })
            .toArray();

        const withTime = stops
            .filter((stop) => stop.startTime && stop.status !== "done" && stop.status !== "skipped")
            .sort((a, b) => (minutesToNumber(a.startTime) ?? 0) - (minutesToNumber(b.startTime) ?? 0));

        const fromId = toObjectId(fromStop);
        const startIndex = fromId
            ? withTime.findIndex((stop) => stop._id.toString() === fromId.toString())
            : 0;
        const affected = withTime.slice(startIndex < 0 ? 0 : startIndex);

        const operations = affected
            .map((stop) => {
                const current = minutesToNumber(stop.startTime);
                if (current === null) return null;
                // Oltre la mezzanotte l'orario si ferma a 23:59: spostare una
                // tappa al giorno dopo è una decisione, non un effetto collaterale.
                const shifted = Math.min(current + delta, 23 * 60 + 59);
                return {
                    updateOne: {
                        filter: { _id: stop._id },
                        update: {
                            $set: { startTime: numberToTime(shifted), update_date: new Date() },
                        },
                    },
                };
            })
            .filter((op): op is NonNullable<typeof op> => op !== null);

        if (operations.length === 0) {
            res.status(200).send({ modified: 0 });
            return;
        }

        const result = await stopsCollection().bulkWrite(operations as never);

        await logItineraryEvent(
            ctx,
            "moved",
            {
                stopId: null,
                title: dayLabel(targetDay),
                day: targetDay,
                detail: `Ritardo: ${operations.length} ${
                    operations.length === 1 ? "tappa spostata" : "tappe spostate"
                } di ${delta} min`,
            },
            cache
        );

        res.status(200).send({ modified: result.modifiedCount });

        // Uno slittamento in corso di giornata è l'unica modifica all'itinerario
        // che il gruppo deve sapere subito: chi è per strada deve rifare i conti.
        notifyTravel(ctx.travel._id, {
            type: "day_shifted",
            actor: userid,
            title: ctx.travel.name,
            body: `{actor} ha spostato ${dayLabel(targetDay)} di ${delta} minuti`,
            target: { screen: "Itinerary", params: { travelId: ctx.travel._id.toString(), day: targetDay } },
            groupKey: `day_shifted:${ctx.travel._id.toString()}:${targetDay}`,
            cache,
        });
    } catch (err) {
        sendServerError(res);
    }
}

/** "HH:mm" → minuti dalla mezzanotte. */
function minutesToNumber(time?: string | null): number | null {
    if (!time) return null;
    const [hours, minutes] = time.split(":").map(Number);
    if (isNaN(hours) || isNaN(minutes)) return null;
    return hours * 60 + minutes;
}

function numberToTime(total: number): string {
    const normalized = ((Math.round(total) % 1440) + 1440) % 1440;
    return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

// =====================================================================================
// Resoconto di fine viaggio
// =====================================================================================

/**
 * Riepilogo del viaggio: tappe fatte e saltate, previsto contro speso,
 * luoghi visitati e foto pubblicate giorno per giorno.
 */
export async function takeRecap(req: Request, res: Response) {
    const travel = req.query.travel as string;
    const userid = req.query.userid as string;

    try {
        const ctx = await loadContext(travel, userid);
        if (!ctx) {
            res.status(404).send("Viaggio non trovato");
            return;
        }
        if (!ctx.isParticipant) {
            forbidden(res, "Non fai parte di questo viaggio");
            return;
        }

        const stops = await stopsCollection()
            .find({ travel: ctx.travel._id, day: { $ne: null } })
            .sort({ day: 1, order: 1 })
            .toArray();

        const posts = mongoConnection.db(DB_NAME).collection("posts");
        // I post storici hanno "travel" a volte come ObjectId e a volte come
        // stringa (vedi le note in func/travels.ts): si cercano entrambi.
        const travelFilter = {
            $or: [{ travel: ctx.travel._id }, { travel: ctx.travel._id.toString() }],
        };

        const payments = await posts.find({ ...travelFilter, type: "payments" } as never).toArray();
        const spent = payments.reduce((sum, post: any) => sum + (Number(post.amount) || 0), 0);

        const imagePosts = await posts.find({ ...travelFilter, type: "images" } as never).toArray();

        const days = buildDays(ctx.travel, stops);
        const start = ctx.travel.startDate ? startOfDay(new Date(ctx.travel.startDate)) : null;

        const photosByDay: RecapDayPhotos[] = days.map((day) => {
            const matching = start
                ? imagePosts.filter((post: any) => {
                      const posted = post.dateTime ? new Date(post.dateTime) : null;
                      if (!posted) return false;
                      const diff = Math.floor(
                          (startOfDay(posted).getTime() - start.getTime()) / 86400000
                      );
                      return diff === day.index;
                  })
                : [];

            const files = matching.flatMap((post: any) =>
                Array.isArray(post.source) ? post.source : []
            );

            return {
                day: day.index,
                label: `Giorno ${day.index + 1}`,
                count: files.length,
                preview: files.slice(0, 3),
            };
        });

        const recap: ItineraryRecap = {
            travel: ctx.travel._id.toString(),
            name: ctx.travel.name,
            startDate: ctx.travel.startDate ? new Date(ctx.travel.startDate).toISOString() : null,
            endDate: ctx.travel.endDate ? new Date(ctx.travel.endDate).toISOString() : null,
            doneCount: stops.filter((stop) => stop.status === "done").length,
            skippedCount: stops.filter((stop) => stop.status === "skipped").length,
            totalStops: stops.length,
            plannedCost: stops
                .filter((stop) => stop.status !== "skipped")
                .reduce((sum, stop) => sum + (stop.cost || 0), 0),
            spent,
            places: stops
                .filter((stop) => stop.place?.lat != null && stop.place?.lon != null)
                .map((stop) => ({
                    title: stop.title,
                    lat: stop.place!.lat as number,
                    lon: stop.place!.lon as number,
                    status: stop.status,
                })),
            photosByDay,
        };

        res.status(200).send(recap);
    } catch (err) {
        sendServerError(res);
    }
}

/**
 * "Usa come modello": copia le tappe di un viaggio in un altro.
 * Si portano dietro struttura, luoghi e costi previsti; non si portano
 * dietro voti, biglietti, spese collegate e stato — quelli appartengono
 * al viaggio in cui sono successi.
 */
export async function duplicateItinerary(req: Request, res: Response, cache?: Cache) {
    const { sourceTravel, targetTravel, userid }: DuplicateItineraryBody = req.body;

    try {
        const source = await loadContext(sourceTravel, userid);
        const target = await loadContext(targetTravel, userid);

        if (!source || !target) {
            res.status(404).send("Viaggio non trovato");
            return;
        }
        if (!source.isParticipant || !target.isParticipant) {
            forbidden(res, "Non fai parte di uno dei due viaggi");
            return;
        }
        if (!canManagePlan(target)) {
            forbidden(res, "Con la modalità del viaggio di destinazione non puoi aggiungere tappe");
            return;
        }
        if (source.travel._id.toString() === target.travel._id.toString()) {
            res.status(400).send("Scegli un viaggio diverso");
            return;
        }

        const stops = await stopsCollection()
            .find({ travel: source.travel._id })
            .sort({ day: 1, order: 1 })
            .toArray();

        if (stops.length === 0) {
            res.status(200).send({ copied: 0 });
            return;
        }

        const targetDays = buildDays(target.travel, []).length;
        const now = new Date();

        const copies = stops.map((stop) => ({
            travel: target.travel._id,
            creator: target.userId,
            title: stop.title,
            category: stop.category,
            // Le tappe che non entrano nella durata del nuovo viaggio
            // atterrano tra le idee invece di sparire.
            status: stop.day !== null && stop.day < targetDays ? "confirmed" : "idea",
            day: stop.day !== null && stop.day < targetDays ? stop.day : null,
            startTime: stop.startTime,
            duration: stop.duration,
            order: stop.order,
            place: stop.place,
            notes: stop.notes,
            cost: stop.cost,
            paymentPost: null,
            ticket: null,
            checklist: (stop.checklist || []).map((item) => ({ ...item, checked: false })),
            participants: [],
            votes: [],
            creation_date: now,
            update_date: now,
        }));

        const result = await stopsCollection().insertMany(copies as never);

        // L'evento va nel feed del viaggio di destinazione: è lì che il
        // gruppo si ritrova l'itinerario nuovo.
        await logItineraryEvent(
            target,
            "added",
            {
                stopId: null,
                title: source.travel.name,
                day: null,
                detail: `${result.insertedCount} tappe copiate da "${source.travel.name}"`,
            },
            cache
        );

        res.status(200).send({ copied: result.insertedCount });
    } catch (err) {
        sendServerError(res);
    }
}

// =====================================================================================
// Ricerca luoghi (proxy Nominatim)
// =====================================================================================

/**
 * Ricerca luoghi su OpenStreetMap.
 * Passa dal server per tre motivi: Nominatim vuole uno User-Agent
 * identificabile, impone un limite di 1 richiesta/secondo, e così i
 * risultati si possono mettere in cache per tutti gli utenti.
 */
export async function searchPlace(req: Request, res: Response, cache: Cache) {
    const query = String(req.query.q || "").trim();
    if (query.length < 3) {
        res.status(200).send([]);
        return;
    }

    const cacheKey = "place=" + query.toLowerCase();
    const cached = cache.get<PlaceSearchResult[]>(cacheKey);
    if (cached) {
        res.status(200).send(cached);
        return;
    }

    try {
        const { data } = await axios.get<any[]>(NOMINATIM_URL, {
            params: {
                q: query,
                format: "jsonv2",
                limit: 8,
                addressdetails: 1,
                "accept-language": "it",
            },
            headers: { "User-Agent": NOMINATIM_UA },
            timeout: 8000,
        });

        const results: PlaceSearchResult[] = (data || []).map((item) => {
            const displayName: string = item.display_name || "";
            // display_name è "Nome, Via, Città, …": la prima parte è il nome del luogo.
            const [first, ...rest] = displayName.split(",");
            return {
                name: (item.name || first || "").trim(),
                address: rest.length > 0 ? rest.join(",").trim() : displayName,
                lat: Number(item.lat),
                lon: Number(item.lon),
                osmId: `${item.osm_type || ""}/${item.osm_id || ""}`,
            };
        });

        cache.set(cacheKey, results, PLACE_CACHE_TTL);
        res.status(200).send(results);
    } catch (err) {
        // Nominatim può rispondere 429 o andare in timeout: per il client è
        // una lista vuota, non un errore bloccante del salvataggio tappa.
        res.status(200).send([]);
    }
}
