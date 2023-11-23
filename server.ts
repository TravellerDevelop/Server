"use strict";

import http from "http";
import url from "url";
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";
import express from "express"; // @types/express
import cors from "cors"; // @types/cors
import { Server, Socket } from "socket.io";
import calculateResponseTimeMiddleware from "./util/responseTime";
import { takeVersion, verifyConnection } from "./util/tests";
import { fromIdToUsername, login, registerUser, searchUser, setUserNotifToken, takeTravelsNum, takeUserById, takeUserInfo, userTravels } from "./func/user";
import { closeTravel, createTravel, deleteTravel, joinTravel, leaveTravel, takeJoinedTravels, takeTravelByCreator, takeTravelsParticipants, updateTravel, uploadImage } from "./func/travels";
import fs from "fs";
import { createPost, deletePost, takeLastsPostByUsername, takePosts, updatePayment, updatePinPost, updateVote } from "./func/post";
import { takeFollowers, takeFollowings, takeFollowingsWithInfo } from "./func/follow";
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
export const ISDEBUG = true;

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
app.use("/", express.static("./static"));

app.use("/", express.json({ limit: "50mb" }));
app.use("/", express.urlencoded({ limit: "50mb", extended: true }));

app.use("/", (req: any, res: any, next: any) => {
  if (ISDEBUG) {
    calculateResponseTimeMiddleware(req, res, next)
  }
  else{
    next();
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
  new MongoClient(connectionString)
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
  "limits ": { "fileSize ": (20 * 1024 * 1024) } /* 20 MB */
}));

/* UTILITY */
app.get("/api/verifyConnection", (req: any, res: any, next:any) => { verifyConnection(req, res, next);});
app.get("/api/takeVersion", (req: any, res: any, next:any) => { takeVersion(req, res, cache, next); });

/***********USER LISTENER****************/
app.get("/api/user/info", (req: any, res: any, next:any) => { takeUserInfo(req, res, cache, next); });
app.get("/api/user/takeUserById", (req: any, res: any, next:any) => { takeUserById(req, res, cache, next); });
app.post("/api/user/fromIdToUsernames", function (req: any, res: any, next:any) { fromIdToUsername(req, res, cache, next); });
app.post("/api/user/register", function (req: any, res: any, next:any) { registerUser(req, res, next); });
app.get("/api/user/takeTravelsNum", function (req: any, res: any, next:any) { takeTravelsNum(req, res, cache, next); });
app.post("/api/user/login", function (req: any, res: any, next:any) { login(req, res, cache, next); });
app.get("/api/user/travels", function (req: any, res: any, next:any) { userTravels(req, res, cache, next); });
app.get("/api/user/search", function (req: any, res: any, next:any) { searchUser(req, res, cache, next); });
app.post("/api/user/setNotifToken", function (req: any, res: any, next:any) { setUserNotifToken(req, res, cache, next); });
app.post("/api/user/verifyToken", function (req: any, res: any, next:any) { setUserNotifToken(req, res, cache, next); });

// GESTIONE TRAVELS
app.post("/api/travel/create", function (req: any, res: any, next:any) { createTravel(req, res, cache, next); });
app.post("/api/travel/join", function (req: any, res: any, next:any) { joinTravel(req, res, cache, next); });
app.get("/api/travel/takeJoined", function (req: any, res: any, next:any) { takeJoinedTravels(req, res, cache, next); });
app.get("/api/travel/takeParticipants", (req: any, res: any, next:any) => { takeTravelsParticipants(req, res, cache, next);; });
app.get("/api/travel/takeByCreator", function (req: any, res: any, next:any) { takeTravelByCreator(req, res, cache, next); });
app.post("/api/travel/update", function (req: any, res: any, next:any) { updateTravel(req, res, next); });
app.post("/api/travel/close", function (req: any, res: any, next:any) { closeTravel(req, res, next); });
app.post("/api/travel/delete", function (req: any, res: any, next:any) { deleteTravel(req, res, next);});
app.post("/api/travel/leave", function (req: any, res: any, next:any) { leaveTravel(req, res, cache, next); });
app.post('/api/travel/uploadImage', function (req, res, next:any) { uploadImage(req, res, next); })

// GESTIONE DEI POST
app.post("/api/post/create", function (req: any, res: any, next:any) { createPost(req, res, cache, next); });
app.get("/api/post/take", function (req: any, res: any, next:any) { takePosts(req, res, cache, next); });
app.post("/api/post/updateVote", function (req: any, res: any, next:any) { updateVote(req, res, next); });
app.get("/api/post/takeLastsByUsername", function (req: any, res: any, next:any) { takeLastsPostByUsername(req, res, cache, next); });
app.post("/api/post/updatePayment", function (req: any, res: any, next:any) { updatePayment(req, res, next); });
app.post("/api/post/updatePinPost", function (req: any, res: any, next:any) { updatePinPost(req, res, next); });
app.post("/api/post/deletePost", function (req: any, res: any, next:any) { deletePost(req, res, next); });

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

  req["connessione"].db(DB_NAME).collection("follow").find({ from: from, to: to }).toArray(function (err: any, data: any) {
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

app.get("/api/follow/takeFollowers", function (req: any, res: any) { takeFollowers(req, res, cache) });
app.get("/api/follow/takeFollowings", function (req: any, res: any) { takeFollowings(req, res, cache) });
app.get("/api/follow/takeFollowingsWithInfo", function (req: any, res: any) { takeFollowingsWithInfo(req, res, cache) });

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
      cache.del("tickets="+param.createor)
    }

    req["connessione"].close();
  });
});

app.get("/api/tickets/take", function (req: any, res: any, next) {
  let userid = req.query.userid;
  let cachedData = cache.get("tickets=" + userid);
  if (cachedData) {
    res.send(cachedData).status(200);
    cache.set("tickets=" + userid, cachedData, 600);
  }
  else{
    req["connessione"].db(DB_NAME).collection("tickets").find({ creator: userid }).sort({ date: -1 }).toArray(function (err: any, data: any) {
      if (err) {
        res.status(500).send("Errore esecuzione query");
      }
      else {
        res.status(200).send(data);
        cache.set("tickets=" + userid, data, 600);
      }
  
      req["connessione"].close();
    });
  }
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

app.use("/api/", function (req: any, res: any, next) {
  req["connessione"].close();
});