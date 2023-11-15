"use strict";

import http from "http";
import url from "url";
import fs from "fs";
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";
import express from "express"; // @types/express
import cors from "cors"; // @types/cors
import { Server, Socket } from "socket.io";
import calculateResponseTimeMiddleware from "./util/responseTime";
import { takeVersion, verifyConnection } from "./util/tests";
import { fromIdToUsername, login, registerUser, takeTravelsNum, takeUserById, takeUserInfo, userTravels } from "./func/user";
const NodeCache = require("node-cache");

dotenv.config({ path: ".env" });

const cache = new NodeCache({ stdTTL: 0, checkperiod: 120 });
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 1337;
export const DB_NAME = "traveller";
const connectionString: any = process.env.connectionString;
const fileupload = require('express-fileupload');
const socket: any = [];
const ISDEBUG = true;

//CREAZIONE E AVVIO DEL SERVER HTTP
let server = http.createServer(app);
let paginaErrore: string = "";

server.listen(PORT, () => {
  init();
  console.log("Server in ascolto sulla porta " + PORT);
});

function init() {
  fs.readFile("./static/error.html", (err: any, data: any) => {
    if (err) {
      paginaErrore = "<h2>Risorsa non trovata</h2>";
    } else {
      paginaErrore = data.toString();
    }
  });
}

/***********MIDDLEWARE****************/
app.use("/", (req: any, res: any, next: any) => {
  if (ISDEBUG) {
    console.log(req.method + ": " + req.originalUrl);
  }
  next();
});

app.use("/", express.static("./static"));

app.use("/", express.json({ limit: "50mb" }));
app.use("/", express.urlencoded({ limit: "50mb", extended: true }));

app.use("/", (req: any, res: any, next: any) => {
  if (ISDEBUG) {
    calculateResponseTimeMiddleware(req, res, next)
  }
});

app.use("/", cors({
  origin: function (origin: any, callback: any) {
    return callback(null, true);
  },
  credentials: true,
}));

app.set("json spaces", 4);

app.use("/api/", function (req: any, res: any, next) {
  let connection = new MongoClient(connectionString);
  connection
    .connect()
    .then((client: any) => {
      req["connessione"] = client;
      next();
    })
    .catch((err: any) => {
      let msg = "Errore di connessione al db";
      res.status(503).send(msg);
    });
});

app.use(fileupload({
  "limits ": { "fileSize ": (20 * 1024 * 1024) } // 20 MB
}));

/* UTILITY */
app.get("/api/verifyConnection", function (req: any, res: any) { verifyConnection(req, res); });
app.get("/api/takeVersion", function (req: any, res: any) { takeVersion(req, res, cache) });

/***********USER LISTENER****************/
app.get("/api/user/info", function (req: any, res: any) { takeUserInfo(req, res, cache); });
app.get("/api/user/takeUserById", function (req: any, res: any) { takeUserById(req, res, cache); });
app.post("/api/user/fromIdToUsernames", function (req: any, res: any) { fromIdToUsername(req, res, cache); });
app.post("/api/user/register", function (req: any, res: any) { registerUser(req, res); });
app.get("/api/user/takeTravelsNum", function (req: any, res: any) { takeTravelsNum(req, res, cache); });
app.post("/api/user/login", function (req: any, res: any) { login(req, res, cache); });
app.get("/api/user/travels", function (req: any, res: any) { userTravels(req, res, cache); });

app.get("/api/user/search", function (req: any, res: any) {
  let username = req.query.username;
  let cachedData = cache.get("usr-search-keys=" + username);
  if (cachedData) {
    cache.set("usr-search-keys=" + username, cachedData, 100);
    res.send(cachedData).status(200);
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

      req["connessione"].close();
    });
  }
});

