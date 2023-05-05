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

app.post("/api/user/register", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("user");
  collection.insertOne({
    name: req.body.name,
    surname: req.body.surname,
    username: req.body.username,
    email: req.body.email,
    password: req.body.password,
    friends: [],
    friends_count: 0,
    travels: []
  }, function (err: any, data: any) {
    if (err) {
      req["connessione"].close();
      res.status(500).send("Errore esecuzione query");
    } else {
      req["connessione"].close();
      res.status(200).send(data);
    }
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

  });

});


// GESTIONE TRAVELS
app.post("/api/travel/create", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  collection.insertOne({
    creator: req.body.creator,
    name: req.body.name,
    description: req.body.description,
    budget: req.body.budget,
    participants: [],
    visibility: req.body.visibility,
    creation_date: req.body.date,
    new_members_allowed: req.body.new_members_allowed,
    code: req.body.code,
  }, function (err: any, data: any) {
    if (err) {
      req["connessione"].close();
      res.status(500).send("Errore esecuzione query");
    } else {
      req["connessione"].close();
      res.status(200).send(data);
    }
  });
});

app.post("/api/travel/join", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  let error = false;

  //Verifica che non sia l'autore del viaggio e che non sia già iscritto
  collection.find({ code: req.body.code })
    .toArray(function (err: any, data: any) {
      if (err) {
        req["connessione"].close();
        res.status(500).send("Errore esecuzione query");
        error = true;
      } else {
        if (data.length == 1) {
          if (data[0].creator == req.body.username) {

            req["connessione"].close();
            res.status(201).send("Non puoi iscriverti al tuo viaggio");
            error = true;
          } else {
            for(let item of data[0].participants){
              if(item.userid == req.body.userid){
                req["connessione"].close();
                res.status(202).send("Sei già iscritto a questo viaggio");
                error = true;
              }
            }

            if (data[0].participants.includes({ userid: req.body.userid, username: req.body.username })) {
              req["connessione"].close();
              res.status(202).send("Sei già iscritto a questo viaggio");
              error = true;
            } else {
              if (data[0].new_members_allowed == "0") {
                req["connessione"].close();
                res.status(203).send("Non puoi iscriverti a questo viaggio");
                error = true;
              }
              else {
                //Se non ci sono problemi, aggiunge l'utente alla lista dei partecipanti
                if (!error) {
                  collection.updateOne({ code: req.body.code }, { $push: { participants: { userid: req.body.userid, username: req.body.username } } }, function (err: any, data: any) {
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
            }
          }
        } else {
          res.status(201).send("Codice viaggio non valido");
          req["connessione"].close();
          error = true;
        }
      }
    });
});

app.get("/api/travel/takeJoined", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  let username = req.query.username;
  let userid = req.query.userid;

  collection.find({ "participants.userid": userid, "participants.username": username  }).toArray(function (err: any, data: any) {
    if (err) {
      req["connessione"].close();
      res.status(500).send("Errore esecuzione query");
    }
    else {
      req["connessione"].close();
      res.status(200).send(data);
    }
  });
});


// GESTIONE DEI POST
app.post("/api/post/create", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("posts");
  collection.insertOne(req.body.param, function (err: any, data: any) {
    if (err) {
      req["connessione"].close();
      res.status(500).send("Errore esecuzione query");
    } else {
      req["connessione"].close();
      res.status(200).send(data);
    }
  });
});

app.get("/api/post/take", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("posts");
  let travel = req.query.travel;
  collection.find({ travel: travel }).toArray(function (err: any, data: any) {
    if (err) {
      req["connessione"].close();
      res.status(500).send("Errore esecuzione query");
    }
    else {
      console.log(data)
      req["connessione"].close();
      res.status(200).send(data);
    }

  });
});

app.post("/api/post/updateVote", function (req: any, res: any, next) {
  let id = req.body.id;
  let vote = req.body.vote;

  let collection = req["connessione"].db(DB_NAME).collection("posts");
  collection.updateOne({ _id: new ObjectId(id) }, { $set: { votes: vote } }, function (err: any, data: any) {
    if (err) {
      req["connessione"].close();
      res.status(500).send("Errore esecuzione query");
    } else {
      req["connessione"].close();
      res.status(200).send(data);
    }
  });
});