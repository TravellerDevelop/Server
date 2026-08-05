import { ObjectId, Document } from "mongodb";
import { Request, Response, NextFunction } from "express";
import { DB_NAME, mongoConnection } from "../server";
import { Cache } from "../types/common";

/** Verifica che la connessione al db sia attiva leggendo la collection "test" (usata solo per lo health check). */
export function verifyConnection(req: Request, res: Response, next: NextFunction) {
    const collection = mongoConnection.db(DB_NAME).collection<Document>("test");
    collection.find({}).toArray(function (err, data) {
        if (err) {
            console.log(err)
            res.status(500).send("Errore nella connessione al database");
        } else {
            if (data.length != 0) {
                res.status(200).send("Ok");
            }
        }
        next();
    });
}

/** Restituisce la versione dell'app salvata nella collection "test", con cache in memoria. */
export function takeVersion(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const CACHE_KEY = "app_version";
    const cachedData = cache.get(CACHE_KEY);
    if (cachedData) {
        cache.set(CACHE_KEY, cachedData);
        res.status(200).send(cachedData);
        next();
    }
    else {
        const collection = mongoConnection.db(DB_NAME).collection<Document>("test");
        collection.find({ _id: new ObjectId("646f82d1e77fa64f3e358dd1") }).toArray(function (err, data) {
            if (err) {
                res.status(500).send("Errore nella connessione al database");
            } else if (data.length != 0) {
                cache.set(CACHE_KEY, data);
                res.status(200).send(data);
            } else {
                res.status(404).send("Versione non trovata");
            }
            next();
        });
    }
}
