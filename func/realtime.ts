import { ObjectId } from "mongodb";
import { DB_NAME, mongoConnection, getIo } from "../server";
import { TravelDocument } from "../types/travel";
import { travelRoom, userRoom, TRAVEL_EVENTS, USER_EVENTS } from "../types/realtime";

/**
 * Punto unico di uscita degli eventi realtime.
 *
 * Gli handler in func/* non toccano mai `getIo()` direttamente: chiamano
 * queste funzioni. Il motivo è lo stesso per cui esiste `notify()` per le
 * push — prima il realtime era "a rilancio dal client" (chi scriveva un
 * post doveva ricordarsi di emettere l'evento agli altri), quindi bastava
 * un client vecchio, un crash o una scrittura fatta da un'altra strada
 * perché gli altri dispositivi non vedessero nulla. Ora l'evento parte da
 * dove il dato viene scritto davvero, ed è impossibile scrivere senza
 * emettere per dimenticanza del client.
 *
 * REGOLA: emettere DOPO che la scrittura su Mongo è riuscita, e mai
 * `await`are queste funzioni dentro un handler. Il realtime è un extra:
 * se il socket non c'è, i client hanno comunque cache, pull-to-refresh e
 * ricarica al focus. Un errore qui non deve mai far fallire una request,
 * quindi ogni emit è racchiuso in un try/catch silenzioso.
 */

function travelsCollection() {
    return mongoConnection.db(DB_NAME).collection<TravelDocument>("travels");
}

// ======================================================================
// Emissione
// ======================================================================

function safeEmit(room: string, event: string, payload: unknown): void {
    try {
        getIo()?.to(room).emit(event, payload);
    } catch {
        /* vedi nota in testa al file: il realtime non può rompere la request */
    }
}

/** Manda un evento a tutti i dispositivi collegati alla stanza di un viaggio. */
export function emitToTravel(
    travelId: ObjectId | string | undefined | null,
    event: string,
    payload: Record<string, unknown> = {}
): void {
    if (!travelId) return;
    const id = travelId.toString();
    safeEmit(travelRoom(id), event, { ...payload, travelId: id });
}

/** Manda un evento alla stanza personale di un utente. */
export function emitToUser(
    userId: ObjectId | string | undefined | null,
    event: string,
    payload: unknown = {}
): void {
    if (!userId) return;
    safeEmit(userRoom(userId.toString()), event, payload);
}

/**
 * Manda un evento alla stanza personale di **ogni** partecipante del viaggio.
 *
 * Serve ai dati che non vivono nella schermata del viaggio ma che un
 * pagamento fatto lì invalida comunque: il riepilogo Money è per utente e
 * aggrega tutti i suoi viaggi, quindi chi ha la tab Money aperta su un
 * altro schermo non sarebbe raggiunto dalla stanza `travel=`.
 */
export function emitToTravelParticipants(
    travelId: ObjectId | string | undefined | null,
    event: string,
    payload: Record<string, unknown> = {}
): void {
    if (!travelId) return;

    let id: ObjectId;
    try {
        id = new ObjectId(travelId);
    } catch {
        return;
    }

    travelsCollection()
        .findOne({ _id: id }, { projection: { participants: 1 } })
        .then((travel) => {
            if (!travel) return;
            for (const participant of travel.participants ?? []) {
                emitToUser(participant.userid, event, { ...payload, travelId: id.toString() });
            }
        })
        .catch(() => {
            /* best effort */
        });
}

/**
 * Scorciatoia per la casistica più comune dopo una mutazione su un
 * pagamento: il feed del viaggio va aggiornato e il riepilogo Money di
 * tutti i partecipanti non è più valido.
 */
export function emitMoneyChanged(
    travelId: ObjectId | string | undefined | null,
    actorId?: string
): void {
    emitToTravelParticipants(travelId, USER_EVENTS.MONEY_CHANGED, { actorId });
}

/** Scorciatoia per le mutazioni dell'itinerario. */
export function emitItineraryChanged(
    travelId: ObjectId | string | undefined | null,
    action: string,
    extra: { actorId?: string; stopId?: string; day?: number | null } = {}
): void {
    emitToTravel(travelId, TRAVEL_EVENTS.ITINERARY_CHANGED, { action, ...extra });
}

// ======================================================================
// Appartenenza ai viaggi (usata dall'handshake del socket)
// ======================================================================

/**
 * Id dei viaggi di cui l'utente è partecipante.
 *
 * Il risultato è memorizzato per pochi secondi perché la home apre in
 * blocco le stanze di tutti i viaggi dell'utente: senza cache sarebbe una
 * query per viaggio a ogni ingresso in schermata. La finestra è volutamente
 * corta — l'unico effetto di un dato stantio è che chi è appena stato
 * aggiunto a un viaggio debba riprovare il join entro pochi secondi, e
 * `invalidateMembership` copre comunque i casi di uscita/rimozione, che
 * sono quelli in cui una cache troppo lunga sarebbe un problema di
 * sicurezza e non solo di comodità.
 */
const MEMBERSHIP_TTL_MS = 15_000;
const membershipCache = new Map<string, { ids: Set<string>; expiresAt: number }>();

export function invalidateMembership(userId: ObjectId | string | undefined | null): void {
    if (!userId) return;
    membershipCache.delete(userId.toString());
}

/** Svuota la cache di appartenenza di tutti i partecipanti di un viaggio. */
export function invalidateTravelMembership(travelId: ObjectId | string | undefined | null): void {
    if (!travelId) return;
    let id: ObjectId;
    try {
        id = new ObjectId(travelId);
    } catch {
        return;
    }
    travelsCollection()
        .findOne({ _id: id }, { projection: { participants: 1 } })
        .then((travel) => {
            for (const participant of travel?.participants ?? []) {
                invalidateMembership(participant.userid);
            }
        })
        .catch(() => {
            /* best effort */
        });
}

async function travelIdsOf(userId: string): Promise<Set<string>> {
    const cached = membershipCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.ids;

    let objectId: ObjectId;
    try {
        objectId = new ObjectId(userId);
    } catch {
        return new Set();
    }

    const travels = await travelsCollection()
        .find({ participants: { $elemMatch: { userid: objectId } } }, { projection: { _id: 1 } })
        .toArray();

    const ids = new Set(travels.map((travel) => travel._id.toString()));
    membershipCache.set(userId, { ids, expiresAt: Date.now() + MEMBERSHIP_TTL_MS });
    return ids;
}

/**
 * Vero se l'utente partecipa al viaggio. È il controllo che decide se un
 * socket può entrare nella stanza `travel=<id>`: senza, chiunque conosca
 * (o indovini) un ObjectId potrebbe restare in ascolto del feed, dei
 * pagamenti e dell'itinerario di un viaggio altrui.
 */
export async function isTravelParticipant(userId: string, travelId: string): Promise<boolean> {
    if (!userId || !travelId) return false;
    try {
        const ids = await travelIdsOf(userId);
        if (ids.has(travelId)) return true;

        // Miss possibile su una cache appena riempita (utente aggiunto al
        // viaggio un istante fa): si ricontrolla una volta sul db prima di
        // dire di no, così l'invito non sembra "non funzionare".
        membershipCache.delete(userId);
        const fresh = await travelIdsOf(userId);
        return fresh.has(travelId);
    } catch {
        return false;
    }
}
