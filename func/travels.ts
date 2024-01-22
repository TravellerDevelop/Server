import { ObjectId } from "mongodb";
import NodeCache from "node-cache";
import { DB_NAME, mongoConnection } from "../server";
import fs from "fs";

export function createTravel(req: any, res: any, cache: any) {
    let collection = mongoConnection.db(DB_NAME).collection("travels");
    let param: any = req.body;
    param.creation_date = new Date(param.creation_date);

    let i = 0;

    while (i < param.participants.length) {
        param.participants[i].userid = new ObjectId(param.participants[i].userid);
        i++;
    }

    collection.insertOne(param, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.status(200).send(data);
        }
    });
}

export function joinTravel(req: any, res: any, cache: NodeCache, next) {
    let collection = mongoConnection.db(DB_NAME).collection("travels");
    let error = false;
    collection.find({ code: req.body.code })
        .toArray(function (err: any, data: any) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
                error = true;
                next();
            } else {
                if (data.length == 1) {
                    if (data[0].creator == req.body.username) {
                        res.status(201).send("Non puoi iscriverti al tuo viaggio");
                        error = true;
                    } else {
                        for (let item of data[0].participants) {
                            if (item.userid == req.body.userid) {
                                res.status(202).send("Sei già iscritto a questo viaggio");
                                error = true;
                            }
                        }

                        if (data[0].participants.includes({ userid: req.body.userid, username: req.body.username })) {
                            res.status(202).send("Sei già iscritto a questo viaggio");
                            error = true;
                        } else {
                            if (data[0].new_members_allowed == "0") {
                                res.status(203).send("Non puoi iscriverti a questo viaggio");
                                error = true;
                            }
                            else {
                                if (!error) {
                                    collection.updateOne({ code: req.body.code }, { $push: { participants: { userid: new ObjectId(req.body.userid) } } }, function (err: any, data: any) {
                                        if (err) {
                                            res.status(500).send("Errore esecuzione query");
                                        } else {
                                            res.status(200).send(data);
                                        }
                                        next();
                                    });
                                }
                            }
                        }
                    }
                } else {
                    res.status(201).send("Codice viaggio non valido");
                    error = true;
                    next();
                }
            }
        });
}

export function takeJoinedTravels(req: any, res: any, cache: any, next) {
    let username = req.query.username;
    let cachedData = cache.get("joined-usn=" + username);
    let userid = req.query.userid
    if (cachedData) {
        cache.set("joined-id=" + userid, cachedData, 100);
        res.send(cachedData).status(200);
        next();
    } else {
        mongoConnection.db(DB_NAME).collection("travels").find({ "participants.userid": new ObjectId(userid), closed: false }).sort({ creation_date: -1 }).toArray(function (err: any, data: any) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            }
            else {
                cache.set("joined-id=" + userid, data, 100);
                res.status(200).send(data);
            }
            next();
        });
    }
}

export function takeTravelsParticipants(req: any, res: any, cache: any) {
    let travel = req.query.travel;
    let cachedData = cache.get("takeParticipants=" + travel);
    if (cachedData) {
        cache.set("takeParticipants=" + travel, cachedData, 600);
        res.send(cachedData).status(200);
    } else {
        mongoConnection.db(DB_NAME).collection("travels").aggregate([
            { $match: { _id: new ObjectId(travel) } },
            { $unwind: "$participants" },
            {
                $lookup: {
                    from: "user",
                    localField: "participants.userid",
                    foreignField: "_id",
                    as: "participants"
                }
            },
            { $unwind: "$participants" },
            {
                $project: {
                    _id: "$participants._id",
                    username: "$participants.username",
                    name: "$participants.name",
                    surname: "$participants.surname",
                }
            }
        ]).toArray(function (err: any, data: any) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            }
            else {
                cache.set("takeParticipants=" + travel, data, 600);
                res.status(200).send(data);
            }
        });
    }
}

