import { ObjectId } from "mongodb";
import NodeCache from "node-cache";
import { DB_NAME } from "../server";

export function takeUserInfo(req: any, res: any, next) {
    req["connessione"].db(DB_NAME).collection("user").find({ username: req.query.username }).toArray(function (err: any, data: any) {
        if (err) {
            res.status(500).send({ res: "Errore esecuzione query\n" + JSON.stringify(err) });
        } else {
            res.send(data);
        }
        next();
    });
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
        console.log(id)
        if (id) {
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
}

export function fromIdToUsername(req: any, res: any, cache: any, next) {
    let ausId = [];
    for (let item of req.body.id) {
        ausId.push(new ObjectId(item));
    }

    req["connessione"].db(DB_NAME).collection("user").find({ _id: { $in: ausId } }).toArray(function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.send(data);
        }
        next();
    });
}

export function registerUser(req: any, res: any, next) {
    req["connessione"].db(DB_NAME).collection("user").find({ username: req.body.username }).toArray(function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
            console.log("Errore esecuzione query 1");
            next();
        } else {
            if (data.length != 0) {
                res.status(202).send("Username già in uso");
            } else {
                req["connessione"].db(DB_NAME).collection("user").insertOne(req.body, function (err: any, data: any) {
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
    let userid = req.query.userid;
    let cachedData = cache.get("travelsNum-id=" + userid);
    if (cachedData) {
        cache.set("travelsNum-id=" + userid, cachedData, 600);
        res.send(cachedData).status(200);
        next();
    }
    else {
        req["connessione"].db(DB_NAME).collection("travels").countDocuments({ "participants": { "$elemMatch": { "userid": userid, "creator": true } } }, { "participants.$": 1 }).then(function (data: any) {
            cache.set("travelsNum-id=" + userid, { count: data }, 600);
            res.send({ count: data }).status(200);
            next();
        })
            .catch((ex) => {
                console.log(ex);
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
    console.log(req.body)
    req["connessione"].db(DB_NAME).collection("user").findOne({ _id: new ObjectId(req.body.userid) }, (err, response) => {
        if (!err) {
            let include = false;
            try {
                include = response.notifToken.includes(req.body.notificationToken);
            } catch (ex) {
                include = false;
                response.notifToken = []
            }
            if (include) {
                res.send({ is: true }).status(200);
                next();
            }
            else {
                let notifTokenArr: any = response.notifToken;
                notifTokenArr = [...notifTokenArr, req.body.notificationToken];
                req["connessione"].db(DB_NAME).collection("user").updateOne(
                    { _id: new ObjectId(req.body.userid) },
                    { $set: { notifToken: notifTokenArr } },
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
        }
        else {
            console.error(err);
            res.send(err).status(500);
            next();
        }
    })
}