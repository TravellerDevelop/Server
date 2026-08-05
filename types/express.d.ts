import "express";

/**
 * Estende Request con l'identità verificata dal middleware requireAuth
 * (vedi func/socketAuth.ts). Popolato SOLO da quel middleware: nessun altro
 * punto del codice deve scrivere req.auth, altrimenti torna possibile
 * "dichiarare" un'identità invece di dimostrarla con un token valido.
 */
declare global {
    namespace Express {
        interface Request {
            auth?: { userId: string };
        }
    }
}

export {};
