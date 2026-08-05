import { ObjectId } from "mongodb";

/* ============================================================
   Notifiche

   Il sistema ha due canali indipendenti per ogni evento:

   - "push"   → notifica di sistema sul telefono (Expo push);
   - "center" → riga persistita nella collection "notifications",
                mostrata nel centro notifiche dell'app.

   Non tutti gli eventi meritano entrambi: un nuovo post nel feed
   va bene come push (avvisa sul momento) ma riempirebbe di rumore
   il centro notifiche, che deve restare la lista delle cose ancora
   da guardare. Il catalogo qui sotto è l'unico posto dove questa
   scelta è dichiarata: chi invia una notifica non decide i canali,
   li legge da NOTIFICATION_CATALOG (vedi func/notifications.ts).
   ============================================================ */

export type NotificationCategory =
    | "social"
    | "travel"
    | "feed"
    | "money"
    | "itinerary"
    | "tickets";

export type NotificationType =
    // social
    | "follow_request"
    | "follow_accepted"
    // viaggio
    | "travel_joined"
    | "travel_left"
    | "travel_closed"
    | "travel_updated"
    | "travel_deleted"
    // feed
    | "post_new"
    | "post_pinned"
    | "vote_new"
    | "todo_assigned"
    // soldi
    | "payment_new"
    | "payment_reminder"
    | "payment_paid"
    | "payment_settled"
    | "budget_exceeded"
    // itinerario
    | "stop_assigned"
    | "day_shifted"
    | "itinerary_mode_changed"
    // biglietti
    | "ticket_shared";

/**
 * Dove portare l'utente al tap.
 *
 * `screen` è il nome della route lato client. Le route dell'app vivono in
 * due NavigationContainer diversi (vedi routes/NotificationStack.js e
 * App.tsx): `root: true` indica quelle del tab navigator radice, tutte le
 * altre stanno nello stack annidato sotto Home.
 */
export interface NotificationTarget {
    screen: string;
    params?: Record<string, unknown>;
    root?: boolean;
}

/** Documento della collection "notifications". */
export interface NotificationDocument {
    _id: ObjectId;
    /** Destinatario. Una notifica per destinatario: niente documenti condivisi. */
    user: ObjectId;
    type: NotificationType;
    category: NotificationCategory;
    title: string;
    body: string;
    /** Chi ha generato l'evento; null per le notifiche di sistema. */
    actor?: ObjectId | null;
    /** Denormalizzato: il centro notifiche non deve fare lookup per mostrare un nome. */
    actorName?: string | null;
    travel?: ObjectId | null;
    travelName?: string | null;
    /** Post / tappa / biglietto / follow a cui la notifica si riferisce. */
    entity?: ObjectId | null;
    target?: NotificationTarget | null;
    read: boolean;
    readAt?: Date | null;
    createdAt: Date;
    /**
     * Chiave di raggruppamento: due notifiche con lo stesso groupKey emesse
     * entro NOTIFICATION_MERGE_WINDOW_MS si fondono in una sola (stessa logica
     * degli eventi itinerario nel feed, vedi logItineraryEvent).
     */
    groupKey?: string | null;
}

/** Finestra entro cui due notifiche con lo stesso groupKey vengono unite. */
export const NOTIFICATION_MERGE_WINDOW_MS = 30 * 60 * 1000;

// ======================================================================
// Catalogo
// ======================================================================

export interface NotificationTypeSpec {
    category: NotificationCategory;
    /** Manda una push di sistema. */
    push: boolean;
    /** Persiste una riga nel centro notifiche. */
    center: boolean;
    /** Valore usato quando l'utente non ha ancora espresso una preferenza. */
    defaultEnabled: boolean;
    /**
     * false = l'utente non può spegnerla dalle preferenze.
     * Riservato alle notifiche che sono l'unico modo di scoprire una cosa
     * che richiede una sua azione (richiesta di follow, sollecito di pagamento).
     */
    configurable: boolean;
    /** Etichetta e descrizione mostrate nella schermata preferenze. */
    label: string;
    description: string;
}

