import { Request, Response } from "express";
import { DB_NAME, mongoConnection } from "../server";
import { Cache } from "../types/common";
import { FollowDocument, FollowPairBody } from "../types/follow";
import { UserDocument } from "../types/user";
import { notify } from "./notifications";
import { isSelf } from "./socketAuth";
import { parseObjectIds } from "../util/mongoIds";

function followCollection() {
    return mongoConnection.db(DB_NAME).collection<FollowDocument>("follow");
}

function userCollection() {
    return mongoConnection.db(DB_NAME).collection<UserDocument>("user");
}

export function takeFollowers(req: Request, res: Response, cache: Cache) {
    const to = req.query.to as string;
    const cachedData = cache.get<FollowDocument[]>("followers=" + to)
    if (cachedData) {
        res.send(cachedData).status(200);
        cache.set("followers=" + to, cachedData, 600);
    }
    else {
        followCollection().find({ to, accepted: true }).toArray(function (err, data) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            }
            else {
                res.status(200).send(data);
                cache.set("followers=" + to, data, 600);
            }
        })
    }
}

export function takeFollowings(req: Request, res: Response, cache: Cache) {
    const from = req.query.from as string;
    const cachedData = cache.get<FollowDocument[]>("followings=" + from)
    if (cachedData) {
        res.send(cachedData).status(200);
        cache.set("followings=" + from, cachedData, 600);
    } else {
        followCollection().find({ from, accepted: true }).toArray(function (err, data) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            }
            else {
                res.status(200).send(data);
                cache.set("followings=" + from, data, 600);
            }
        })
    }
}

export function createFollow(req: Request, res: Response) {
    const { to } = req.body as FollowPairBody;
    // Si può mandare una richiesta di follow solo a proprio nome.
    const from = req.auth?.userId as string;

    followCollection().insertOne({ from, to, accepted: false } as FollowDocument, function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.status(200).send(data);

            notify({
                type: "follow_request",
                to: [to],
                actor: from,
                title: "Nuova richiesta",
                body: "{actor} ha chiesto di seguirti",
                entity: data?.insertedId,
                target: { screen: "Notifications" },
                // Richieste ripetute dalla stessa persona non devono impilarsi.
                groupKey: "follow_request:" + from,
            });
        }
    });
}

export function takeFollowFromTo(req: Request, res: Response) {
    const from = req.query.from as string;
    const to = req.query.to as string;

    followCollection().find({ from, to }).toArray(function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        }
        else {
            res.status(200).send(data);
        }
    })
}

export function deleteFollow(req: Request, res: Response, cache: Cache) {
    const { from, to }: FollowPairBody = req.body;
    // Si può sciogliere solo un rapporto di cui si è una delle due parti
    // (smettere di seguire, o rimuovere chi ci segue).
    if (!isSelf(req, from) && !isSelf(req, to)) {
        res.status(403).send("Non autorizzato");
        return;
    }

    followCollection().deleteOne({ from, to }, function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        }
        else {
            res.status(200).send(data);
            cache.del("followers=" + to);
            cache.del("followings=" + from);
            cache.del("followingsWithInfo=" + from);
        }
    })
}

export function takeFollowersRequest(req: Request, res: Response) {
    const to = req.query.to as string;
    // Le richieste di follow in sospeso sono private: solo il destinatario
    // può vedere chi vuole seguirlo.
    if (!isSelf(req, to)) {
        res.status(403).send("Non autorizzato");
        return;
    }

    followCollection().find({ to, accepted: false }).toArray(function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        }
        else {
            res.status(200).send(data);
        }
    })
}

export function acceptFollow(req: Request, res: Response, cache: Cache) {
    const { from, to }: FollowPairBody = req.body;
    // Solo chi è stato seguito può accettare la richiesta.
    if (!isSelf(req, to)) {
        res.status(403).send("Non autorizzato");
        return;
    }

    followCollection().updateOne({ from, to }, { $set: { accepted: true } }, function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        }
        else {
            res.status(200).send(data);
            // Accettata: da qui in poi compare tra i followers di "to" e tra i
            // followings di "from" (le liste filtrano su accepted:true).
            cache.del("followers=" + to);
            cache.del("followings=" + from);
            cache.del("followingsWithInfo=" + from);
            cache.del("notif-unread=" + to);

            // Chi ha mandato la richiesta ("from") va avvisato che è passata.
            notify({
                type: "follow_accepted",
                to: [from],
                actor: to,
                title: "Richiesta accettata",
                body: "{actor} ha accettato la tua richiesta",
                target: { screen: "OtherProfile", params: { userId: to } },
                cache,
            });
        }
    })
}

export function takeFollowingsWithInfo(req: Request, res: Response, cache: Cache) {
    const from = req.query.from as string;
    const cachedData = cache.get<UserDocument[]>("followingsWithInfo=" + from);
    if (cachedData) {
        res.send(cachedData).status(200)
        cache.set("followingsWithInfo=" + from, cachedData, 600);
    }
    else {
        followCollection().find({ from, accepted: true }).toArray(function (err, data) {
            if (err) {
                res.status(500).send("Errore esecuzione query 1");
            }
            else {
                const aus = parseObjectIds(data.map((item) => item.to));
                userCollection().find({ _id: { $in: aus } }).toArray((err, data) => {
                    if (err) {
                        res.status(500).send("Errore esecuzione query 2");
                    }
                    else {
                        res.status(200).send(data);
                        cache.set("followingsWithInfo=" + from, data, 600);
                    }
                });
            }
        })
    }
}
