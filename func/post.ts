import { ObjectId } from "mongodb";
import NodeCache from "node-cache";
import { DB_NAME } from "../server";
import fs from "fs";
import axios from "axios";
import { Expo } from 'expo-server-sdk';

let expo = new Expo();

export function createPost(req, res, cache, next) {
    let collection = req["connessione"].db(DB_NAME).collection("posts");
    let param = req.body.param;
    console.log("Entrato 1")
    param.dateTime = new Date();
    console.log("Entrato 2")
    collection.insertOne(param, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
            next();
        } else {
            req["connessione"].db(DB_NAME).collection('travels').findOne({ _id: new ObjectId(param.travel) }, (err: any, data: any) => {
                let part = [];
                for (let item of data.participants) {
                    part = [...part, item.userid];
                    req["connessione"].db(DB_NAME).collection('user').findOne({ _id: new ObjectId(item.userid) }, async (err: any, data2: any) => {
                        let messages = [];
                        for (let item of data2.notifToken) {
                            if (!Expo.isExpoPushToken(item)) {
                                console.error(`Push token ${item} is not a valid Expo push token`);
                                continue;
                            }

                            messages.push({
                                to: item,
                                sound: 'default',
                                body: param.creator + ' ha pubblicato qualcosa! 🪁🪁',
                                data: { withSome: 'data' },
                            })

                            let chunks = expo.chunkPushNotifications(messages);
                            let tickets = [];
                            (async () => {
                                // Send the chunks to the Expo push notification service. There are
                                // different strategies you could use. A simple one is to send one chunk at a
                                // time, which nicely spreads the load out over time:
                                for (let chunk of chunks) {
                                    try {
                                        let ticketChunk = await expo.sendPushNotificationsAsync(chunk);
                                        console.log(ticketChunk);
                                        tickets.push(...ticketChunk);
                                        // NOTE: If a ticket contains an error code in ticket.details.error, you
                                        // must handle it appropriately. The error codes are listed in the Expo
                                        // documentation:
                                        // https://docs.expo.io/push-notifications/sending-notifications/#individual-errors
                                    } catch (error) {
                                        console.error(error);
                                    }
                                }
                            })();

                        }
                        res.status(200).send(data);
                    })
                }
            })

        }
        cache.del("travel-post=" + param.travel);
    });
}

export function takePosts(req, res, cache, next) {
    let travel = req.query.travel;
    let cachedData = cache.get("travel-post=" + travel);
    if (cachedData) {
        res.send(cachedData).status(200)
        cache.set("travel-post=" + travel, cachedData, 600);
        next();
    }
    else {
        let collection = req["connessione"].db(DB_NAME).collection("posts");
        collection.find({ travel: travel }).sort({ dateTime: -1 }).toArray(function (err: any, data: any) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            }
            else {
                cache.set("travel-post=" + travel, data, 600);
                res.status(200).send(data);
            }
            next();
        });
    }
}

export function updateVote(req, res, next) {
    let id = req.body.id;
    let vote = req.body.vote;

    let collection = req["connessione"].db(DB_NAME).collection("posts");
    collection.updateOne({ _id: new ObjectId(id) }, { $set: { votes: vote } }, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.status(200).send(data);
        }
        next();
    });
}

export function takeLastsPostByUsername(req, res, cache, next) {
    let username = req.query.username;
    let userid = req.query.userid;
    req["connessione"].db(DB_NAME).collection("travels").find({ "participants.userid": userid, "participants.username": username }).toArray(function (err: any, data: any) {
        if (err) {
            console.log("Errore esecuzione query");
            res.status(500).send("Errore esecuzione query");
            next();
        }
        else {
            let ausData = [];
            let ausName = [];
            for (let item of data) {
                ausData.push(item._id.toString());
                ausName.push(item.name);
            }
            req["connessione"].db(DB_NAME).collection("posts").find({ travel: { $in: ausData } }).sort({ dateTime: -1 }).limit(10).toArray(function (err: any, data: any) {
                if (err) {
                    console.log("Errore esecuzione query 2");
                    console.log(err)
                    res.status(500).send("Errore esecuzione query");
                }
                else {
                    let otherData = {}
                    for (let item in ausData) {
                        otherData[ausData[item]] = ausName[item];
                    }

                    res.status(200).send([data, otherData]);
                }
                next();
            });
        }
    });
}

export function updatePayment(req, res, next) {
    let id = req.body.id;
    let destinator = req.body.destinator;
    req["connessione"].db(DB_NAME).collection("posts").updateOne({ _id: new ObjectId(id) }, { $set: { destinator: destinator } }, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.status(200).send(data);
        }
        next();
    });
}

export function updatePinPost(req, res, next) {
    let id = req.body.param._id;
    let pinned = req.body.param.pinned;

    let collection = req["connessione"].db(DB_NAME).collection("posts");
    collection.updateOne({ _id: new ObjectId(id) }, { $set: { "pinned": pinned } }, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            console.log("data: ", data);
            res.status(200).send(data);
        }
        next();
    });
}

export function deletePost(req, res, next) {
    let id = req.body.id;
    req["connessione"].db(DB_NAME).collection("posts").findOne({ _id: new ObjectId(id) }, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
            next();
        } else {
            if (typeof data.type != "undefined") {
                if (data.type == "images") {
                    let path = data.source;
                    for (let item of path) {
                        fs.unlink(item, (err) => {
                            if (err) {
                                console.error(err)
                                return
                            }
                        })
                    }
                }
            }

            req["connessione"].db(DB_NAME).collection("posts").deleteOne({ _id: new ObjectId(id) }, function (err: any, data: any) {
                if (err) {
                    res.status(500).send("Errore esecuzione query");
                } else {
                    res.status(200).send(data)
                }
                next();
            });
        }
    });
}