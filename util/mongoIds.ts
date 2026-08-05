import { ObjectId } from "mongodb";

/**
 * `new ObjectId(id)` lancia se `id` non è un ObjectId valido (24 caratteri
 * esadecimali, o equivalenti). In questo progetto viene chiamata ovunque su
 * valori che arrivano da `req.query`/`req.body` — quindi da fuori — spesso
 * senza un `try/catch` intorno: in un handler sincrono Express intercetta
 * comunque l'eccezione e risponde con l'error page generica, ma in un
 * handler `async` senza `try/catch` diventa una unhandled promise
 * rejection, che nelle versioni recenti di Node termina il processo — un
 * id malformato mandato da chiunque come DoS gratuito.
 *
 * `parseObjectId` non lancia mai: restituisce `null` su un valore non
 * valido, così chi chiama può rispondere con un 400 pulito invece di
 * propagare l'eccezione (o, peggio, non propagarla affatto).
 */
export function parseObjectId(value: unknown): ObjectId | null {
    if (value instanceof ObjectId) return value;
    // Ristretto alla sola forma che questo progetto usa davvero (stringa
    // esadecimale a 24 caratteri, come arriva dal client via JSON):
    // `ObjectId.isValid` da sola accetterebbe anche stringhe di 12
    // caratteri "grezzi", reinterpretandole silenziosamente come byte
    // invece di rifiutarle, che non è mai il comportamento voluto qui.
    if (typeof value !== "string" || !/^[0-9a-fA-F]{24}$/.test(value)) return null;
    try {
        return new ObjectId(value);
    } catch {
        return null;
    }
}

/**
 * Converte una lista di id in ObjectId, scartando quelli non validi.
 * Usata dove un id legacy/malformato in mezzo agli altri non deve far
 * fallire l'intera richiesta (es. `$in`), solo essere ignorato.
 */
export function parseObjectIds(values: unknown[]): ObjectId[] {
    const result: ObjectId[] = [];
    for (const value of values) {
        const id = parseObjectId(value);
        if (id) result.push(id);
    }
    return result;
}
