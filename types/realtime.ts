/**
 * Contratto degli eventi realtime (Socket.io).
 *
 * Questo file è la sorgente di verità dei nomi degli eventi e delle stanze:
 * il gemello lato app è `components/realtime/events.ts`, che va tenuto
 * allineato a mano (i due progetti sono repo separate, non c'è un package
 * condiviso). Un nome scritto a mano in un handler è il modo più semplice
 * per rompere il realtime senza che niente fallisca, quindi si usano solo
 * le costanti qui sotto.
 *
 * SCELTA DI FONDO — eventi "granulari" vs "di invalidazione".
 * Il feed dei post riceve il post intero, perché inserirlo in testa alla
 * lista senza un giro sul server è il caso d'uso più frequente e più
 * visibile. Itinerario, Money e ticket ricevono invece solo un segnale di
 * "qualcosa è cambiato": sono dati condivisi che il server può ricalcolare
 * o rifiutare (l'itinerario ha permessi e conflitti, Money è un'aggregazione
 * su tutti i viaggi), e applicare localmente una patch parziale porterebbe
 * i dispositivi a divergere. Meglio un roundtrip in più che due utenti che
 * vedono due itinerari diversi.
 */

// ======================================================================
// Stanze
// ======================================================================

/** Stanza di un viaggio: ci entra solo chi risulta partecipante su db. */
export function travelRoom(travelId: string): string {
    return "travel=" + travelId;
}

/** Stanza personale: notifiche, badge e riepilogo Money del singolo utente. */
export function userRoom(userId: string): string {
    return "user=" + userId;
}

// ======================================================================
// Nomi degli eventi
// ======================================================================

/** Eventi emessi dal server verso le stanze dei viaggi. */
export const TRAVEL_EVENTS = {
    /** Nuovo post nel feed. Payload: TravelPostNewPayload. */
    POST_NEW: "travel:post:new",
    /** Un post esistente è cambiato (voto, quota pagata, pin, to-do). */
    POST_UPDATED: "travel:post:updated",
    /** Un post è stato eliminato. */
    POST_DELETED: "travel:post:deleted",
    /** L'itinerario del viaggio è cambiato: il client ricarica. */
    ITINERARY_CHANGED: "travel:itinerary:changed",
    /** Dati del viaggio (nome, date, budget, copertina, chiusura) cambiati. */
    TRAVEL_UPDATED: "travel:updated",
    /** Qualcuno è entrato o uscito dal viaggio. */
    PARTICIPANTS_CHANGED: "travel:participants:changed",
} as const;

/** Eventi emessi dal server verso la stanza personale di un utente. */
export const USER_EVENTS = {
    /** Nuova notifica nel centro notifiche (già esistente prima del realtime). */
    NOTIFICATION: "notification",
    /** Il riepilogo Money dell'utente non è più valido. */
    MONEY_CHANGED: "user:money:changed",
    /** I ticket dell'utente sono cambiati (condivisione, eliminazione). */
    TICKETS_CHANGED: "user:tickets:changed",
    /** L'elenco viaggi dell'utente è cambiato (creato, eliminato, uscito). */
    TRAVELS_CHANGED: "user:travels:changed",
} as const;

/** Eventi che il client può emettere verso il server. */
export const CLIENT_EVENTS = {
    JOIN_TRAVEL: "travel:join",
    LEAVE_TRAVEL: "travel:leave",
} as const;

export type TravelEvent = (typeof TRAVEL_EVENTS)[keyof typeof TRAVEL_EVENTS];
export type UserEvent = (typeof USER_EVENTS)[keyof typeof USER_EVENTS];

// ======================================================================
// Payload
// ======================================================================

/**
 * Ogni payload porta `travelId` anche se l'evento arriva su una stanza già
 * specifica: un client iscritto a più viaggi (feed home) riceve gli eventi
 * di tutte le stanze sullo stesso callback e deve poterli smistare.
 *
 * `actorId` è chi ha fatto l'azione: il client lo usa per ignorare gli
 * eventi che ha generato lui stesso, altrimenti chi scrive vede il proprio
 * post arrivare due volte (una dalla risposta REST, una dal socket).
 */
export interface RealtimeBasePayload {
    travelId: string;
    actorId?: string;
}

export interface TravelPostNewPayload extends RealtimeBasePayload {
    /** Post già "popolato" come lo restituisce takePosts, pronto per il feed. */
    post: unknown;
}

export interface TravelPostUpdatedPayload extends RealtimeBasePayload {
    /**
     * Post cambiato. `null` quando la mutazione ne ha toccati molti in una
     * volta (es. il saldo di tutti i debiti verso una persona): in quel caso
     * il client ricarica l'intero feed invece di cercare la riga da aggiornare.
     */
    postId: string | null;
    /** Cosa è cambiato: serve al client per decidere se basta una patch locale. */
    reason: "vote" | "payment" | "pin" | "todo" | "other";
}

export interface TravelPostDeletedPayload extends RealtimeBasePayload {
    postId: string;
}

export interface TravelItineraryChangedPayload extends RealtimeBasePayload {
    /** Azione applicata, utile per log e per messaggi tipo "Marco ha aggiunto una tappa". */
    action: string;
    stopId?: string;
    day?: number | null;
}

export interface UserMoneyChangedPayload {
    /** Viaggio che ha originato la variazione, quando applicabile. */
    travelId?: string;
    actorId?: string;
}
