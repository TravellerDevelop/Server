import { ObjectId } from "mongodb";

/* ============================================================
   Itinerario di viaggio
   Due collection:
   - "itineraries": un documento per viaggio, tiene le impostazioni
     (modalità di collaborazione) e nient'altro.
   - "stops": idee (day = null) e tappe (day = indice del giorno).
     Tenerle separate dai post evita di inquinare il feed e permette
     query per giorno senza aggregazioni sul documento viaggio.
   ============================================================ */

/** Come il gruppo lavora sul piano: lo decide il creatore del viaggio. */
export type ItineraryPermissionMode = "open" | "proposal" | "admin";

export const ITINERARY_PERMISSION_MODES: ItineraryPermissionMode[] = ["open", "proposal", "admin"];
export const DEFAULT_PERMISSION_MODE: ItineraryPermissionMode = "open";

/** Documento della collection "itineraries" (uno per viaggio). */
export interface ItineraryDocument {
    _id: ObjectId;
    travel: ObjectId;
    mode: ItineraryPermissionMode;
    creation_date: Date;
    update_date: Date;
}

/** Categorie tappa: guidano icona e colore lato client. */
export type StopCategory =
    | "visit"
    | "food"
    | "transfer"
    | "stay"
    | "event"
    | "activity"
    | "free";

export const STOP_CATEGORIES: StopCategory[] = [
    "visit",
    "food",
    "transfer",
    "stay",
    "event",
    "activity",
    "free",
];

/**
 * Stato della tappa.
 * - "idea": proposta nel backlog, non ancora assegnata a un giorno
 * - "proposed": in votazione (solo in modalità "proposal")
 * - "confirmed": confermata nel piano
 * - "done" / "skipped": esito registrato durante il viaggio
 */
export type StopStatus = "idea" | "proposed" | "confirmed" | "done" | "skipped";

export const STOP_STATUSES: StopStatus[] = ["idea", "proposed", "confirmed", "done", "skipped"];

export interface StopPlace {
    /** Nome breve mostrato in UI (es. "Colosseo"). */
    name: string;
    /** Indirizzo completo restituito dal geocoder. */
    address: string;
    lat: number | null;
    lon: number | null;
    /** Identificativo Nominatim, utile per deduplicare i luoghi. */
    osmId?: string;
}

export interface StopChecklistItem {
    key: number;
    label: string;
    checked: boolean;
}

/** Documento della collection "stops". */
export interface StopDocument {
    _id: ObjectId;
    travel: ObjectId;
    creator: ObjectId;
    title: string;
    category: StopCategory;
    status: StopStatus;
    /** null = idea nel backlog; 0..n = indice del giorno rispetto a startDate del viaggio. */
    day: number | null;
    /** "HH:mm" oppure null per le tappe "in giornata". */
    startTime: string | null;
    /** Durata stimata in minuti; null se non indicata. */
    duration: number | null;
    /** Posizione dentro il giorno (o dentro il backlog): passo di 1000 per inserimenti. */
    order: number;
    place: StopPlace | null;
    notes: string;
    /** Costo previsto in euro. */
    cost: number | null;
    /** Post di tipo "payments" collegato (creato dal modulo Money). */
    paymentPost: ObjectId | null;
    /** Biglietto collegato (collection "tickets"). */
    ticket: ObjectId | null;
    checklist: StopChecklistItem[];
    /** Partecipanti alla tappa: il gruppo può splittarsi. */
    participants: ObjectId[];
    /** Userid di chi ha votato la proposta (modalità "proposal"). */
    votes: ObjectId[];
    creation_date: Date;
    update_date: Date;
}

// ======================================================================
// Request DTO
// ======================================================================

/** Campi che il client può scrivere su una tappa. */
export interface StopInput {
    title: string;
    category: StopCategory;
    day?: number | null;
    startTime?: string | null;
    duration?: number | null;
    place?: StopPlace | null;
    notes?: string;
    cost?: number | null;
    ticket?: string | null;
    paymentPost?: string | null;
    checklist?: StopChecklistItem[];
    participants?: string[];
}

