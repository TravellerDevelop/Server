import { ObjectId } from "mongodb";
import NodeCache from "node-cache";
import { DB_NAME } from "../server";
import fs from "fs";

export function takeFollowers(req, res, cache) {
    let to = req.query.to;
    const cachedData = cache.get("followers=" + to)
    if (cachedData) {
        res.send(cachedData).status(200);
        cache.set("followers=" + to, cachedData, 600);
    }
    else {
        req["connessione"].db(DB_NAME).collection("follow").find({ to: to, accepted: true }).toArray(function (err: any, data: any) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            }
            else {
                res.status(200).send(data);
                cache.set("followers=" + to, data, 600);
            }
            req["connessione"].close();
        })
    }
}

export function takeFollowings(req, res, cache) {
    let from = req.query.from;
    const cachedData = cache.get("followings=" + from)
    if (cachedData) {
        res.send(cachedData).status(200);
        cache.set("followings=" + from, cachedData, 600);
    } else {
        req["connessione"].db(DB_NAME).collection("follow").find({ from: from, accepted: true }).toArray(function (err: any, data: any) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            }
            else {
                res.status(200).send(data);
                cache.set("followings=" + from, data, 600);
            }

            req["connessione"].close();
        })
    }
}

export function takeFollowingsWithInfo(req, res, cache) {
    let from = req.query.from;
    let cachedData = cache.get("followingsWithInfo=" + from);
    if (cachedData) {
        res.send(cachedData).status(200)
        cache.set("followingsWithInfo=" + from, cachedData, 600);
    }
    else {
        req["connessione"].db(DB_NAME).collection("follow").find({ from: from, accepted: true }).toArray(function (err: any, data: any) {
            if (err) {
                res.status(500).send("Errore esecuzione query 1");
            }
            else {
                let aus = [];
                for (let item of data) {
                    aus.push(new ObjectId(item.to));
                }
                req["connessione"].db(DB_NAME).collection("user").find({ _id: { $in: aus } }).toArray((err: any, data: any) => {
                    if (err) {
                        res.status(500).send("Errore esecuzione query 2");
                    }
                    else {
                        res.status(200).send(data);
                        cache.set("followingsWithInfo=" + from, data, 600);
                    }

                    req["connessione"].close();
                });
            }
        })
    }
}