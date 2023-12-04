import { Expo } from 'expo-server-sdk';
import fs from "fs";
import { ObjectId } from "mongodb";
import { DB_NAME } from "../server";

let expo = new Expo();

/* 

-----------
Cached data
-----------
"latest-post=" + user_id -> Ultimi post per ogni utente (Da rimuovere, rischio di incongruenze) 
"travel-post=" + travel_id -> Post relativi ad un viaggio 

*/

export function createPost(req, res, cache, next) {
    let collection = req["connessione"].db(DB_NAME).collection("posts");
    let param = req.body.param;
    try {
        param.travel = new ObjectId(param.travel);
        param.creator = new ObjectId(param.creator);
    } catch (ex) {
        console.error('Incorrect data format')
    }
    param.dateTime = new Date();
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

export async function takePosts(req, res, cache, next) {
    let travel = req.query.travel;
    let cachedData = cache.get("travel-post=" + travel);
    if (cachedData) {
        res.send(cachedData).status(200)
        cache.set("travel-post=" + travel, cachedData, 600);
        next();
    }
    else {
        req["connessione"].db(DB_NAME).collection("posts").aggregate([
            {
                $lookup:
                {
                    from: 'user',
                    localField: 'creator',
                    foreignField: '_id',
                    as: 'creatorData',
                },
            },
            {
                $sort: {
                    dateTime: -1
                }
            },
            {
                $project:
                {
                    "creatorData.email": false,
                    "creatorData.notifToken": false,
                    "creatorData.password": false,
                }
            },
            {
                $match:
                {
                    "travel": new ObjectId(travel)
                }
            }
        ])
            .toArray((err, response) => {
                if (err) throw err;
                res.send(response).status(200);
                cache.set("travel-post=" + travel, response)
                next();
            })
    }
}

export function updateVote(req, res, cache, next) {
    let id = req.body.id;
    let vote = req.body.vote;

    req["connessione"].db(DB_NAME).collection("posts").updateOne({ _id: new ObjectId(id) }, { $set: { votes: vote } }, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.status(200).send(data);
            cache.del("travel-post=" + req.body.travelid);
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
                ausData.push(item._id);
                ausName.push(item.name);
            }

            req["connessione"].db(DB_NAME).collection("posts").aggregate([
                {
                    $lookup:
                    {
                        from: 'user',
                        localField: 'creator',
                        foreignField: '_id',
                        as: 'creatorData',
                    },
                },
                {
                    $match:
                    {
                        travel: { $in: ausData }
                    }
                },
                {
                    $sort: {
                        dateTime: -1
                    }
                },
                {
                    $limit: 10
                },
                {
                    $project:
                    {
                        "creatorData.email": false,
                        "creatorData.notifToken": false,
                        "creatorData.password": false,
                    }
                }
            ])
                .toArray((err, response) => {
                    if (err) throw err;
                    let otherData = {}
                    for (let item in ausData) {
                        otherData[ausData[item]] = ausName[item];
                    }
                    res.status(200).send([response, otherData]);
                    next();
                })
        }
    });
}

export function updatePayment(req, res, cache, next) {
    let id = req.body.id;
    let destinator = req.body.destinator;
    req["connessione"].db(DB_NAME).collection("posts").updateOne({ _id: new ObjectId(id) }, { $set: { destinator: destinator } }, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.status(200).send(data);
            cache.del("travel-post=" + req.body.travelid);
        }
        next();
    });
}

export function updatePinPost(req, res, cache, next) {
    let id = req.body.param._id;
    let pinned = req.body.param.pinned;
    let collection = req["connessione"].db(DB_NAME).collection("posts");
    collection.updateOne({ _id: new ObjectId(id) }, { $set: { "pinned": pinned } }, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.status(200).send(data);
            cache.del("travel-post=" + req.body.param.travel);
        }
        next();
    });
}

export function deletePost(req, res, cache, next) {
    let id = req.body.id;
    req["connessione"].db(DB_NAME).collection("posts").findOne({ _id: new ObjectId(id) }, function (err: any, data: any) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
            next();
        } else {
            if (data) {
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
            }

            req["connessione"].db(DB_NAME).collection("posts").deleteOne({ _id: new ObjectId(id) }, function (err: any, data: any) {
                if (err) {
                    res.status(500).send("Errore esecuzione query");
                } else {
                    res.status(200).send(data)
                    cache.del("travel-post=" + req.body.travel);
                }
                next();
            });
        }
    });
}