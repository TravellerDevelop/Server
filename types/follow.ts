import { ObjectId } from "mongodb";

/** Documento della collection "follow". */
export interface FollowDocument {
    _id: ObjectId;
    /** userid dell'utente che segue, salvato come stringa (non ObjectId). */
    from: string;
    /** userid dell'utente seguito, salvato come stringa (non ObjectId). */
    to: string;
    accepted: boolean;
}

// ======================================================================
// Request DTO
// ======================================================================

/** Corpo condiviso da create/delete/accept: coppia (from, to) di userid. */
export interface FollowPairBody {
    from: string;
    to: string;
}