export interface CreateStopBody {
    travel: string;
    userid: string;
    param: StopInput;
}

export interface UpdateStopBody {
    id: string;
    userid: string;
    param: Partial<StopInput>;
}

export interface DeleteStopBody {
    id: string;
    userid: string;
}

/** Sposta una tappa: da idea a giorno, da giorno a idea, o tra due giorni. */
export interface AssignStopBody {
    id: string;
    userid: string;
    /** null riporta la tappa nel backlog delle idee. */
    day: number | null;
    startTime?: string | null;
    /** Posizione desiderata dentro il giorno (0 = prima). Se assente va in fondo. */
    index?: number;
}

export interface ReorderStopsBody {
    travel: string;
    userid: string;
    day: number | null;
    /** Id delle tappe nell'ordine desiderato. */
    order: string[];
}

export interface UpdateStopStatusBody {
    id: string;
    userid: string;
    status: StopStatus;
}

export interface VoteStopBody {
    id: string;
    userid: string;
}

export interface UpdateChecklistBody {
    id: string;
    userid: string;
    checklist: StopChecklistItem[];
}

export interface UpdateItineraryModeBody {
    travel: string;
    userid: string;
    mode: ItineraryPermissionMode;
}

/**
 * "Siamo in ritardo": sposta avanti di N minuti gli orari delle tappe
 * di un giorno a partire da una tappa (inclusa).
 */
export interface ShiftDayBody {
    travel: string;
    userid: string;
    day: number;
    minutes: number;
    /** Se assente, slitta tutte le tappe con orario del giorno. */
    fromStop?: string | null;
}

/** "Usa come modello": copia le tappe di un viaggio concluso in un altro viaggio. */
export interface DuplicateItineraryBody {
    sourceTravel: string;
    targetTravel: string;
    userid: string;
}

// ======================================================================
// Response DTO
// ======================================================================

/** Un giorno della timeline, calcolato a partire dalle date del viaggio. */
export interface ItineraryDay {
    /** Indice 0-based rispetto a startDate. */
    index: number;
    /** "YYYY-MM-DD", assente se il viaggio non ha date. */
    date: string | null;
    label: string;
}

/** Payload completo restituito da /api/itinerary/take. */
export interface ItineraryResponse {
    travel: string;
    mode: ItineraryPermissionMode;
    /** true se l'utente che chiede è il creatore del viaggio. */
    isAdmin: boolean;
    /** true se l'utente può modificare le tappe con la modalità corrente. */
    canEdit: boolean;
    startDate: string | null;
    endDate: string | null;
    days: ItineraryDay[];
    ideas: StopDocument[];
    stops: StopDocument[];
    /** Somma dei costi previsti delle tappe non saltate. */
    plannedCost: number;
    participantsCount: number;
}

/** Foto pubblicate nel feed durante un giorno del viaggio. */
export interface RecapDayPhotos {
    day: number;
    label: string;
    count: number;
    /** Nomi file delle prime immagini del giorno, per l'anteprima. */
    preview: string[];
}

/** Riepilogo di fine viaggio. */
export interface ItineraryRecap {
    travel: string;
    name: string;
    startDate: string | null;
    endDate: string | null;
    doneCount: number;
    skippedCount: number;
    totalStops: number;
    plannedCost: number;
    /** Somma reale dei post di tipo "payments" del viaggio. */
    spent: number;
    /** Tappe con coordinate, per la mappa dei posti visti. */
    places: { title: string; lat: number; lon: number; status: StopStatus }[];
    photosByDay: RecapDayPhotos[];
}

/** Risultato di ricerca luogo (Nominatim normalizzato). */
export interface PlaceSearchResult {
    name: string;
    address: string;
    lat: number;
    lon: number;
    osmId: string;
}