export const NOTIFICATION_CATALOG: Record<NotificationType, NotificationTypeSpec> = {
    // ---------------------------------------------------------------- social
    follow_request: {
        category: "social",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: false,
        label: "Richieste di amicizia",
        description: "Quando qualcuno chiede di seguirti.",
    },
    follow_accepted: {
        category: "social",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Richieste accettate",
        description: "Quando qualcuno accetta la tua richiesta.",
    },

    // ---------------------------------------------------------------- viaggio
    travel_joined: {
        category: "travel",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Nuovi partecipanti",
        description: "Quando qualcuno entra in un viaggio a cui partecipi.",
    },
    travel_left: {
        // Chi esce non è urgente, ma serve saperlo per i conti: solo centro.
        category: "travel",
        push: false,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Partecipanti che escono",
        description: "Quando qualcuno lascia un viaggio a cui partecipi.",
    },
    travel_closed: {
        category: "travel",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Viaggio chiuso",
        description: "Quando un viaggio a cui partecipi viene chiuso.",
    },
    travel_updated: {
        category: "travel",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Modifiche al viaggio",
        description: "Quando cambiano date, destinazione o budget di un viaggio.",
    },
    travel_deleted: {
        category: "travel",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Viaggio eliminato",
        description: "Quando un viaggio a cui partecipi viene eliminato.",
    },

    // ---------------------------------------------------------------- feed
    post_new: {
        // Effimero per definizione: avvisa sul momento, poi il contenuto sta
        // già nel feed. Nel centro notifiche sarebbe solo rumore.
        category: "feed",
        push: true,
        center: false,
        defaultEnabled: true,
        configurable: true,
        label: "Nuovi post",
        description: "Quando qualcuno pubblica qualcosa in un tuo viaggio.",
    },
    post_pinned: {
        category: "feed",
        push: true,
        center: false,
        defaultEnabled: true,
        configurable: true,
        label: "Post fissati",
        description: "Quando un post viene fissato in cima al feed.",
    },
    vote_new: {
        // Richiede un'azione (votare) che non ha altro punto d'ingresso.
        category: "feed",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Nuovi sondaggi",
        description: "Quando viene aperto un sondaggio in un tuo viaggio.",
    },
    todo_assigned: {
        category: "feed",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Nuove liste di cose da fare",
        description: "Quando viene creata una to-do list in un tuo viaggio.",
    },

    // ---------------------------------------------------------------- soldi
    payment_new: {
        category: "money",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Nuove spese",
        description: "Quando ti viene addebitata una quota di una spesa.",
    },
    payment_reminder: {
        category: "money",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: false,
        label: "Solleciti di pagamento",
        description: "Quando qualcuno ti ricorda un pagamento in sospeso.",
    },
    payment_paid: {
        category: "money",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: false,
        label: "Pagamenti dichiarati",
        description: "Quando un debitore ti avvisa di aver pagato.",
    },
    payment_settled: {
        category: "money",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Debiti saldati",
        description: "Quando un tuo debito viene segnato come saldato.",
    },
    budget_exceeded: {
        category: "money",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Budget superato",
        description: "Quando la spesa di un viaggio supera il budget impostato.",
    },

    // ---------------------------------------------------------------- itinerario
    stop_assigned: {
        // Le altre modifiche all'itinerario finiscono già come evento nel feed
        // (vedi logItineraryEvent): notificare anche quelle sarebbe doppio.
        category: "itinerary",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Tappe programmate",
        description: "Quando un'idea diventa una tappa di un giorno preciso.",
    },
    day_shifted: {
        category: "itinerary",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Giornate spostate",
        description: "Quando un'intera giornata dell'itinerario viene spostata.",
    },
    itinerary_mode_changed: {
        category: "itinerary",
        push: false,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Permessi itinerario",
        description: "Quando cambiano i permessi di modifica dell'itinerario.",
    },

    // ---------------------------------------------------------------- biglietti
    ticket_shared: {
        category: "tickets",
        push: true,
        center: true,
        defaultEnabled: true,
        configurable: true,
        label: "Biglietti condivisi",
        description: "Quando qualcuno condivide un biglietto con te.",
    },
};