// GESTIONE TRAVELS
app.post("/api/travel/create", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  let param: any = req.body;
  param.creation_date = new Date(param.creation_date);

  collection.insertOne(param, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

app.post("/api/travel/join", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  let error = false;
  collection.find({ code: req.body.code })
    .toArray(function (err: any, data: any) {
      if (err) {
        res.status(500).send("Errore esecuzione query");
        req["connessione"].close();
        error = true;
      } else {
        if (data.length == 1) {
          if (data[0].creator == req.body.username) {
            res.status(201).send("Non puoi iscriverti al tuo viaggio");
            req["connessione"].close();
            error = true;
          } else {
            for (let item of data[0].participants) {
              if (item.userid == req.body.userid) {
                res.status(202).send("Sei già iscritto a questo viaggio");
                req["connessione"].close();
                error = true;
              }
            }

            if (data[0].participants.includes({ userid: req.body.userid, username: req.body.username })) {
              res.status(202).send("Sei già iscritto a questo viaggio");
              req["connessione"].close();
              error = true;
            } else {
              if (data[0].new_members_allowed == "0") {
                req["connessione"].close();
                res.status(203).send("Non puoi iscriverti a questo viaggio");
                error = true;
              }
              else {
                if (!error) {
                  collection.updateOne({ code: req.body.code }, { $push: { participants: { userid: req.body.userid, username: req.body.username } } }, function (err: any, data: any) {
                    if (err) {
                      res.status(500).send("Errore esecuzione query");
                    } else {
                      res.status(200).send(data);
                    }
                    req["connessione"].close();
                  });
                }
              }
            }
          }
        } else {
          res.status(201).send("Codice viaggio non valido");
          error = true;
          req["connessione"].close();
        }
      }

    });
});

app.get("/api/travel/takeJoined", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  let username = req.query.username;
  let cachedData = cache.get("joined-usn=" + username);
  let userid = req.query.userid
  if (cachedData) {
    cache.set("joined-id=" + userid, cachedData, 100);
    res.send(cachedData).status(200);
  } else {
    collection.find({ "participants.userid": userid, "participants.username": username, closed: false }).sort({ creation_date: -1 }).toArray(function (err: any, data: any) {
      if (err) {
        res.status(500).send("Errore esecuzione query");
      }
      else {
        cache.set("joined-id=" + userid, data, 100);
        res.status(200).send(data);
      }

      req["connessione"].close();
    });
  }
});

app.get("/api/travel/takeParticipants", function (req: any, res: any) {
  let travel = req.query.travel;
  let cachedData = cache.get("takeParticipants=" + travel);
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  if (cachedData) {
    cache.set("takeParticipants=" + travel, cachedData, 600);
    res.send(cachedData).status(200);
  } else {
    collection.find({ code: travel }).toArray(function (err: any, data: any) {
      if (err) {
        res.status(500).send("Errore esecuzione query");
      }
      else {
        let participants = [];

        for (let item of data[0].participants) {
          participants.push(item.username);
        }

        let collection2 = req["connessione"].db(DB_NAME).collection("user");
        collection2.find({ username: { $in: participants } }).toArray(function (err: any, data: any) {
          if (err) {
            res.status(500).send("Errore esecuzione query");
          }
          else {
            cache.set("takeParticipants=" + travel, data, 600);
            res.status(200).send(data);
          }
          req["connessione"].close();
        });
      }
    });
  }
});

app.get("/api/travel/takeByCreator", function (req: any, res: any) {
  let username = req.query.username;
  let cachedData = cache.get("takeByCreator=" + username);
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  if (cachedData) {
    cache.set("takeByCreator=" + username, cachedData, 600);
    res.send(cachedData).status(200);
  } else {
    collection.find({ "participants": { "$elemMatch": { "username": username, "creator": true } } }, { "participants.$": 1 }).sort({ creation_date: -1 }).toArray(function (err: any, data: any) {
      if (err) {
        res.status(500).send("Errore esecuzione query");
      }
      else {
        cache.set("takeByCreator=" + username, data, 600);
        res.status(200).send(data);
      }

      req["connessione"].close();
    });
  }
});

app.post("/api/travel/update", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  let param = req.body.param;
  let id = req.body.id;

  collection.updateOne({ _id: new ObjectId(id) }, { $set: { name: param.name, description: param.description, budget: param.budget } }, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query 1");
    }
    else {
      res.status(200).send(data);
    }
    req["connessione"].close();
  });
});

app.post("/api/travel/close", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  let id = req.body.id;

  collection.updateOne({ _id: new ObjectId(id) }, { $set: { closed: true } }, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query 1");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

app.post("/api/travel/delete", function (req: any, res: any, next) {
  let collection0 = req["connessione"].db(DB_NAME).collection("travels");
  let id = req.body.id;
  console.log(id)

  collection0.find({ _id: new ObjectId(id) }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query 1");
    }
    else {
      if (data[0].image) {
        fs.unlink("./static/userImage/" + data[0].image, (err: any) => {
          if (err) {
            console.log("Errore eliminazione immagine");
          }
        });
      }
      let collection = req["connessione"].db(DB_NAME).collection("travels");
      collection.deleteOne({ _id: new ObjectId(id) }, function (err: any, data: any) {
        if (err) {
          res.status(500).send("Errore esecuzione query 1");
        }
        else {
          let collection2 = req["connessione"].db(DB_NAME).collection("posts");

          collection2.deleteMany({ travel: id }, function (err: any, data: any) {
            if (err) {
              res.status(500).send("Errore esecuzione query 1");
            }
            else {
              res.status(200).send(data);
            }

            req["connessione"].close();
          })
        }
      });
    }
  });
});

