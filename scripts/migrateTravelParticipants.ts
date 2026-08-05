import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import { TravelDocument, TravelParticipant } from "../types/travel";

/**
 * Migrazione una tantum: normalizza lo userid dei partecipanti ad ObjectId e
 * rimuove lo username "congelato" salvato sul documento (viene ricalcolato a
 * runtime tramite lookup, vedi func/travels.ts).
 *
 * PERCHÉ UNO SCRIPT E NON PIÙ UNA ROTTA /api/utility. Era esposta come
 * `GET /api/utility`: dietro il middleware di autenticazione REST richiede
 * ormai un token valido, ma qualunque utente loggato — non solo chi
 * amministra il server — poteva comunque invocarla e far riscrivere i
 * partecipanti di *tutti* i viaggi di *tutti* gli utenti. Non esiste un
 * concetto di ruolo/admin in questa app per limitarla a chi dovrebbe
 * lanciarla, quindi la soluzione più semplice e sicura è non esporla affatto
 * via HTTP: stesso approccio già usato per scripts/migratePasswordsToBcrypt.ts.
 * Chi deve rilanciarla lo fa da terminale, con accesso al .env.
 *
 * Uso:
 *   npm run migrate:travelParticipants
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
        const travels = client.db(DB_NAME).collection<TravelDocument>("travels");
        const documents = await travels.find().toArray();

        let updated = 0;
        for (const doc of documents) {
            const participants: TravelParticipant[] = doc.participants.map((participant) => {
                participant.userid = new ObjectId(participant.userid);
                delete participant.username;
                return participant;
            });

            await travels.updateOne({ _id: doc._id }, { $set: { participants } });
            updated++;
        }

        console.log("Migrazione completata.");
        console.log(`  Viaggi esaminati: ${documents.length}`);
        console.log(`  Viaggi aggiornati: ${updated}`);
    } finally {
        await client.close();
    }
}

main().catch((err) => {
    console.error("Migrazione fallita:", err);
    process.exitCode = 1;
});
