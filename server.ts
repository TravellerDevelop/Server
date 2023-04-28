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
      if(data.length != 0){
        res.status(200).send("Ok");
      }
    }
    req["connessione"].close();
  });
});

app.get("/api/user/info", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("user");
  let username = req.query.username;
  console.log(username);
  collection.find({ username: username }).toArray(function (err: any, data: any) {
    console.log(data);
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
  console.log(req.body);
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
      console.log(err);
      res.status(500).send("Errore esecuzione query");
    } else {
      console.log(data);
      res.status(200).send(data);
    }
    req["connessione"].close();
  });
});

app.post("/api/user/login", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("user");
  console.log(req.body);
  collection.find({ username: req.body.username }).toArray(function (err: any, data: any) {
    if (err) {
      console.log(err);
      res.status(500).send("Errore esecuzione query");
    } else {
      if (data.length == 0) {
        console.log("Utente non trovato")
        res.status(202).send("Utente non trovato");
      } else {
        if (data[0].password == req.body.password) {
          res.status(200).send(data);
        } else {
          console.log("Password errata")
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
  console.log(username);
  collection.find({ creator: username }).toArray(function (err: any, data: any) {
    console.log(data);
    if (err) {
      res.status(500).send("Errore esecuzione query");
    }
    else {
      res.status(200).send(data);
    }
  });

});

app.post("/api/travel/create", function (req: any, res: any, next) {
  let collection = req["connessione"].db(DB_NAME).collection("travels");
  console.log(req.body);
  collection.insertOne({
    creator: req.body.creator,
    name: req.body.name,
    description: req.body.description,
    budget: req.body.budget,
    participants: [],
    visibility: req.body.visibility,
    creation_date: req.body.date,
    new_members_allowed: req.body.new_members_allowed,
  }, function (err: any, data: any) {
    if (err) {
      console.log(err);
      res.status(500).send("Errore esecuzione query");
    } else {
      console.log(data);
      res.status(200).send(data);
    }
    req["connessione"].close();
  });
});