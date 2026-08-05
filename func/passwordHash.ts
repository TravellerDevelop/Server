import bcrypt from "bcryptjs";

/**
 * Hashing delle password — perché esiste.
 *
 * Il client manda un digest SHA-256 della password (vedi
 * Mobile-App/components/auth/api.ts:hashPassword), non la password in
 * chiaro. Fin qui questo digest veniva però salvato COSÌ COM'ERA e
 * confrontato con `==` al login (func/user.ts): un digest non salato è, a
 * tutti gli effetti, equivalente alla password stessa — chi ottiene un dump
 * del database può usarlo direttamente per autenticarsi, o precalcolare
 * dizionari di digest per le password più comuni (nessun salt li rende
 * unici per utente).
 *
 * Questo modulo aggiunge il pezzo mancante: bcrypt, con salt casuale per
 * utente e un costo scelto apposta per essere lento. Non sostituisce il
 * digest lato client (restare compatibili con l'app esistente senza
 * coordinare un rilascio non è più semplice) — lo tratta come "il segreto
 * da proteggere" e ci applica sopra l'hashing che sarebbe dovuto esserci
 * dall'inizio.
 *
 * Isolato in un modulo a parte (niente import di mongo/express) per lo
 * stesso motivo di moneyMath.ts e notificationRules.ts: testabile da solo,
 * e riusabile sia da func/user.ts (login/registrazione) sia dallo script di
 * migrazione una tantum (scripts/migratePasswords.ts) senza duplicare la
 * logica.
 */

/**
 * Costo bcrypt. 10 è il default di bcryptjs: qualche decina di millisecondi
 * per hash, sufficiente a rendere impraticabile un brute force offline pur
 * senza rallentare percettibilmente login/registrazione. Alzarlo aumenta il
 * costo in modo esponenziale per entrambe le parti.
 */
export const BCRYPT_ROUNDS = 10;

/**
 * Vero se il valore è già un hash bcrypt (prefisso "$2a$"/"$2b$"/"$2y$" +
 * costo a due cifre) e non, ad esempio, un vecchio digest SHA-256 salvato
 * prima di questa modifica.
 */
export function isBcryptHash(value: string | undefined | null): boolean {
    return typeof value === "string" && /^\$2[aby]\$\d{2}\$/.test(value);
}

/** Hasha una password (in pratica: il digest mandato dal client) con bcrypt. */
export function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export interface PasswordCheckResult {
    valid: boolean;
    /**
     * Presente solo quando il match è avvenuto su un valore legacy non
     * ancora in bcrypt: chi chiama deve salvarlo al posto del valore letto
     * dal db, così quell'utente non ripassa mai più dal ramo legacy.
     */
    upgradeTo?: string;
}

/**
 * Verifica una password contro il valore salvato, qualunque sia il suo
 * formato.
 *
 * Gestisce la transizione: se il valore salvato è già un hash bcrypt lo
 * confronta con bcrypt.compare; altrimenti assume che sia ancora un digest
 * legacy salvato prima di questa modifica, confronta come faceva il vecchio
 * codice (`===`) e, se combacia, restituisce l'hash bcrypt da salvare —
 * upgrade "pigro" al primo login riuscito, che copre anche gli utenti non
 * ancora toccati dallo script di migrazione batch.
 */
export async function verifyPassword(candidate: string, stored: string | undefined | null): Promise<PasswordCheckResult> {
    if (!stored) return { valid: false };

    if (isBcryptHash(stored)) {
        const valid = await bcrypt.compare(candidate, stored);
        return { valid };
    }

    const valid = stored === candidate;
    if (!valid) return { valid: false };

    const upgradeTo = await hashPassword(candidate);
    return { valid: true, upgradeTo };
}
