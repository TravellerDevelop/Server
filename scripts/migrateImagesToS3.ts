import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { MongoClient } from "mongodb";
import { TravelDocument } from "../types/travel";
import { UserDocument } from "../types/user";
import { PostDocument } from "../types/post";
import { contentTypeFromExtension, uploadBuffer } from "../util/s3";

/**
 * Migrazione una tantum: carica su S3 tutte le immagini ancora presenti
 * localmente in static/userImage/ (copertine viaggio, foto profilo) e
 * static/userImage/posts/ (immagini dei post), poi aggiorna i documenti
 * Mongo che le referenziavano per nome file (travels.image, user.image,
 * posts.source) con il nuovo URL pubblico S3 — stessa key del file locale,
 * così i riferimenti restano coerenti (vedi util/s3.ts,
 * func/travels.ts#uploadImage, func/post.ts#addPostImage).
 *
 * Da lanciare una volta, dopo aver configurato le variabili AWS_* in .env,
 * e prima o durante il rollout della migrazione a S3.
 *
 * PERCHÉ UNO SCRIPT E NON PIÙ UNA ROTTA /api/utility/migrateImagesToS3.
 * Stesso motivo di scripts/migrateTravelParticipants.ts: era raggiungibile
 * da chiunque avesse un token valido, non solo da chi amministra il server.
 * Riscrivere in blocco i riferimenti immagine di ogni viaggio/utente/post
 * non è un'operazione che un utente qualunque deve poter innescare.
 *
 * Uso:
 *   npm run migrate:imagesToS3
 */

const DB_NAME = "traveller"; // deve restare allineato a server.ts

const COVER_IMAGE_DIR = "./static/userImage/";
const COVER_IMAGE_S3_PREFIX = "userImage/";
const POST_IMAGE_DIR = "./static/userImage/posts/";
const POST_IMAGE_S3_PREFIX = "userImage/posts/";

/** Nomi dei file (non directory) presenti in `dir`; [] se la cartella non esiste. */
async function listFiles(dir: string): Promise<string[]> {
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch {
        return [];
    }
}

/**
 * Carica su S3 tutti i file di `dir` (non ricorsivo) sotto la key `s3Prefix + nomefile`,
 * cioè la stessa key che useranno gli endpoint di upload per i nuovi file. Un errore
 * sul singolo file non interrompe la migrazione degli altri.
 */
async function uploadDirToS3(dir: string, s3Prefix: string): Promise<{ uploaded: Map<string, string>; errors: string[] }> {
    const uploaded = new Map<string, string>();
    const errors: string[] = [];

    for (const fileName of await listFiles(dir)) {
        try {
            const buffer = await fs.promises.readFile(path.join(dir, fileName));
            const ext = fileName.split(".").pop() ?? "";
            const url = await uploadBuffer(s3Prefix + fileName, buffer, contentTypeFromExtension(ext));
            uploaded.set(fileName, url);
        } catch (err: any) {
            errors.push(`${fileName}: ${err.message}`);
        }
    }

    return { uploaded, errors };
}

async function main(): Promise<void> {
    dotenv.config({ path: ".env" });

    const connectionString = process.env.connectionString;
    if (!connectionString) {
        console.error("Manca 'connectionString' nel .env: impossibile connettersi a Mongo.");
        process.exitCode = 1;
        return;
    }
    if (!process.env.AWS_S3_BUCKET) {
        console.error("Manca 'AWS_S3_BUCKET' nel .env: impossibile caricare su S3.");
        process.exitCode = 1;
        return;
    }

    const client = new MongoClient(connectionString);
    await client.connect();
    console.log("Connesso al database.");

    try {
        const travelsCollection = client.db(DB_NAME).collection<TravelDocument>("travels");
        const usersCollection = client.db(DB_NAME).collection<UserDocument>("user");
        const postsCollection = client.db(DB_NAME).collection<PostDocument>("posts");

        const [covers, postImages] = await Promise.all([
            uploadDirToS3(COVER_IMAGE_DIR, COVER_IMAGE_S3_PREFIX),
            uploadDirToS3(POST_IMAGE_DIR, POST_IMAGE_S3_PREFIX),
        ]);

        let travelsUpdated = 0;
        const travelDocs = await travelsCollection.find({ image: { $exists: true, $ne: null } } as never).toArray();
        for (const doc of travelDocs) {
            const url = doc.image ? covers.uploaded.get(doc.image) : undefined;
            if (url) {
                await travelsCollection.updateOne({ _id: doc._id }, { $set: { image: url } });
                travelsUpdated++;
            }
        }

        let usersUpdated = 0;
        const userDocs = await usersCollection.find({ image: { $exists: true, $ne: null } } as never).toArray();
        for (const doc of userDocs) {
            const url = doc.image ? covers.uploaded.get(doc.image) : undefined;
            if (url) {
                await usersCollection.updateOne({ _id: doc._id }, { $set: { image: url } });
                usersUpdated++;
            }
        }

        let postsUpdated = 0;
        const postDocs = await postsCollection.find({ type: "images" } as never).toArray();
        for (const doc of postDocs) {
            if (doc.type !== "images") continue;
            let changed = false;
            const newSource = doc.source.map((item) => {
                const url = postImages.uploaded.get(item);
                if (url) {
                    changed = true;
                    return url;
                }
                return item;
            });
            if (changed) {
                await postsCollection.updateOne({ _id: doc._id }, { $set: { source: newSource } as never });
                postsUpdated++;
            }
        }

        console.log("Migrazione completata.");
        console.log(`  Copertine caricate su S3:     ${covers.uploaded.size}`);
        if (covers.errors.length) console.log(`  Errori copertine:            ${covers.errors.join("; ")}`);
        console.log(`  Immagini post caricate su S3: ${postImages.uploaded.size}`);
        if (postImages.errors.length) console.log(`  Errori immagini post:        ${postImages.errors.join("; ")}`);
        console.log(`  Viaggi aggiornati:            ${travelsUpdated}`);
        console.log(`  Utenti aggiornati:            ${usersUpdated}`);
        console.log(`  Post aggiornati:              ${postsUpdated}`);
    } finally {
        await client.close();
    }
}

main().catch((err) => {
    console.error("Migrazione fallita:", err);
    process.exitCode = 1;
});