app.post("/api/travel/leave", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  let travel = req.body.travel;
  let userid = req.body.userid;

  collection.findOne({ _id: new ObjectId(travel) }, function (err: any, data: any) {
    if (err) {
      req["connessione"].close();
      res.status(500).send("Errore esecuzione query 1");
    }
    else {
      if (data.participants.length == 1) {
        collection.deleteOne({ _id: new ObjectId(travel) }, function (err: any, data: any) {
          if (err) {
            res.status(500).send("Errore esecuzione query 1");
          }
          else {
            let collection2 = req["connessione"].db(DB_NAME).collection("posts");

            collection2.deleteMany({ travel: travel }, function (err: any, data: any) {
              if (err) {
                res.status(500).send("Errore esecuzione query 1");
              }
              else {
                res.status(200).send(data);
              }

              req["connessione"].close();
            })
          }
        });
      }
      else {
        let aus = data.participants.filter((item: any) => item.userid != userid);

        collection.updateOne({ _id: new ObjectId(travel) }, { $set: { participants: aus } }, function (err: any, data: any) {
          if (err) {
            res.status(500).send("Errore esecuzione query 1");
          }
          else {
            res.status(200).send(data);
          }

          req["connessione"].close();
        });
      }
    }
  });
});

app.post('/api/travel/uploadImage', function (req, res, next) {
  let img = req.body.img;
  let imgName = req.body.imgName;

  let newName = Math.random().toString(36).substring(2, 20) + Math.random().toString(36).substring(2, 20);

  let aus = imgName.split(".");
  let ext = aus[aus.length - 1];

  let imgData = img.replace(/^data:image\/\w+;base64,/, "");
  let buffer = Buffer.from(imgData, "base64");
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
  });
})

