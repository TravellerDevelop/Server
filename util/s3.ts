import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

/**
 * Upload immagini (copertine viaggio, foto profilo, immagini dei post) su
 * Amazon S3. Sostituisce il salvataggio su disco locale (static/userImage/)
 * usato in precedenza: gli endpoint di upload restituiscono ora l'URL
 * pubblico dell'oggetto S3, che è quanto viene salvato nei documenti Mongo
 * (travel.image, user.image, post.source).
 *
 * Bucket configurato come public-read: niente presigned URL, gli oggetti
 * sono raggiungibili direttamente via publicUrl(key).
 */

/*
 * Le env var vanno lette a runtime dentro le funzioni, MAI in const di modulo:
 * gli `import` in server.ts vengono eseguiti (quindi anche questo modulo)
 * prima di `dotenv.config()`, che è una riga di codice normale più in basso
 * nel file e non un import — leggerle al top-level qui le congelerebbe a
 * `undefined`, prima ancora che il .env sia stato caricato (stesso motivo
 * per cui func/flights.ts legge AERODATABOX_API_KEY dentro la funzione).
 */

let client: S3Client | undefined;
let clientRegion: string | undefined;

function region(): string | undefined {
    return process.env.AWS_REGION;
}

function s3Client(): S3Client {
    const currentRegion = region();
    // Se la region cambia (es. nei test) ricrea il client invece di tenere
    // quello costruito con la region sbagliata la prima volta.
    if (!client || clientRegion !== currentRegion) {
        client = new S3Client({
            region: currentRegion,
            // Se accessKeyId/secretAccessKey non sono in env, l'SDK usa comunque la
            // default credential chain (utile per IAM role in produzione).
            credentials:
                process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
                    ? {
                        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                    }
                    : undefined,
        });
        clientRegion = currentRegion;
    }
    return client;
}

function bucketName(): string {
    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket) {
        throw new Error("AWS_S3_BUCKET non configurato (vedi .env)");
    }
    return bucket;
}

/** Estensione (senza punto) -> content-type. Sufficiente per le immagini caricate dall'app. */
const CONTENT_TYPES: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
};

export function contentTypeFromExtension(ext: string): string {
    return CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}

export function publicUrl(key: string): string {
    return `https://${bucketName()}.s3.${region()}.amazonaws.com/${key}`;
}

/**
 * Estrae la key S3 da un URL prodotto da publicUrl(). Torna null se la stringa
 * non è un URL di questo bucket (es. un nome file "legacy" salvato quando le
 * immagini erano ancora servite da static/userImage/, prima della migrazione).
 */
export function keyFromUrl(value: string): string | null {
    const prefix = `https://${bucketName()}.s3.${region()}.amazonaws.com/`;
    if (!value.startsWith(prefix)) return null;
    return decodeURIComponent(value.slice(prefix.length));
}

/**
 * Carica un buffer su S3 e restituisce l'URL pubblico dell'oggetto.
 * Niente ACL per-oggetto qui: il bucket va configurato con Object Ownership
 * "Bucket owner enforced" (default AWS, ACL disabilitate) e una bucket
 * policy che concede s3:GetObject pubblico su tutti gli oggetti — è
 * l'approccio raccomandato da AWS oggi, al posto delle ACL sugli oggetti.
 */
export async function uploadBuffer(key: string, buffer: Buffer, contentType?: string): Promise<string> {
    await s3Client().send(
        new PutObjectCommand({
            Bucket: bucketName(),
            Key: key,
            Body: buffer,
            ContentType: contentType,
        })
    );
    return publicUrl(key);
}

export async function deleteObject(key: string): Promise<void> {
    await s3Client().send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
}

/**
 * Elimina un'immagine identificata da `ref`, che può essere:
 * - un URL S3 (caso normale post-migrazione) -> DeleteObjectCommand;
 * - un nome file "legacy" salvato ancora localmente (documento non ancora
 *   migrato) -> fs.unlink nella cartella locale indicata da `legacyDir`.
 * Non lancia mai: la cancellazione dell'immagine non deve mai far fallire
 * la richiesta principale (stesso criterio già in uso per fs.unlink prima
 * di questa modifica).
 */
export async function deleteStoredImage(ref: string | undefined | null, legacyDir: string): Promise<void> {
    if (!ref) return;

    const key = keyFromUrl(ref);
    if (key) {
        try {
            await deleteObject(key);
        } catch (err) {
            console.log("Errore eliminazione oggetto S3: " + key, err);
        }
        return;
    }

    try {
        await fs.promises.unlink(path.join(legacyDir, ref));
    } catch (err) {
        console.log("Errore eliminazione immagine legacy: " + ref, err);
    }
}