export function takeTravelByCreator(req: any, res: any, cache: any, next) {
    let userid = req.query.userid;
    let cachedData = cache.get("takeByCreator=" + userid);
    if (cachedData) {
        cache.set("takeByCreator=" + userid, cachedData, 600);
        res.send(cachedData).status(200);
    } else {
        mongoConnection.db(DB_NAME).collection("travels")
        .find({ "participants": { "$elemMatch": { userid: new ObjectId(userid), creator: true } } }, { "participants.$": 1 }).sort({ creation_date: -1 })
        .toArray(function (err: any, data: any) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            }
            else {
                cache.set("takeByCreator=" + userid, data, 600);
                res.status(200).send(data);
            }
        });
    }
}

export function updateTravel(req: any, res: any, next) {
    let param = req.body.param;
    let id = req.body.id;

    mongoConnection.db(DB_NAME).collection("travels").updateOne({ _id: new ObjectId(id) }, { $set: { name: param.name, description: param.description, budget: param.budget } }, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query 1");
        }
        else {
            res.status(200).send(data);
        }
        next();
    });
}

export function closeTravel(req: any, res: any, next) {
    let id = req.body.id;
    mongoConnection.db(DB_NAME).collection("travels").updateOne({ _id: new ObjectId(id) }, { $set: { closed: true } }, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query 1");
        }
        else { res.status(200).send(data); }
        next();
    });
}

export function deleteTravel(req: any, res: any, next) {
    let id = req.body.id;
    mongoConnection.db(DB_NAME).collection("travels").find({ _id: new ObjectId(id) }).toArray(function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query 1");
            next();
        }
        else {
            if (data[0].image) {
                fs.unlink("./static/userImage/" + data[0].image, (err: any) => {
                    if (err) {
                        console.log("Errore eliminazione immagine");
                        next();
                    }
                });
            }
            mongoConnection.db(DB_NAME).collection("travels").deleteOne({ _id: new ObjectId(id) }, function (err: any, data: any) {
                if (err) {
                    res.status(500).send("Errore esecuzione query 1");
                    next();
                }
                else {
                    mongoConnection.db(DB_NAME).collection("posts").deleteMany({ travel: id }, function (err: any, data: any) {
                        if (err) {
                            res.status(500).send("Errore esecuzione query 1");
                        }
                        else {
                            res.status(200).send(data);
                        }
                        next();
                    })
                }
            });
        }
    });
}

export function leaveTravel(req: any, res: any, cache: any, next) {
    let travel = req.body.travel;
    let userid = req.body.userid;

    mongoConnection.db(DB_NAME).collection("travels").findOne({ _id: new ObjectId(travel) }, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query 1");
            next();
        }
        else {
            if (data.participants.length == 1) {
                mongoConnection.db(DB_NAME).collection("travels").deleteOne({ _id: new ObjectId(travel) }, function (err: any, data: any) {
                    if (err) {
                        res.status(500).send("Errore esecuzione query 1");
                        next();
                    }
                    else {
                        mongoConnection.db(DB_NAME).collection("posts").deleteMany({ travel: travel }, function (err: any, data: any) {
                            if (err) {
                                res.status(500).send("Errore esecuzione query 1");
                            }
                            else {
                                res.status(200).send(data);
                            }
                            next();
                        })
                    }
                });
            }
            else {
                let aus = data.participants.filter((item: any) => item.userid != userid);
                mongoConnection.db(DB_NAME).collection("travels").updateOne({ _id: new ObjectId(travel) }, { $set: { participants: aus } }, function (err: any, data: any) {
                    if (err) {
                        res.status(500).send("Errore esecuzione query 1");
                    }
                    else {
                        res.status(200).send(data);
                    }
                    next();
                });
            }
        }
    });
}

export function uploadImage(req: any, res: any, next) {
    let img = req.body.img;
    let imgName = req.body.imgName;
    let newName = Math.random().toString(36).substring(2, 20) + Math.random().toString(36).substring(2, 20);
    let aus = imgName.split(".");
    let ext = aus[aus.length - 1];
    let buffer = Buffer.from(img.replace(/^data:image\/\w+;base64,/, ""), "base64");
    fs.writeFile("./static/userImage/" + newName + "." + ext, buffer, (err: any) => {
        if (err) {
            res.status(500);
            res.send(err.message);
            console.log(err.message);
        }
        else {
            res.status(200);
            res.send(newName + "." + ext);
        }
        next();
    });
}