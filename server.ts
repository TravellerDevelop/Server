import http from "http";
import url from "url";
import fs from "fs";
import dotenv from "dotenv";
import { Collection, MongoClient, ObjectId } from "mongodb";
import express from "express";
import cors from "cors";

const PORT = process.env.PORT || 1337;
dotenv.config({ path: ".env" });
var app = express();
const connectionString: any = process.env.connectionStringLocal;
const DBNAME = "Traveller";
const collection = "bigData";

const corsOptions = {
  origin: function (origin: any, callback: any) {
    return callback(null, true);
  },
  credentials: true,
};

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
// 1 request log
app.use("/", (req: any, res: any, next: any) => {
  console.log(req.method + ": " + req.originalUrl);
  next();
});

//cerca le risorse nella cartella segnata nel path e li restituisce
app.use("/", express.static("./static"));

// Apertura della connessione
app.use("/api/", (req: any, res: any, next: any) => {
  let connection = new MongoClient(connectionString);
  connection
    .connect()
    .catch((err: any) => {
      res.status(503);
      res.send("Errore di connessione al DB");
    })
    .then((client: any) => {
      req["client"] = client;
      next();
    });
});

/***********USER LISTENER****************/
app.get("/api/lista", cors(corsOptions), (req: any, res: any) => {
  let client = req["client"];
  let db = client.db(DBNAME);
  let collection = db.collection("users");
  collection
    .find({})
    .toArray()
    .then((result: any) => {
      res.status(200);
      res.json(result);
    })
    .catch((err: any) => {
      res.status(500);
      res.send("Errore di lettura da DB");
    });
});