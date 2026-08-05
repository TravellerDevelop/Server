import { ObjectId } from "mongodb";

export interface TravelParticipant {
    userid: ObjectId;
    /**
     * Presente e "true" solo per il creatore del viaggio; per gli altri
     * partecipanti il campo è quasi sempre assente (in un caso storico è "false").
     */
    creator?: boolean;
    /**
     * Non persistito su db: unito a runtime tramite lookup sulla
     * collection "user" (vedi joinedTravelsPipeline in func/travels.ts).
     */
    username?: string;
    /**
     * Tetto di spesa che il singolo partecipante si è dato per questo
     * viaggio, indipendente dal `budget` condiviso del viaggio (che invece
     * decide il creatore). Assente finché non lo imposta: vedi
     * setPersonalBudget e BudgetIndicator lato client.
     */
    personalBudget?: number | null;
    /**
     * Ultima volta che *questo* partecipante ha aperto il viaggio, aggiornata
     * da markTravelSeen (chiamata da TravelDetail al mount). Assente finché
     * non lo apre almeno una volta: in quel caso joinedTravelsPipeline tratta
     * "mai visto" come "conta tutta l'attività non sua".
     */
    lastSeenAt?: Date;
}

/**
 * Valori storicamente salvati come stringa ("0"/"1"/"2"); alcuni documenti
 * legacy hanno stringa vuota o il numero 0 al posto della stringa "0".
 * "3" è il valore usato dal flusso "Nuovo viaggio"/"Modifica viaggio" per
 * "privato" (vedi components/newTravel/types.ts sul client: "1" pubblico,
 * "3" privato).
 */
export type TravelVisibility = "0" | "1" | "2" | "3" | "" | 0;
export type NewMembersAllowed = "0" | "1" | "2" | "" | 0;

/** Documento della collection "travels". */
export interface TravelDocument {
    _id: ObjectId;
    name: string;
    description: string;
    /** Numerico nei documenti recenti; stringa vuota o null in quelli legacy. */
    budget: number | string | null;
    participants: TravelParticipant[];
    visibility: TravelVisibility;
    creation_date: Date;
    new_members_allowed: NewMembersAllowed;
    /** Codice invito univoco usato per l'iscrizione (vedi joinTravel). */
    code: string;
    /** Assente in alcuni documenti legacy: trattarlo come "false" quando manca. */
    closed?: boolean;
    /**
     * URL pubblico dell'immagine di copertina su S3 (vedi util/s3.ts e
     * func/travels.ts#uploadImage). Nei documenti creati prima della
     * migrazione a S3 può ancora contenere il vecchio nome file locale
     * (servito da ./static/userImage/) finché non viene aggiornato da
     * migrateImagesToS3 (scripts/migrateImagesToS3.ts).
     */
    image?: string;
    /** Destinazione testuale (es. "Roma"); assente nei viaggi creati prima dell'itinerario. */
    destination?: string;
    /**
     * Date del viaggio: da qui derivano i giorni della timeline dell'itinerario.
     * Assenti (o null) nei viaggi creati prima dell'itinerario e in quelli
     * per cui l'utente non le ha ancora impostate.
     */
    startDate?: Date | null;
    endDate?: Date | null;
    /**
     * Campo legacy residuo di un bug di scrittura risalente (creation_date
     * finiva sull'epoch e la data reale veniva salvata qui come stringa).
     * @deprecated non più scritto dal client attuale.
     */
    date?: string;
}

// ======================================================================
// Request DTO
// ======================================================================

export interface CreateTravelParticipantInput {
    userid: string;
    creator?: boolean;
}

export interface CreateTravelBody {
    name: string;
    description: string;
    budget: number | string | null;
    participants: CreateTravelParticipantInput[];
    visibility: TravelVisibility;
    new_members_allowed: NewMembersAllowed;
    code: string;
    creation_date: string;
    closed?: boolean;
    image?: string;
    destination?: string;
    /** ISO string o stringa vuota se l'utente non ha indicato le date. */
    startDate?: string;
    endDate?: string;
}

export interface UpdateTravelBody {
    id: string;
    /**
     * Chi sta compiendo l'azione. Opzionale per retrocompatibilità con i
     * client vecchi: serve solo per escluderlo dai destinatari della notifica
     * (senza, l'autore della modifica riceve la push della propria modifica).
     */
    userid?: string;
    param: {
        name: string;
        description: string;
        budget: number | string | null;
        /** Campi opzionali: aggiornati solo se presenti nel payload. */
        destination?: string;
        startDate?: string | null;
        endDate?: string | null;
        visibility?: TravelVisibility;
        /** URL S3 della nuova copertina (già caricata via uploadImage). */
        image?: string;
    };
}

export interface CloseTravelBody {
    id: string;
    /** Vedi la nota su UpdateTravelBody.userid. */
    userid?: string;
}

export interface DeleteTravelBody {
    id: string;
    /** Vedi la nota su UpdateTravelBody.userid. */
    userid?: string;
}

export interface JoinTravelBody {
    code: string;
    username: string;
    userid: string;
}

export interface SetPersonalBudgetBody {
    travelid: string;
    userid: string;
    /** null per rimuovere il budget personale. */
    budget: number | null;
}

export interface LeaveTravelBody {
    travel: string;
    userid: string;
}

export interface MarkTravelSeenBody {
    travelid: string;
    userid: string;
}

export interface UploadTravelImageBody {
    img: string;
    imgName: string;
}

// ======================================================================
// Response DTO
// ======================================================================

/** Documento viaggio con lo username di ogni partecipante unito a runtime (vedi joinedTravelsPipeline). */
export interface JoinedTravelDocument extends Omit<TravelDocument, "participants"> {
    participants: (TravelParticipant & { username: string })[];
    /**
     * Quanti post/aggiornamenti nel viaggio l'utente che ha chiamato
     * takeJoinedTravels non ha ancora visto (esclusi i post creati da lui
     * stesso). Calcolato al volo dalla pipeline, non persistito.
     */
    unseenCount: number;
}

/** Riga restituita da takeTravelsParticipants: dati utente "appiattiti" per un partecipante. */
export interface TravelParticipantInfo {
    _id: ObjectId;
    username: string;
    name: string;
    surname: string;
}
