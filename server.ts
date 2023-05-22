"use strict";

import http from "http";
import url from "url";
import fs from "fs";
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";
import express from "express"; // @types/express
import cors from "cors"; // @types/cors
import fileUpload, { UploadedFile } from "express-fileupload";
import { RemoteSocket, Server, Socket } from "socket.io";
import colors from "colors";
import { isConstructorDeclaration } from "typescript";

dotenv.config({ path: ".env" });

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 1337;
const DB_NAME = "traveller";
const connectionString: any = process.env.connectionString;
const socket: any = [];

//CREAZIONE E AVVIO DEL SERVER HTTP
let server = http.createServer(app);
let paginaErrore: string = "";

server.listen(PORT, () => {
  init();
  console.log("Server in ascolto sulla porta " + PORT);
  console.log(connectionString);
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
  console.log(req.method + ": " + req.originalUrl);
  next();
});

app.use("/", express.static("./static"));

app.use("/", express.json({ limit: "50mb" }));
app.use("/", express.urlencoded({ limit: "50mb", extended: true }));

app.use("/", (req: any, res: any, next: any) => {
  if (Object.keys(req.query).length != 0) {
    console.log("------> Parametri GET: " + JSON.stringify(req.query));
  }
  if (Object.keys(req.body).length != 0) {
    console.log("------> Parametri BODY: " + JSON.stringify(req.body));
  }
  next();
});

const whitelist = [];
const corsOptions = {
  origin: function (origin: any, callback: any) {
    return callback(null, true);
  },
  credentials: true,
};
app.use("/", cors(corsOptions));

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

/***********USER LISTENER****************/
app.get("/api/verifyConnection", function (req: any, res: any, next) {
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
});

app.get("/api/user/info", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("user");
  let username = req.query.username;
  collection.find({ username: username }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      res.send(data);
    }
    req["connessione"].close();
  });
});

app.get("/api/user/takeUserById", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("user");
  let id = req.query.id;

  collection.find({ _id: new ObjectId(id) }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      res.send(data);
    }
    req["connessione"].close();
  });
});

app.post("/api/user/fromIdToUsernames", function (req: any, res: any, next) {
  let ausId = [];
  for (let item of req.body.id) {
    ausId.push(new ObjectId(item));
  }

  let collection = req["connessione"].db(DB_NAME).collection("user");
  let id = req.query.id;
  collection.find({ _id: { $in: ausId } }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      res.send(data);
    }
    req["connessione"].close();
  });
});

app.post("/api/user/register", function (req: any, res: any, next) {
  let collection2 = req["connessione"].db(DB_NAME).collection("user");
  collection2.find({ username: req.body.username }).toArray(function (err: any, data: any) {
    if (err) {
      req["connessione"].close();
      res.status(500).send("Errore esecuzione query");
    } else {
      if (data.length != 0) {
        req["connessione"].close();
        res.status(202).send("Username già in uso");
      } else {
        let collection = req["connessione"].db(DB_NAME).collection("user");
        collection.insertOne({
          name: req.body.name,
          surname: req.body.surname,
          username: req.body.username,
          email: req.body.email,
          password: req.body.password,
          friends: [],
          friends_count: 0,
        }, function (err: any, data: any) {
          if (err) {
            req["connessione"].close();
            res.status(500).send("Errore esecuzione query");
          } else {
            req["connessione"].close();
            res.status(200).send(data);
          }
        });
      }
    }

    req["connessione"].close();
  });
});

app.get("/api/user/takeTravelsNum", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  let username = req.query.username;
  collection.find({ "participants": { "$elemMatch": { "username": username, "creator": true } } }, { "participants.$": 1 }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      console.log(data.length.toString())
      res.send(data.length.toString());
    }

    req["connessione"].close();
  });
});


