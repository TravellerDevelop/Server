import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { hashPassword, isBcryptHash } from "../func/passwordHash";
import { UserDocument } from "../types/user";

/**
 * Migrazione una tantum: converte in bcrypt le password salvate prima di
 * questa modifica (il digest SHA-256 mandato dal client, salvato così com'era
 * — vedi func/passwordHash.ts per il perché è un problema).
 *
 * PERCHÉ UNO SCRIPT A PARTE E NON UNA ROTTA /api/utility COME LE ALTRE
 * MIGRAZIONI (func/utility.ts). Le migrazioni esposte via HTTP in questo
 * progetto sono già un rischio noto (endpoint raggiungibile da chiunque
 * abbia un token valido, vedi la security review): va bene per rimescolare
 * partecipanti o url di immagini, non per una migrazione che tocca le
 * password di ogni utente. Questo script si connette a Mongo per conto suo
 * e va lanciato a mano, una volta, da chi ha accesso al server/al .env.
 *
 * Idempotente: chi ha già un hash bcrypt (prefisso "$2a$"/"$2b$"/"$2y$")
 * viene saltato, quindi si può rilanciare senza rischio se si interrompe a
 * metà o se nel frattempo `login()` ha già aggiornato qualcuno da solo
 * (l'upgrade "pigro" descritto in func/user.ts fa esattamente questo).
 *
 * Uso:
 *   npm run migrate:passwords
 */

const DB_NAME = "traveller"; // deve restare allineato a server.ts

async function main(): Promise<void> {
    dotenv.config({ path: ".env" });

    const connectionString = process.env.connectionString;
    if (!connectionString) {
        console.error("Manca 'connectionString' nel .env: impossibile connettersi a Mongo.");
        process.exitCode = 1;
        return;
    }

    const client = new MongoClient(connectionString);
    await client.connect();
    console.log("Connesso al database.");

    try {
        const users = client.db(DB_NAME).collection<UserDocument>("user");

        // Proiezione minima: non serve altro che id e password per decidere
        // e scrivere, ed evitare di portare in memoria documenti interi non
        // aiuta su una collection grande.
        const cursor = users.find({}, { projection: { password: 1 } });

        let scanned = 0;
        let migrated = 0;
        let skippedAlreadyBcrypt = 0;
        let skippedNoPassword = 0;

        for await (const doc of cursor) {
            scanned += 1;

            if (!doc.password) {
                skippedNoPassword += 1;
                continue;
            }

            if (isBcryptHash(doc.password)) {
                skippedAlreadyBcrypt += 1;
                continue;
            }

            const hashed = await hashPassword(doc.password);
            await users.updateOne({ _id: doc._id }, { $set: { password: hashed } });
            migrated += 1;
        }

        console.log("Migrazione completata.");
        console.log(`  Utenti esaminati:        ${scanned}`);
        console.log(`  Migrati a bcrypt ora:     ${migrated}`);
        console.log(`  Già in bcrypt (saltati):  ${skippedAlreadyBcrypt}`);
        console.log(`  Senza password (saltati): ${skippedNoPassword}`);
    } finally {
        await client.close();
    }
}

main().catch((err) => {
    console.error("Migrazione fallita:", err);
    process.exitCode = 1;
});