export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_CATALOG) as NotificationType[];

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
    social: "Social",
    travel: "Viaggi",
    feed: "Feed",
    money: "Soldi",
    itinerary: "Itinerario",
    tickets: "Biglietti",
};

// ======================================================================
// Preferenze utente (campo "notificationSettings" su UserDocument)
// ======================================================================

/**
 * Solo gli scostamenti dai default: un utente che non ha mai toccato le
 * preferenze non ha il campo, e vale defaultEnabled del catalogo.
 */
export interface UserNotificationSettings {
    /** type → abilitato. Le chiavi assenti seguono il default del catalogo. */
    types?: Partial<Record<NotificationType, boolean>>;
    /** Viaggi silenziati: nessuna notifica legata a questi travelId. */
    mutedTravels?: string[];
    /** Interruttore generale: false spegne tutte le push (il centro resta). */
    pushEnabled?: boolean;
}

/** Voce del catalogo esposta al client per costruire la schermata preferenze. */
export interface NotificationCatalogEntry {
    type: NotificationType;
    category: NotificationCategory;
    label: string;
    description: string;
    configurable: boolean;
    push: boolean;
    center: boolean;
}

/**
 * Preferenze risolte (default del catalogo + scelte dell'utente).
 *
 * Include il catalogo stesso: così la schermata preferenze si costruisce da
 * sola dai dati del server e non esiste un secondo elenco di etichette da
 * tenere allineato a mano lato client.
 */
export interface ResolvedNotificationPreferences {
    pushEnabled: boolean;
    mutedTravels: string[];
    types: Record<NotificationType, boolean>;
    catalog: NotificationCatalogEntry[];
    categories: { key: NotificationCategory; label: string }[];
}

// ======================================================================
// Request DTO
// ======================================================================

export interface TakeNotificationsQuery {
    userid: string;
    /** ISO date: restituisce le notifiche più vecchie di questa (paginazione a cursore). */
    before?: string;
    limit?: string;
    /** "1" per le sole non lette. */
    unreadOnly?: string;
}

export interface MarkNotificationsReadBody {
    userid: string;
    /** Se assente, segna come lette tutte le notifiche dell'utente. */
    ids?: string[];
}

export interface DeleteNotificationBody {
    userid: string;
    /** Se assente, svuota il centro notifiche dell'utente. */
    id?: string;
}

export interface UpdateNotificationPreferencesBody {
    userid: string;
    types?: Partial<Record<NotificationType, boolean>>;
    mutedTravels?: string[];
    pushEnabled?: boolean;
}

export interface RemoveUserNotifTokenBody {
    userid: string;
    notifToken: string;
}

// ======================================================================
// Response DTO
// ======================================================================

/** Notifica come arriva al client: ObjectId e Date già serializzati da JSON. */
export interface NotificationItem {
    _id: string;
    type: NotificationType;
    category: NotificationCategory;
    title: string;
    body: string;
    actor?: string | null;
    actorName?: string | null;
    travel?: string | null;
    travelName?: string | null;
    entity?: string | null;
    target?: NotificationTarget | null;
    read: boolean;
    createdAt: string;
}

export interface TakeNotificationsResponse {
    items: NotificationItem[];
    unreadCount: number;
    /** ISO date da passare come `before` per la pagina successiva; null se finite. */
    nextCursor: string | null;
}

export interface UnreadCountResponse {
    unreadCount: number;
    /** Richieste di follow ancora da accettare: il badge le somma alle non lette. */
    pendingFollowRequests: number;
}
