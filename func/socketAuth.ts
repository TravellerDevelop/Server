import crypto from "crypto";
import { Request, Response, NextFunction } from "express";

/**
 * Token di sessione per il canale realtime.
 *
 * PERCHÉ ESISTE. Prima di questo modulo il socket accettava l'evento
 * "identify" con un userid arbitrario: bastava aprire una connessione e
 * dichiararsi un altro utente per entrare nella sua stanza personale e
 * ricevere le sue notifiche. Ora l'userid non arriva più dal client come
 * dato di cui fidarsi: arriva dentro un token firmato dal server, e il
 * socket lavora sull'id che la verifica restituisce.
 *
 * LIMITI, DETTI CHIARAMENTE. Le rotte REST di questo backend non sono
 * autenticate (l'userid viaggia come parametro), quindi chi può chiamare
 * `/api/user/takeUserById` con un id altrui può anche ottenerne il token.
 * Questo modulo NON è un sistema di autenticazione: chiude la falla del
 * canale realtime (impersonificazione a costo zero, senza nemmeno conoscere
 * un id) e prepara il terreno, ma la protezione vera resta da fare sul
 * REST — un middleware di sessione su /api/* che riusi questi token.
 *
 * FORMA DEL TOKEN: "<versione>.<scadenza-epoch-ms>.<hmac-hex>", firmato
 * su "<userId>.<scadenza>". È stateless: nessuna collection, nessuna
 * lookup, la verifica è solo un HMAC. Di conseguenza non è revocabile
 * prima della scadenza se non ruotando il segreto.
 */

const TOKEN_VERSION = "v1";
const SEPARATOR = ".";

/** 30 giorni: l'app rilegge il profilo (e quindi il token) a ogni avvio. */
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Segreto di firma. In produzione DEVE arrivare dall'ambiente: un segreto
 * generato a runtime cambia a ogni riavvio (e differisce tra le istanze di
 * un eventuale deploy multi-processo), invalidando tutti i token emessi.
 * Il fallback casuale esiste solo perché il server non deve rifiutarsi di
 * partire in locale se manca il .env — il client sa già rinnovare il token
 * quando l'handshake viene rifiutato.
 */
let secret: Buffer = resolveSecret();

function resolveSecret(): Buffer {
    const fromEnv = process.env.SOCKET_SECRET;
    if (fromEnv && fromEnv.length >= 16) {
        return Buffer.from(fromEnv, "utf8");
    }
    console.log(
        "[socketAuth] SOCKET_SECRET assente o troppo corto (min 16 caratteri): " +
        "uso un segreto casuale valido solo per questo processo. " +
        "In produzione impostalo nel .env, altrimenti a ogni riavvio tutti i socket " +
        "devono rinegoziare il token."
    );
    return crypto.randomBytes(32);
}

/** Solo per i test: permette di fissare il segreto e rendere i token deterministici. */
export function _setSecretForTests(value: string): void {
    secret = Buffer.from(value, "utf8");
}

function sign(userId: string, expiresAt: number): string {
    return crypto
        .createHmac("sha256", secret)
        .update(userId + SEPARATOR + expiresAt)
        .digest("hex");
}

/**
 * Emette un token per l'utente indicato. Chiamata dalle rotte che
 * restituiscono il profilo (login, registrazione, takeUserById).
 */
export function issueSocketToken(userId: string, now: number = Date.now()): string {
    const expiresAt = now + TOKEN_TTL_MS;
    return [TOKEN_VERSION, String(expiresAt), sign(userId, expiresAt)].join(SEPARATOR);
}

export type SocketAuthFailure =
    | "missing"      // token o userid assenti
    | "malformed"    // formato non riconosciuto
    | "expired"
    | "invalid";     // firma non corrispondente

/**
 * Entrambi i campi sono dichiarati su entrambi i rami (come `undefined`
 * sul ramo che non li usa) perché `strict` è disattivato nel tsconfig di
 * questo progetto: senza `strictNullChecks` TypeScript non restringe la
 * union sul discriminante `ok`, e leggere `result.reason` dopo un
 * `if (!result.ok)` verrebbe segnalato come errore.
 */
