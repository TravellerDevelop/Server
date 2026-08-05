import { ObjectId } from "mongodb";
import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { DB_NAME, mongoConnection } from "../server";
import { TravelDocument, TravelParticipant } from "../types/travel";
import { UserDocument } from "../types/user";
import { PostDocument } from "../types/post";
import { contentTypeFromExtension, uploadBuffer } from "../util/s3";

function travelsCollection() {
    return mongoConnection.db(DB_NAME).collection<TravelDocument>("travels");
}

function usersCollection() {
    return mongoConnection.db(DB_NAME).collection<UserDocument>("user");
}

function postsCollection() {
    return mongoConnection.db(DB_NAME).collection<PostDocument>("posts");
}

/**
 * Endpoint di utilità/manutenzione una tantum: normalizza lo userid dei
 * partecipanti ad ObjectId e rimuove lo username "congelato" salvato sul
 * documento (viene ricalcolato a runtime tramite lookup, vedi func/travels.ts).
 */
export function migrateTravelParticipants(req: Request, res: Response) {
    travelsCollection().find().toArray()
        .then((documents) => {
            documents.forEach((doc) => {
                const participants: TravelParticipant[] = doc.participants.map((participant) => {
                    participant.userid = new ObjectId(participant.userid);
                    delete participant.username;
                    return participant;
                });

                travelsCollection().updateOne(
                    { _id: doc._id },
                    { $set: { participants: participants } }
                );
            });
        })
        .catch((err) => {
            res.status(500).send(err);
        });

    // mongoConnection.db(DB_NAME).collection("tickets").find()
    //   .toArray((err, response) => {
    //     if (!err) {
    //       for (let item of response) {
    //         mongoConnection.db(DB_NAME).collection("tickets").updateOne({ _id: item._id }, { $set: { creator: new ObjectId(item.creator) } })
    //           .then(() => {
    //             console.log("Successo per " + item.name);
    //           })
    //           .catch(() => {
    //             console.log("Fallimento per " + item.name);
    //           })
    //       }
    //     }
    //     else {
    //       console.log('Errore 1');
    //     }
    //   })

    // mongoConnection.db(DB_NAME).collection("user").find()
    //   .toArray((err, response) => {
    //     if (!err) {
    //       for (let item of response) {
    //         mongoConnection.db(DB_NAME).collection("posts").updateMany({ creator: item.username }, { $set: { creator: item._id } })
    //           .then(() => {
    //             console.log("Successo per " + item.username);
    //           })
    //           .catch(() => {
    //             console.log("Fallimento per " + item.username);
    //           })
    //       }
    //     }
    //     else {
    //       console.log('Errore 1');
    //     }
    //   })
}

// =====================================================================================
// Migrazione immagini locali -> S3
// =====================================================================================

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

/**
 * Endpoint di utilità/manutenzione una tantum: carica su S3 tutte le immagini
 * ancora presenti localmente in static/userImage/ (copertine viaggio, foto
 * profilo) e static/userImage/posts/ (immagini dei post), poi aggiorna i
 * documenti Mongo che le referenziavano per nome file (travels.image,
 * user.image, posts.source) con il nuovo URL pubblico S3 — stessa key del
 * file locale, così i riferimenti restano coerenti (vedi util/s3.ts,
 * func/travels.ts#uploadImage, func/post.ts#addPostImage). Da lanciare una
 * volta, dopo aver configurato le variabili AWS_* in .env, e prima o durante
 * il rollout della migrazione a S3.
 */
export async function migrateImagesToS3(req: Request, res: Response) {
    try {
        const [covers, postImages] = await Promise.all([
            uploadDirToS3(COVER_IMAGE_DIR, COVER_IMAGE_S3_PREFIX),
            uploadDirToS3(POST_IMAGE_DIR, POST_IMAGE_S3_PREFIX),
        ]);

        let travelsUpdated = 0;
        const travelDocs = await travelsCollection().find({ image: { $exists: true, $ne: null } } as never).toArray();
        for (const doc of travelDocs) {
            const url = doc.image ? covers.uploaded.get(doc.image) : undefined;
            if (url) {
                await travelsCollection().updateOne({ _id: doc._id }, { $set: { image: url } });
                travelsUpdated++;
            }
        }

        let usersUpdated = 0;
        const userDocs = await usersCollection().find({ image: { $exists: true, $ne: null } } as never).toArray();
        for (const doc of userDocs) {
            const url = doc.image ? covers.uploaded.get(doc.image) : undefined;
            if (url) {
                await usersCollection().updateOne({ _id: doc._id }, { $set: { image: url } });
                usersUpdated++;
            }
        }

        let postsUpdated = 0;
        const postDocs = await postsCollection().find({ type: "images" } as never).toArray();
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
                await postsCollection().updateOne({ _id: doc._id }, { $set: { source: newSource } as never });
                postsUpdated++;
            }
        }

        res.status(200).json({
            coversUploaded: covers.uploaded.size,
            coverErrors: covers.errors,
            postImagesUploaded: postImages.uploaded.size,
            postImageErrors: postImages.errors,
            travelsUpdated,
            usersUpdated,
            postsUpdated,
        });
    } catch (err: any) {
        res.status(500).send(err.message);
    }
}
