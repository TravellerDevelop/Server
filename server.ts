import http from "http";
import url from "url";
import fs from "fs";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import express from "express";
import cors from "cors";

const PORT = process.env.PORT || 1337;
dotenv.config({ path: ".env" });
var app = express();
const connectionString: any = process.env.connectionString;
const DBNAME = "MongoDB_Esercizi";
const collection = "mail";

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
app.get("/api/login/", (req: any, res: any, next: any) => {
  let db = req.client.db(DBNAME);
  let email = req.query.email;
  let password = req.query.password;
  console.log("----")
  console.log(email);
  console.log(password);
  console.log("----")
  db.collection(collection).findOne({username : email}, (err: any, data: any) => {
    if (err) {
      res.status(500);
      res.send("Errore Login");
    } else {
      if(data.password == password && data.username == email){
        res.status(200);
        res.send(data);
      }else if(data.password != password || data.username != email){
        res.status(401);
        res.send("Credenziali non valide");
      }
    }
    req.client.close();
  })
});

app.get("/api/verifyDestination/", (req: any, res: any, next: any) => {
  let email = req.query.to;
  let db = req.client.db(DBNAME);
  console.log("----")
  console.log(email);
  console.log("----")
  db.collection(collection).findOne
  ({username : email}, (err: any, data: any) => {
    if (err) {
      res.status(500);
      res.send("Errore ricerca destinatario");
    } else {
      if(data != null){
        res.status(200);
        res.send(data);
      }else{
        res.status(503);
        res.send("Utente non trovato");
      }
    }
    req.client.close();
  })
});

app.post("/api/insertMail/", (req: any, res: any, next: any) => {
  let db = req.client.db(DBNAME);
  let mail = req.body;
  console.log("----")
  console.log(mail);
  console.log("----")
  db.collection(collection).insertOne(mail, (err: any, data: any) => {
    if (err) {
      res.status(500);
      res.send("Errore inserimento mail");
    } else {
      res.status(200);
      res.send("Mail inserita correttamente");
    }
    req.client.close();
  })
});