app.post("/api/user/login", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("user");
  collection.find({ username: req.body.username }).toArray(function (err: any, data: any) {
    if (err) {
      req["connessione"].close();
      res.status(500).send("Errore esecuzione query");
    } else {
      if (data.length == 0) {
        req["connessione"].close();
        res.status(202).send("Utente non trovato");
      } else {
        if (data[0].password == req.body.password) {
          req["connessione"].close();
          res.status(200).send(data);
        } else {
          req["connessione"].close();
          res.status(201).send("Password errata");
        }
      }
    }

    req["connessione"].close();
  });
});

app.get("/api/user/travels", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  let username = req.query.username;
  collection.find({ creator: username }).toArray(function (err: any, data: any) {
    if (err) {
      req["connessione"].close();
      res.status(500).send("Errore esecuzione query");
    }
    else {
      req["connessione"].close();
      res.status(200).send(data);
    }
    req["connessione"].close();
  });

});

app.get("/api/user/search", function (req: any, res: any, next) {
  // Ricerca le similitudini tra username, nome e cognome
  let collection = req["connessione"].db(DB_NAME).collection("user");
  let username = req.query.username;
  const regex = new RegExp(username, 'i');
  collection.find({ $or: [{ username: { $regex: regex } }, { name: { $regex: regex } }, { surname: { $regex: regex } }] }).limit(3).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

// GESTIONE TRAVELS
app.post("/api/travel/create", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  collection.insertOne({
    name: req.body.name,
    description: req.body.description,
    budget: req.body.budget,
    participants: req.body.participants,
    visibility: req.body.visibility,
    creation_date: req.body.date,
    new_members_allowed: req.body.new_members_allowed,
    code: req.body.code,
  }, function (err: any, data: any) {
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
        error = true;
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
                  collection.updateOne({ code: req.body.code }, { $push: { participants: { userid: req.body.userid, username: req.body.username } } }, function (err: any, data: any) {
                    if (err) {
                      res.status(500).send("Errore esecuzione query");
                    } else {
                      res.status(200).send(data);
                    }
                  });
                }
              }
            }
          }
        } else {
          res.status(201).send("Codice viaggio non valido");
          error = true;
        }
      }

      req["connessione"].close();
    });
});

app.get("/api/travel/takeJoined", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  let username = req.query.username;
  let userid = req.query.userid;

  collection.find({ "participants.userid": userid, "participants.username": username }).sort({ creation_date: -1 }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

app.get("/api/travel/takeParticipants", function (req: any, res: any, next) {
  let travel = req.query.travel;

  let collection = req["connessione"].db(DB_NAME).collection("travels");
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
          res.status(200).send(data);
        }
      });
    }

    req["connessione"].close();
  });
});

app.get("/api/travel/takeByCreator", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  let username = req.query.username;
  collection.find({ "participants": { "$elemMatch": { "username": username, "creator": true } } }, { "participants.$": 1 }).sort({ creation_date: -1 }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

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

app.get("/api/post/take", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("posts");
  let travel = req.query.travel;
  collection.find({ travel: travel }).sort({ dateTime: -1 }).toArray(function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
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
  let param = req.body.param;

  let collection = req["connessione"].db(DB_NAME).collection("posts");
  collection.updateOne({ _id: new Object(id) }, { $set: { pinned: param.pinned } }, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

app.post("/api/post/deletePost", function (req: any, res: any, next) {
  let id = req.body.id;

  let collection = req["connessione"].db(DB_NAME).collection("posts");
  collection.deleteOne({ _id: new ObjectId(id) }, function (err: any, data: any) {
    if (err) {
      res.status(500).send("Errore esecuzione query");
    } else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
});

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

// Gestione ticket
app.post("/api/tickets/create", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("tickets");

  collection.insertOne(req.body.data, function (err: any, data: any) {
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
      console.log("Errore esecuzione query");
      res.status(500).send("Errore esecuzione query");
      req["connessione"].close();
    }
    else {
      res.status(200).send(data);
    }

    req["connessione"].close();
  });
})