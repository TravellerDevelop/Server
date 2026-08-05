import { ObjectId } from "mongodb";

export type PostType = "payments" | "text" | "vote" | "images" | "todo" | "itinerary";

interface PostBase {
    _id: ObjectId;
    creator: ObjectId;
    travel: ObjectId;
    pinned: boolean;
    dateTime: Date;
    /**
     * Ultima volta che il "contenuto" del post è cambiato (creazione, voto,
     * quota segnata/de-segnata, spunta to-do): alimenta il badge "non letti"
     * dei viaggi in home (vedi unseenCount in joinedTravelsPipeline).
     * Assente sui documenti creati prima di questo campo: chi legge tratta
     * l'assenza come "= dateTime" invece di forzare una migrazione.
     * Il pin/unpin non lo tocca di proposito: evidenziare un post non è
     * "nuova attività" per chi già lo conosce.
     */
    updatedAt?: Date;
}

export interface PostDestinator {
    /** Salvato come stringa (userid), non come ObjectId. */
    userid: string;
    payed: boolean;
}

export interface PaymentPost extends PostBase {
    type: "payments";
    amount: number;
    destinator: PostDestinator[];
    paymentType: "normal" | "personal";
    description: string;
}

export interface TextPost extends PostBase {
    type: "text";
    content: string;
}

export interface VotePost extends PostBase {
    type: "vote";
    question: string;
    /** Opzioni disponibili per il voto. */
    content: string[];
    /** Per ogni opzione (stesso indice di "content"), gli username che l'hanno votata. */
    votes: string[][];
}

export interface ImagesPost extends PostBase {
    type: "images";
    /**
     * URL pubblici S3 delle immagini (vedi util/s3.ts e func/post.ts#addPostImage).
     * Nei post creati prima della migrazione a S3 può ancora contenere il
     * vecchio nome file locale, servito da ./static/userImage/posts/, finché
     * non viene aggiornato da migrateImagesToS3 (func/utility.ts).
     */
    source: string[];
    description: string;
}

export interface TodoItem {
    key: number;
    label: string;
    checked: boolean;
}

export interface TodoPost extends PostBase {
    type: "todo";
    description: string;
    items: TodoItem[];
}

/** Azione compiuta sull'itinerario che finisce nel feed. */
export type ItineraryAction =
    | "proposed"
    | "added"
    | "updated"
    | "moved"
    | "removed"
    | "done"
    | "skipped";

/**
 * Post generato dal sistema quando qualcuno tocca l'itinerario.
 * Non è creabile dal compositore: nasce solo dagli endpoint di func/itinerary.ts.
 */
export interface ItineraryPost extends PostBase {
    type: "itinerary";
    action: ItineraryAction;
    /** Tappa collegata; null se nel frattempo è stata eliminata. */
    stop: ObjectId | null;
    stopTitle: string;
    /** Giorno della tappa al momento dell'evento; null se era un'idea. */
    day: number | null;
    /** Riga di dettaglio già pronta per la UI ("spostata al Giorno 2 · 16:00"). */
    detail: string;
}

/** Documento della collection "posts": union discriminata sul campo "type". */
export type PostDocument =
    | PaymentPost
    | TextPost
    | VotePost
    | ImagesPost
    | TodoPost
    | ItineraryPost;

// ======================================================================
// Request DTO
// ======================================================================

/** Payload inviato dal client per creare un post: creator/travel sono ancora stringhe. */
type NewPostInput<T extends PostDocument> = Omit<T, "_id" | "dateTime" | "creator" | "travel"> & {
    creator: string;
    travel: string;
};

export type NewPostBody =
    | NewPostInput<PaymentPost>
    | NewPostInput<TextPost>
    | NewPostInput<VotePost>
    | NewPostInput<ImagesPost>
    | NewPostInput<TodoPost>;

export interface CreatePostBody {
    param: NewPostBody;
}

export interface UpdateVoteBody {
    id: string;
    vote: string[][];
    travelid: string;
}

export interface UpdatePaymentBody {
    id: string;
    destinator: PostDestinator[];
    travelid: string;
}

export interface UpdatePinPostBody {
    param: {
        _id: string;
        pinned: boolean;
        travel: string;
    };
}

export interface DeletePostBody {
    id: string;
    travel: string;
}

export interface AddPostImageBody {
    img: string;
    name: string;
}

export interface UpdateToDoBody {
    id: string;
    items: TodoItem[];
}

// ======================================================================
// Response DTO
// ======================================================================

/** Dati utente del creatore, senza i campi sensibili (email/password/notifToken). */
export type PostCreatorData = { _id: ObjectId; name: string; surname: string; username: string };

/** Post arricchito con i dati (non sensibili) del creatore, ottenuti via lookup. */
export type PostWithCreatorData = PostDocument & {
    creatorData: PostCreatorData[];
};

/** Riga di riepilogo pagamenti raggruppati per viaggio (takePayedGroupByTravel). */
export interface PayedGroupByTravel {
    name: string;
    total: number;
}
