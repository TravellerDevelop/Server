import { ObjectId } from "mongodb";
import { DB_NAME } from "../server";
import NodeCache from "node-cache";

export function verifyConnection(req: Request, res: any) {
    let collection = req["connessione"].db(DB_NAME).collection("test");
    collection.find({}).toArray(function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore nella connessione al database");
        } else {
            if (data.length != 0) {
                res.status(200).send("Ok");
            }
        }
        req["connessione"].close();
    });
}

export function takeVersion(req: Request, res: any, cache: NodeCache) {
    let cachedData = cache.get("app_version");
    if (cachedData) {
        cache.set("app-version", cachedData)
        res.send(cachedData).status(200);
    }
    else {
        let collection = req["connessione"].db(DB_NAME).collection("test");
        collection.find({ _id: new ObjectId("646f82d1e77fa64f3e358dd1") }).toArray(function (err: any, data: any) {
            if (err) {
                res.send("Errore nella connessione al database").status(500);
            } else {
                if (data.length != 0) {
                    cache.set("app-version", cachedData)
                    res.status(200).send(data);
                }
            }
            req["connessione"].close();
        });
    }
}