// GESTIONE DEI POST
app.post("/api/post/create", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("posts");

  let param = req.body.param;
  param.dateTime = new Date();

  collection.insertOne(param, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

app.get("/api/post/take", function (req: any, res: any) {
  let travel = req.query.travel;
  let cachedData = cache.get("travel-post="+travel);
  if(cachedData){
    res.send(cachedData).status(200)
    cache.set("travel-post="+travel, cachedData, 600);
  }
  else{
    let collection = req["connessione"].db(DB_NAME).collection("posts");
    collection.find({ travel: travel }).sort({ dateTime: -1 }).toArray(function (err: any, data: any) {
      if (err) {
        res.status(500).send("Errore esecuzione query");
      }
      else {
        cache.set("travel-post="+travel, data, 600);
        res.status(200).send(data);
      }
  
      req["connessione"].close();
    });
  }
});

app.post("/api/post/updateVote", function (req: any, res: any, next) {
  let id = req.body.id;
  let vote = req.body.vote;

  let collection = req["connessione"].db(DB_NAME).collection("posts");
  collection.updateOne({ _id: new ObjectId(id) }, { $set: { votes: vote } }, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

app.get("/api/post/takeLastsByUsername", function (req: any, res: any, next) {
  let collection2 = req["connessione"].db(DB_NAME).collection("travels");
  let username = req.query.username;
  let userid = req.query.userid;

  collection2.find({ "participants.userid": userid, "participants.username": username }).toArray(function (err: any, data: any) {
    if (err) {
      console.log("Errore esecuzione query");
      res.status(500).send("Errore esecuzione query");
      req["connessione"].close();
    }
    else {
      let ausData = [];
      let ausName = [];
      for (let item of data) {
        ausData.push(item._id.toString());
        ausName.push(item.name);
      }

      let collection = req["connessione"].db(DB_NAME).collection("posts");
      collection.find({ travel: { $in: ausData } }).sort({ dateTime: -1 }).limit(10).toArray(function (err: any, data: any) {
        if (err) {
          console.log("Errore esecuzione query 2");
          console.log(err)
          res.status(500).send("Errore esecuzione query");
          req["connessione"].close();
        }
        else {
          let otherData = {}
          for (let item in ausData) {
            otherData[ausData[item]] = ausName[item];
          }

          res.status(200).send([data, otherData]);
          req["connessione"].close();
        }
      });
    }

  });
});

app.post("/api/post/updatePayment", function (req: any, res: any, next) {
  let id = req.body.id;
  let destinator = req.body.destinator;

  let collection = req["connessione"].db(DB_NAME).collection("posts");
  collection.updateOne({ _id: new ObjectId(id) }, { $set: { destinator: destinator } }, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

app.post("/api/post/updatePinPost", function (req: any, res: any, next) {
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

    req["connessione"].close();
  });
});

app.post("/api/post/deletePost", function (req: any, res: any, next) {
  let id = req.body.id;

  let collection0 = req["connessione"].db(DB_NAME).collection("posts");
  let collection = req["connessione"].db(DB_NAME).collection("posts");
  console.log("id: ", id);
  collection0.findOne({ _id: new ObjectId(id) }, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      console.log("data: ", data)
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

      collection.deleteOne({ _id: new ObjectId(id) }, function (err: any, data: any) {
        if (err) {
          res.status(500).send("Errore esecuzione query");
        } else {
          res.status(200).send(data);
        }

        req["connessione"].close();
      });
    }
  });
});

app.get("/api/post/takeTotalExpenses", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("posts");
  let userid = req.query.userid;
  collection.find({ type: "payments", "destinator.userid": userid }).toArray(function (err: any, data: any) {
    if (err) {
      console.log("Errore esecuzione query");
      res.status(500).send("Errore esecuzione query");
      req["connessione"].close();
    }
    else {
      let tot = 0;
      for (let item of data) {
        tot += item.amount;
      }

      res.status(200).send(tot.toString());
      req["connessione"].close();
    }

  });
});

app.get("/api/post/takeTotalToPay", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("posts");
  let userid = req.query.userid;
  collection.find({ destinator: { $elemMatch: { userid: userid, payed: false } } }).toArray(function (err: any, data: any) {
    if (err) {
      console.log("Errore esecuzione query");
      res.status(500).send("Errore esecuzione query");
      req["connessione"].close();
    }
    else {
      let sum = 0;
      for (let item of data) {
        sum += item.amount;
      }

      res.status(200).send(sum.toString());
      req["connessione"].close();
    }
  });
});

app.get("/api/post/takeTotalToReceive", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("posts");
  let username = req.query.username;
  let userid = req.query.userid;
  collection.find({ creator: username, type: "payments" }).toArray(function (err: any, data: any) {
    if (err) {
      console.log("Errore esecuzione query");
      res.status(500).send("Errore esecuzione query");
      req["connessione"].close();
    }
    else {
      let sum = 0;

      console.log(data)
      for (let item of data) {
        for (let i of item.destinator) {
          if (i.payed === false && i.userid != userid) {
            sum += item.amount;
          }
        }
      }

      res.status(200).send(sum.toString());
      req["connessione"].close();
    }
  });
});

app.get("/api/post/takeTotalPayedByTravel", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("posts");

  let travel = req.query.travel;
  let userid = req.query.userid;

  collection.find({ travel: travel, "destinator.userid": userid, type: "payments" }).toArray(function (err: any, data: any) {
    if (err) {
      console.log("Errore esecuzione query");
      res.status(500).send("Errore esecuzione query");
      req["connessione"].close();
    }
    else {
      console.log(data)

      let sum = 0;
      for (let item of data) {
        sum += item.amount;
      }

      res.status(200).send(sum.toString());
      req["connessione"].close();
    }
  });
});

app.get("/api/post/takePayedGroupByTravel", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("posts");

  let userid = req.query.userid;

  collection.aggregate([
    { $match: { "destinator.userid": userid, type: "payments" } },
    { $unwind: "$destinator" },
    { $match: { "destinator.userid": userid, type: "payments" } },
    {
      $group: {
        _id: "$travel",
        total: { $sum: "$amount" }
      }
    }
  ]).toArray(function (err: any, data: any) {
    if (err) {
      console.log("Errore esecuzione query");
      res.status(500).send("Errore esecuzione query");
      req["connessione"].close();
    }
    else {
      let collection2 = req["connessione"].db(DB_NAME).collection("travels");

      collection2.find({ _id: { $in: data.map((item: any) => new ObjectId(item._id)) } }).toArray(function (err: any, data2: any) {
        if (err) {
          console.log("Errore esecuzione query");
          res.status(500).send("Errore esecuzione query");
          req["connessione"].close();
        }
        else {
          let ausData = [];
          for (let item of data2) {
            ausData.push({ name: item.name, total: data.filter((item2: any) => item2._id == item._id)[0].total });
          }

          res.status(200).send(ausData);
          req["connessione"].close();
        }
      });
    }
  });
});

