import { ObjectId } from "mongodb";
import NodeCache from "node-cache";
import { DB_NAME } from "../server";

export function takeUserInfo(req: any, res: any, cache: NodeCache, next) {
    let username = req.query.username;
    let cachedData = cache.get("user-usn=" + username);

    if (cachedData) {
        cache.set("user-usn=" + username, cachedData, 600);
        res.send(cachedData).status(200);
        next();
    }
    else {
        let collection = req["connessione"].db(DB_NAME).collection("user");
        collection.find({ username: username }).toArray(function (err: any, data: any) {
            if (err) {
                res.status(500).send({ res: "Errore esecuzione query\n" + JSON.stringify(err) });
            } else {
                cache.set("user-usn=" + username, cachedData, 600);
                res.send(data);
            }
            next();
        });
    }
}

export function takeUserById(req: any, res: any, cache: any, next) {
    let cachedData = cache.get("user-id=" + req.query.id);

    if (cachedData) {
        cache.set("user-id=" + req.query.id, cachedData, 600);
        res.send(cachedData).status(200);
        next();
    }
    else {
        let collection = req["connessione"].db(DB_NAME).collection("user");
        let id = req.query.id;

        collection.find({ _id: new ObjectId(id) }).toArray(function (err: any, data: any) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            } else {
                cache.set("user-id=" + req.query.id, data, 600);
                res.send(data);
            }
            next();
        });
    }
}

export function fromIdToUsername(req: any, res: any, cache: any, next) {
    let ausId = [];
    for (let item of req.body.id) {
        ausId.push(new ObjectId(item));
    }

    let collection = req["connessione"].db(DB_NAME).collection("user");
    collection.find({ _id: { $in: ausId } }).toArray(function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.send(data);
        }
        next();
    });
}

export function registerUser(req: any, res: any, next) {
    let collection2 = req["connessione"].db(DB_NAME).collection("user");
    collection2.find({ username: req.body.username }).toArray(function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
            console.log("Errore esecuzione query 1");
            next();
        } else {
            if (data.length != 0) {
                res.status(202).send("Username già in uso");
            } else {
                let collection = req["connessione"].db(DB_NAME).collection("user");
                collection.insertOne(req.body, function (err: any, data: any) {
                    if (err) {
                        res.status(500).send("Errore esecuzione query");
                        console.log("Errore esecuzione query 2\n", err);
                    } else {
                        res.status(200).send(data);
                    }
                    next();
                });
            }
        }

    });
}

export function takeTravelsNum(req: any, res: any, cache: NodeCache, next) {
    let username = req.query.username;
    let cachedData = cache.get("travelsNum-id=" + username);
    if (cachedData) {
        cache.set("travelsNum-id=" + username, cachedData, 600);
        res.send(cachedData).status(200);
        next();
    }
    else {
        let collection = req["connessione"].db(DB_NAME).collection("travels");
        collection.find({ "participants": { "$elemMatch": { "username": username, "creator": true } } }, { "participants.$": 1 }).toArray(function (err: any, data: any) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            } else {
                cache.set("travelsNum-id=" + username, { count: data.length.toString() }, 600);
                res.send({ count: data.length.toString() }).status(200);
            }
            next();
        });
    }
}

export function login(req: any, res: any, cache: NodeCache, next) {
    let collection = req["connessione"].db(DB_NAME).collection("user");
    collection.find({ username: req.body.username }).toArray(function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
            next();
        } else {
            if (data.length == 0) {
                res.status(202).send("Utente non trovato");
            } else {
                if (data[0].password == req.body.password) {
                    res.status(200).send(data);
                } else {
                    res.status(201).send("Password errata");
                }
                next();
            }
        }
    });
}

export function userTravels(req: any, res: any, cache: NodeCache, next) {
    let username = req.query.username;
    let cachedData = cache.get("userTravels-usn=" + username);
    if (cachedData) {
        cache.set("userTravels-usn=" + username, cachedData, 600);
        res.send(cachedData).status(200);
        next();
    }
    let collection = req["connessione"].db(DB_NAME).collection("travels");
    collection.find({ creator: username }).toArray(function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        }
        else {
            cache.set("userTravels-usn=" + username, data, 600);
            res.status(200).send(data);
        }
        next();
    });
}

export function searchUser(req: any, res: any, cache: any, next) {
    let username = req.query.username;
    let cachedData = cache.get("usr-search-keys=" + username);
    if (cachedData) {
        cache.set("usr-search-keys=" + username, cachedData, 100);
        res.send(cachedData).status(200);
        next();
    }
    else {
        let collection = req["connessione"].db(DB_NAME).collection("user");
        const regex = new RegExp(username, 'i');
        collection.find({ $or: [{ username: { $regex: regex } }, { name: { $regex: regex } }, { surname: { $regex: regex } }] }).limit(3).toArray(function (err: any, data: any) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            }
            else {
                cache.set("usr-search-keys=", data, 100);
                res.status(200).send(data);
            }
            next();
        });
    }
}

export function setUserNotifToken(req, res, cache, next) {
    console.log("ARRIVATO")
    req["connessione"].db(DB_NAME).collection("user").findOne({ _id: new ObjectId(req.body.userid) },
        async (err: any, data: any) => {
            if (!err) {
                let notifTokenArr: any = data.notifToken;
                if (!notifTokenArr) {
                    notifTokenArr = [req.body.notifToken];
                }
                else {
                    notifTokenArr = [...notifTokenArr, req.body.notifToken];
                }

                req["connessione"].db(DB_NAME).collection("user").updateOne(
                    { _id: new ObjectId(req.body.userid) },
                    { $set: { notifToken: notifTokenArr } },
                    function (err: any, data: any) {
                        if (err) {
                            res.send(err).status(500);
                            console.error(err);
                        } else {
                            res.send({ updated: true, token: notifTokenArr }).status(200);
                        }
                        next();
                    });

            } else {
                res.send(err).status(500);
                next();
            }
        }
    )
}

export function verifyToken(req, res, cache, next) {
    req["connessione"].db(DB_NAME).collection("user").findOne({ _id: new ObjectId(req.body.userid) }, (response) => {
        if (response.notifToken.includes(req.body.notificationToken)) {
            console.log('Presente!');
            res.send({ is: true }).status(200);
            next();
        }
        else {
            req["connessione"].db(DB_NAME).collection("user").updateOne(
                { _id: new ObjectId(req.body.userid) },
                { $set: { notifToken: req.body.notificationToken } },
                function (err: any, data: any) {
                    if (err) {
                        console.error(err);
                        res.send(err).status(500);
                    } else {
                        res.send({ is: false, updated: true }).status(200);
                    }
                    next();
                });
        }
    })
}