import { Request, Response, NextFunction } from "express";

/**
 * Rate limiting in memoria, senza dipendenze esterne.
 *
 * PERCHÉ NON `express-rate-limit`. È la libreria giusta per questo (e
 * l'utente ha approvato di aggiungerla), ma l'ambiente in cui questo file è
 * stato scritto non ha accesso al registro npm per installarla e verificarla
 * (stesso limite di rete già incontrato con `npm run migrate:passwords`,
 * vedi scripts/migratePasswordsToBcrypt.ts). Per non consegnare codice che
 * non ho potuto compilare né testare, questo modulo replica lo stretto
 * necessario (finestra fissa per IP, contatore in memoria) con zero
 * dipendenze: compila ed è verificato in questo stesso ambiente. Se preferisci
 * `express-rate-limit` (più maturo: sliding window, header standard
 * `RateLimit-*`, store condivisibile tra istanze), aggiungila con
 * `npm install express-rate-limit` e sostituisci gli usi di
 * `createRateLimiter` qui sotto con `rateLimit({...})` — l'interfaccia
 * (middleware Express standard) è compatibile.
 *
 * LIMITE NOTO: essendo in memoria e per-processo, un deploy con più istanze
 * dietro un load balancer non condivide i contatori (ogni istanza limita per
 * conto suo) — la stessa limitazione già documentata per SOCKET_SECRET
 * quando generato a runtime. Per un singolo processo (il caso di questo
 * progetto oggi) il limite è efficace.
 */

interface Bucket {
    count: number;
    resetAt: number;
}

export interface RateLimitOptions {
    /** Durata della finestra, in millisecondi. */
    windowMs: number;
    /** Richieste massime per IP entro la finestra. */
    max: number;
    /** Messaggio restituito col 429. */
    message?: string;
}

/**
 * Crea un middleware di rate limiting a finestra fissa, con un contatore
 * per IP. Ogni chiamata a questa funzione crea uno store indipendente:
 * limiter diversi (es. uno stretto per il login, uno generale per /api/*)
 * non si influenzano a vicenda.
 */
export function createRateLimiter(options: RateLimitOptions) {
    const { windowMs, max, message } = options;
    const buckets = new Map<string, Bucket>();

    // Pulizia periodica: senza, ogni IP visto almeno una volta resterebbe in
    // memoria per sempre, anche ore dopo che la sua finestra è scaduta.
    // `unref()` perché questo timer da solo non deve tenere vivo il processo
    // (altrimenti un `npx jest` che importa questo modulo non terminerebbe).
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [key, bucket] of buckets) {
            if (bucket.resetAt <= now) buckets.delete(key);
        }
    }, windowMs);
    sweep.unref();

    return function rateLimit(req: Request, res: Response, next: NextFunction): void {
        // req.ip riflette l'IP reale del client solo se Express si fida
        // dell'header X-Forwarded-For del proxy davanti a lui: vedi
        // `app.set("trust proxy", ...)` in server.ts. Senza, dietro un
        // hosting come Render tutte le richieste risulterebbero dallo stesso
        // IP (quello del proxy) e condividerebbero un unico contatore.
        const key = req.ip || "unknown";
        const now = Date.now();

        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }
        bucket.count += 1;

        res.setHeader("X-RateLimit-Limit", String(max));
        res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
        res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

        if (bucket.count > max) {
            res.status(429).send(message || "Troppe richieste, riprova più tardi");
            return;
        }

        next();
    };
}