app.post("/api/post/addImage", function (req: any, res: any, next) {
  let img = req.body.img;
  let imgName = req.body.name;

  let newName = Math.random().toString(36).substring(2, 20) + Math.random().toString(36).substring(2, 20) + Math.random().toString(36).substring(2, 20);

  let aus = imgName.split(".");
  let ext = aus[aus.length - 1];

  let imgData = img.replace(/^data:image\/\w+;base64,/, "");
  let buffer = Buffer.from(imgData, "base64");
  fs.writeFile("./static/userImage/posts/" + newName + "." + ext, buffer, (err: any) => {
    if (err) {
      res.status(500);
      res.send(err.message);
      console.log(err.message);
    }
    else {
      res.status(200);
      res.send(newName + "." + ext);
    }
  });

});

app.post("/api/post/updateToDo", function (req: any, res: any) {
  let collection = req["connessione"].db(DB_NAME).collection("posts");

  collection.updateOne({ _id: new ObjectId(req.body.id) }, { $set: { items: req.body.items } }, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore aggiornamento item");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
})

// GESTIONE FOLLOW
app.post("/api/follow/create", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("follow");

  collection.insertOne({
    from: req.body.from,
    to: req.body.to,
    accepted: false,
  }, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

app.get("/api/follow/takeFromTo", function (req: any, res: any, next) {
  let from = req.query.from;
  let to = req.query.to;

  let collection = req["connessione"].db(DB_NAME).collection("follow");

  collection.find({ from: from, to: to }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  })
});

app.post("/api/follow/delete", function (req: any, res: any, next) {
  let from = req.body.from;
  let to = req.body.to;

  let collection = req["connessione"].db(DB_NAME).collection("follow");

  collection.deleteOne({ from: from, to: to }, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  })
});

app.get("/api/follow/takeFollowersRequest", function (req: any, res: any, next) {
  let to = req.query.to;

  let collection = req["connessione"].db(DB_NAME).collection("follow");
  collection.find({ to: to, accepted: false }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  })
});

app.post("/api/follow/accept", function (req: any, res: any, next) {
  let from = req.body.from;
  let to = req.body.to;

  let collection = req["connessione"].db(DB_NAME).collection("follow");

  collection.updateOne({ from: from, to: to }, { $set: { accepted: true } }, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  })
});

app.get("/api/follow/takeFollowers", function (req: any, res: any, next) {
  let to = req.query.to;

  let collection = req["connessione"].db(DB_NAME).collection("follow");
  collection.find({ to: to, accepted: true }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  })
});

app.get("/api/follow/takeFollowings", function (req: any, res: any, next) {
  let from = req.query.from;

  let collection = req["connessione"].db(DB_NAME).collection("follow");
  collection.find({ from: from, accepted: true }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  })
});

app.get("/api/follow/takeFollowingsWithInfo", function (req: any, res: any, next) {
  let from = req.query.from;

  let collection = req["connessione"].db(DB_NAME).collection("follow");
  collection.find({ from: from, accepted: true }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query 1");
    }
    else {
      let aus = [];
      for (let item of data) {
        aus.push(new ObjectId(item.to));
      }

      let collection2 = req["connessione"].db(DB_NAME).collection("user");
      collection2.find({ _id: { $in: aus } }).toArray(function (err: any, data: any) {
        if (err) {
          res.status(500).send("Errore esecuzione query 2");
        }
        else {
          res.status(200).send(data);
        }

        req["connessione"].close();
      });
    }
  })
});

// Gestione ticket
app.post("/api/tickets/create", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("tickets");
  let param = req.body.data;
  param.date = new Date(param.date);
  collection.insertOne(param, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

app.get("/api/tickets/take", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("tickets");
  let userid = req.query.userid;
  collection.find({ creator: userid }).sort({ date: -1 }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

app.post("/api/tickets/delete", function (req: any, res: any, next) {
  let id = req.body.id;

  let collection = req["connessione"].db(DB_NAME).collection("tickets");
  collection.deleteOne({ _id: new ObjectId(id) }, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query 1");
    } else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

app.post("/api/tickets/share", function (req: any, res: any, next) {
  let id = req.body.userid;
  let content = req.body.content;
  let createBy = req.body.createBy;

  content.creator = id;
  content.sharedBy = createBy;

  let collection = req["connessione"].db(DB_NAME).collection("tickets");
  collection.insertOne(content, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query 1");
    } else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
})

// Gestione socket
io.on('connection', (socket: Socket) => {
  console.log('A user connected');

  // Esempio di gestione di un evento personalizzato
  socket.on('custom-event', (data) => {
    console.log('Received custom event:', data);
    // Emetti un evento a tutti i client connessi
    io.emit('custom-event', data);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});