export type SocketAuthResult =
    | { ok: true; userId: string; reason?: undefined }
    | { ok: false; userId?: undefined; reason: SocketAuthFailure };

/**
 * Verifica il token e restituisce l'userid **firmato**, non quello
 * dichiarato: chi chiama deve usare il valore di ritorno e mai il campo
 * grezzo dell'handshake.
 */
export function verifySocketToken(
    userId: unknown,
    token: unknown,
    now: number = Date.now()
): SocketAuthResult {
    if (typeof userId !== "string" || typeof token !== "string" || !userId || !token) {
        return { ok: false, reason: "missing" };
    }

    const parts = token.split(SEPARATOR);
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
        return { ok: false, reason: "malformed" };
    }

    const expiresAt = Number(parts[1]);
    if (!Number.isFinite(expiresAt)) {
        return { ok: false, reason: "malformed" };
    }
    if (expiresAt <= now) {
        return { ok: false, reason: "expired" };
    }

    const expected = sign(userId, expiresAt);
    const provided = parts[2];

    // Confronto a tempo costante: un `===` su stringhe esce al primo byte
    // diverso e lascia misurare la firma corretta un carattere alla volta.
    // timingSafeEqual pretende lunghezze uguali, quindi il caso "lunghezza
    // diversa" va escluso prima (e non rivela nulla: la lunghezza dell'hex
    // di uno sha256 è fissa e pubblica).
    if (provided.length !== expected.length) {
        return { ok: false, reason: "invalid" };
    }
    const same = crypto.timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));

    return same ? { ok: true, userId } : { ok: false, reason: "invalid" };
}

/* ============================================================
 * Autenticazione REST
 *
 * Fino a qui questo modulo copriva solo l'handshake del socket. Le rotte
 * REST restavano aperte: chiunque poteva chiamare /api/* dichiarando un
 * userid qualsiasi nel body/query, senza dimostrare di esserlo davvero (è
 * il limite descritto nell'intestazione del file, ora chiuso).
 *
 * Il meccanismo è lo stesso identico token già emesso da issueSocketToken()
 * e già trattato dal client come una password (vive solo in SecureStore,
 * vedi global/authContext.tsx sul client). Per il REST viaggia in due
 * header, esattamente come i due campi già mandati nell'handshake:
 *
 *   Authorization: Bearer <socketToken>
 *   X-User-Id: <userId>
 *
 * requireAuth verifica la coppia con verifySocketToken() — la stessa
 * funzione, la stessa firma HMAC, nessuna logica duplicata — e scrive
 * l'identità VERIFICATA in req.auth.userId. Da qui in poi gli handler non
 * devono più fidarsi dell'userid dichiarato nel body/query per decidere
 * "chi sta facendo cosa": quello va preso da req.auth.userId.
 * ============================================================ */

function extractBearerToken(req: Request): string | undefined {
    const header = req.header("authorization");
    if (!header || !header.toLowerCase().startsWith("bearer ")) return undefined;
    const token = header.slice(7).trim();
    return token.length > 0 ? token : undefined;
}

/**
 * Middleware Express: rifiuta con 401 chi non presenta un token valido per
 * l'userid dichiarato nell'header X-User-Id. Da applicare a tutte le rotte
 * /api/* tranne quelle esplicitamente pubbliche (login, registrazione, ...).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const token = extractBearerToken(req);
    const userId = req.header("x-user-id");

    const result = verifySocketToken(userId, token);
    if (!result.ok) {
        res.status(401).json({ error: "unauthorized", reason: result.reason });
        return;
    }

    req.auth = { userId: result.userId };
    next();
}

/**
 * Vero se l'identità verificata dalla richiesta corrisponde all'id passato
 * (tipicamente un campo "userid" del body/query). Da usare in ogni handler
 * che prima si fidava di quel campo per decidere "di chi sono questi dati":
 * il caso tipico è "il mio riepilogo Money", "le mie notifiche", "i miei
 * viaggi creati" — dati che un utente autenticato non deve poter leggere
 * o scrivere per conto di un altro semplicemente cambiando un parametro.
 */
export function isSelf(req: Request, claimedUserId: string | null | undefined): boolean {
    return Boolean(claimedUserId) && req.auth?.userId === claimedUserId;
}
