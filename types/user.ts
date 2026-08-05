import { ObjectId } from "mongodb";
import { UserNotificationSettings } from "./notification";

/** Documento della collection "user". */
export interface UserDocument {
    _id: ObjectId;
    name: string;
    surname: string;
    username: string;
    email: string;
    password: string;
    /** Token push Expo per le notifiche; presente solo dopo la prima registrazione da app. Può contenere "null" residui. */
    notifToken?: (string | null)[];
    /**
     * Scostamenti dai default del catalogo notifiche (vedi types/notification.ts).
     * Assente finché l'utente non tocca la schermata preferenze.
     */
    notificationSettings?: UserNotificationSettings;
    /**
     * Nome file dell'immagine profilo, salvata in ./static/userImage/.
     * Non presente in nessun documento reale al momento: il frontend (screens/profile)
     * la legge e chiama api/user/uploadImage + api/user/setImage per impostarla, ma
     * queste due route non esistono ancora lato server (vedi func/travels.ts per
     * l'equivalente già implementato su "travels").
     */
    image?: string;
}

/**
 * Utente come lo vede il client: senza il digest della password e con il
 * token del canale realtime. Prodotto da `forClient()` in func/user.ts, che
 * è l'unico punto autorizzato a serializzare un utente verso l'esterno.
 */
export type UserForClient = Omit<UserDocument, "password"> & {
    /** Credenziale firmata per l'handshake Socket.io (vedi func/socketAuth.ts). */
    socketToken: string;
};

// ======================================================================
// Request DTO
// ======================================================================

export interface RegisterUserBody {
    name: string;
    surname: string;
    username: string;
    email: string;
    password: string;
}

export interface LoginBody {
    username: string;
    password: string;
}

export interface FromIdToUsernameBody {
    id: string[];
}

export interface SetUserNotifTokenBody {
    userid: string;
    notifToken: string;
}

export interface VerifyTokenBody {
    userid: string;
    notificationToken: string;
}

// ======================================================================
// Response DTO
// ======================================================================

export interface TakeTravelsNumResponse {
    count: number;
}

export interface SetUserNotifTokenResponse {
    updated: boolean;
    token: (string | null)[];
}

export interface VerifyTokenResponse {
    is: boolean;
    updated?: boolean;
}
