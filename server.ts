"use strict";

// Deve restare il primo import del file: vedi env.ts sul perché.
import "./env";

import http from "http";
import url from "url";
import { MongoClient } from "mongodb";
import express, { NextFunction, Request, Response } from "express"; // @types/express
import cors from "cors"; // @types/cors
import { Server, Socket } from "socket.io";
import NodeCache from "node-cache";
import fileUpload from "express-fileupload";
import calculateResponseTimeMiddleware from "./util/responseTime";
import { takeVersion, verifyConnection } from "./util/tests";
import { fromIdToUsername, login, registerUser, searchUser, setUserNotifToken, takeTravelsNum, takeUserById, takeUserInfo, userTravels, verifyToken } from "./func/user";
import { closeTravel, createTravel, deleteTravel, joinTravel, leaveTravel, markTravelSeen, setPersonalBudget, takeJoinedTravels, takeTravelByCreator, takeTravelsParticipants, updateTravel, uploadImage } from "./func/travels";
import fs from "fs";
import { addPostImage, createPost, deletePost, takeLastsPostByUsername, takePayedGroupByTravel, takePosts, takeTotalExpenses, takeTotalPayedByTravel, takeTotalToPay, takeTotalToReceive, updatePayment, updatePinPost, updateToDo, updateVote } from "./func/post";
import { notifyDebt, settleUp, takeMoneyOverview } from "./func/money";
import { acceptFollow, createFollow, deleteFollow, takeFollowers, takeFollowersRequest, takeFollowFromTo, takeFollowings, takeFollowingsWithInfo } from "./func/follow";
import { createTicket, deleteTicket, shareTicket, takeTickets } from "./func/tickets";
import { lookupFlight } from "./func/flights";
import { deleteNotification, markNotificationsRead, removeUserNotifToken, takeNotificationPreferences, takeNotifications, takeUnreadCount, updateNotificationPreferences } from "./func/notifications";
import { assignStop, createStop, deleteStop, duplicateItinerary, reorderStops, searchPlace, shiftDay, takeItinerary, takeRecap, updateItineraryMode, updateStop, updateStopChecklist, updateStopStatus, voteStop } from "./func/itinerary";
import { requireAuth, verifySocketToken } from "./func/socketAuth";
import { isTravelParticipant } from "./func/realtime";
import { CLIENT_EVENTS, travelRoom, userRoom } from "./types/realtime";
import { createRateLimiter } from "./util/rateLimit";

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const PORT: string | number = process.env.PORT || 1337;

/**
 * Rete di sicurezza a livello di processo.
 *
 * Express 4 intercetta da sé un `throw` sincrono dentro un handler e lo
 * trasforma in una risposta di errore, ma NON intercetta una promise
 * rifiutata e non gestita dentro un handler `async` senza `try/catch` — e
 * questo codebase ne ha parecchi, spesso proprio intorno a `new ObjectId(x)`
 * su un valore che arriva da fuori (vedi util/mongoIds.ts). Senza questo
 * handler, un id malformato mandato da chiunque diventa un
 * "unhandledRejection" che nelle versioni recenti di Node termina il
 * processo: un DoS gratuito, zero autenticazione richiesta.
 *
 * Questo NON sostituisce il fix vero (usare parseObjectId invece di
 * `new ObjectId` diretto nei singoli handler) — è il backstop per i punti
 * non ancora convertiti o per qualunque altra eccezione async imprevista:
 * logga e mantiene il processo in vita, invece di farlo cadere.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

/**
 * Un'eccezione sincrona sfuggita a Express (fuori da un handler di rotta,
 * es. in un callback/timer) lascia il processo in uno stato non garantito:
 * qui logghiamo e usciamo, lasciando che sia nodemon/il process manager a
 * far ripartire il servizio pulito, invece di continuare a girare in uno
 * stato potenzialmente corrotto.
 */
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  process.exit(1);
});

/** Client mongo condiviso, valorizzato al termine della connessione iniziale (vedi startConnection). */
export let mongoConnection: MongoClient;

/**
 * Accesso al server socket per i moduli in func/.
 * È una funzione e non l'istanza esportata direttamente per evitare che
 * `import { io }` in func/notifications.ts crei un ciclo di import risolto
 * a undefined: qui la lettura avviene a runtime, quando `io` esiste già.
 */
export function getIo(): Server {
  return io;
}

const cache = new NodeCache({ stdTTL: 0, checkperiod: 120 });
export const DB_NAME = "traveller";
const connectionString: string = process.env.connectionString;

/**
 * Prima era `true` cablato nel codice: un interruttore manuale da ricordarsi
 * di rimettere a `false` prima di ogni release (vedi release.test.ts, che
 * infatti lo controllava). Un interruttore manuale è esattamente il tipo di
 * cosa che ci si dimentica di girare — motivo per cui è finito nella
 * security review di questo progetto. Derivarlo da NODE_ENV lo rende
 * automatico: gli host Node più comuni impostano NODE_ENV=production da
 * soli per i servizi web (compreso quello su cui gira questo servizio, vedi
 * NOMINATIM_UA in func/itinerary.ts), quindi non serve più nessun intervento
 * manuale al deploy — e nemmeno nessuno che se lo dimentichi.
 */
export function computeIsDebug(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}
export const ISDEBUG = computeIsDebug(process.env.NODE_ENV);

//CREAZIONE E AVVIO DEL SERVER HTTP
let paginaErrore: string = "";

httpServer.listen(PORT, () => {
  init();
  console.log("Server in ascolto sulla porta " + PORT);
});

function init() {
  fs.readFile("./static/error.html", (err, data) => {
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

app.use("/", (req: Request, res: Response, next: NextFunction) => {
  if (ISDEBUG) {
    calculateResponseTimeMiddleware(req, res, next)
  }
  else {
    next();
  }
});

/**
 * Nessun deploy dietro proxy inversa (Render, vedi NOMINATIM_UA in
 * func/itinerary.ts) mette l'IP reale del client in `req.ip` di sua
 * iniziativa: senza dirlo esplicitamente a Express, ogni richiesta risulta
 * arrivare dall'IP del proxy, e con esso il rate limiting qui sotto
 * finirebbe per contare TUTTI gli utenti in un unico contatore condiviso.
 * "1" = ci si fida di un solo hop di proxy davanti al processo Node.
 */
app.set("trust proxy", 1);

/**
 * Nessun client web chiama questa API dal browser (solo l'app mobile, che
 * non manda l'header Origin, e quindi non è mai soggetta a CORS): qualunque
 * richiesta CON un Origin diverso da localhost è quindi per definizione un
 * sito di terzi che prova a usare, dal browser di un utente già loggato in
 * un'altra scheda, i cookie/credenziali di questa sessione. Prima
 * riflettevamo qualsiasi origin (`callback(null, true)` incondizionato):
 * equivaleva a nessuna protezione.
 */
const ALLOWED_CORS_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.use("/", cors({
  origin: function (origin, callback) {
    // Nessun header Origin: non è una richiesta browser cross-origin (app
    // mobile, curl, chiamate server-to-server, Postman...). CORS riguarda
    // solo i browser, quindi qui non c'è nulla da restringere.
    if (!origin || ALLOWED_CORS_ORIGIN.test(origin)) {
      callback(null, true);
      return;
    }
    // `callback(null, false)` invece di `callback(new Error(...))`: niente
    // header Access-Control-Allow-Origin nella risposta, che il browser del
    // chiamante rifiuta da sé — senza far scattare il middleware di errore
    // globale con un generico 500.
    callback(null, false);
  },
  credentials: true,
}));

app.set("json spaces", 4);

/**
 * Rate limiting generale su /api/*: senza, niente in questo server impedisce
 * a un singolo IP di martellare qualunque endpoint (letture comprese) senza
 * limite. Le rotte più sensibili al brute-force (login, registrazione,
 * verifyToken) hanno in più un limite più stretto, applicato direttamente
 * sulla loro route qui sotto. Vedi util/rateLimit.ts sul perché non usa
 * `express-rate-limit` e sul limite noto (contatori in memoria, non
 * condivisi tra istanze).
 */
const apiRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 600,
  message: "Troppe richieste da questo indirizzo, riprova tra qualche minuto",
});
app.use("/api/", apiRateLimiter);

/** Limite più stretto per le rotte legate a login/registrazione: qui il costo di un tentativo sbagliato per l'attaccante deve essere alto. */
const authRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: "Troppi tentativi, riprova tra qualche minuto",
});

app.use("/api/", function (req: Request, res: Response, next: NextFunction) {
  let safe = true;
  if (!mongoConnection) {
    safe = false;
    new MongoClient(connectionString)
      .connect()
      .then((client) => {
        mongoConnection = client;
        next();
      })
      .catch(() => {
        const msg: string = "Errore di connessione al db";
        res.status(503).send(msg);
      });
  }

  if (safe) {
    next();
  }
});

/**
 * Autenticazione REST.
 *
 * Fino a qui ogni rotta /api/* si fidava dell'userid/creator dichiarato nel
 * body o nella query: chiunque conoscesse (o indovinasse) un ObjectId
 * poteva leggere o scrivere per conto di un altro utente. Da qui in poi
 * serve un token valido (vedi func/socketAuth.ts — lo stesso già emesso da
 * login/registrazione/takeUserById per il canale realtime, ora riusato
 * anche qui) tranne che per le poche rotte elencate sotto, che per loro
 * natura non possono richiederne uno: non esiste ancora una sessione prima
 * di essersi loggati o registrati.
 *
 * PUBLIC_API_PATHS usa il percorso completo (incluso "/api"): dentro un
 * middleware montato con app.use("/api/", ...) Express non modifica
 * req.originalUrl, quindi confrontarlo così evita ambiguità sul prefisso.
 */
const PUBLIC_API_PATHS = new Set<string>([
  "/api/verifyConnection",
  "/api/takeVersion",
  "/api/user/login",
  "/api/user/register",
  "/api/user/info", // solo fase di registrazione, vedi func/user.ts
  // Pubblica di proposito: è l'endpoint che client e socket usano per
  // ottenere un socketToken NUOVO quando quello attuale non è più valido
  // (scaduto, o firmato con un SOCKET_SECRET cambiato — vedi func/socketAuth.ts
  // e authContext.tsx:refreshSession). Se finisse dietro requireAuth, un token
  // non valido non potrebbe mai rinnovarsi: la richiesta di rinnovo prenderebbe
  // 401 a sua volta, l'interceptor di rete la ritenterebbe passando di qui, e
  // così via — il loop di GET osservato risale esattamente a questo. Non
  // espone nulla che takeUserById non esponesse già prima di requireAuth
  // (vedi func/user.ts: nessun uso di req.auth, lookup pubblico per id).
  "/api/user/takeUserById",
]);

app.use("/api/", function (req: Request, res: Response, next: NextFunction) {
  const path = req.originalUrl.split("?")[0];
  if (PUBLIC_API_PATHS.has(path)) {
    next();
    return;
  }
  requireAuth(req, res, next);
});

app.use(fileUpload({
  limits: { fileSize: 20 * 1024 * 1024 } /* 20 MB */
}));

/* UTILITY */
app.get("/api/verifyConnection", (req: Request, res: Response, next: NextFunction) => verifyConnection(req, res, next));
app.get("/api/takeVersion", (req: Request, res: Response, next: NextFunction) => takeVersion(req, res, cache, next));

/***********USER LISTENER****************/
app.get("/api/user/info", (req: Request, res: Response, next: NextFunction) => takeUserInfo(req, res, next)); // UTILIZZARE SOLO PER LA REGISTRAZIONE
app.get("/api/user/takeUserById", (req: Request, res: Response, next: NextFunction) => takeUserById(req, res, cache, next));
app.post("/api/user/fromIdToUsernames", function (req: Request, res: Response, next: NextFunction) { fromIdToUsername(req, res, cache, next); });
app.post("/api/user/register", authRateLimiter, function (req: Request, res: Response, next: NextFunction) { registerUser(req, res, next); });
app.get("/api/user/takeTravelsNum", function (req: Request, res: Response, next: NextFunction) { takeTravelsNum(req, res, cache, next); });
app.post("/api/user/login", authRateLimiter, function (req: Request, res: Response, next: NextFunction) { login(req, res, cache, next); });
app.get("/api/user/travels", function (req: Request, res: Response, next: NextFunction) { userTravels(req, res, cache, next); });
app.get("/api/user/search", function (req: Request, res: Response, next: NextFunction) { searchUser(req, res, cache, next); });
app.post("/api/user/setNotifToken", function (req: Request, res: Response, next: NextFunction) { setUserNotifToken(req, res, cache, next); });
app.post("/api/user/verifyToken", authRateLimiter, function (req: Request, res: Response, next: NextFunction) { verifyToken(req, res, cache, next); });
app.post("/api/user/removeNotifToken", function (req: Request, res: Response, next: NextFunction) { removeUserNotifToken(req, res, cache, next); });

/***********NOTIFICHE****************/
app.get("/api/notifications/take", function (req: Request, res: Response, next: NextFunction) { takeNotifications(req, res, next); });
app.get("/api/notifications/unreadCount", function (req: Request, res: Response, next: NextFunction) { takeUnreadCount(req, res, cache, next); });
app.post("/api/notifications/markRead", function (req: Request, res: Response, next: NextFunction) { markNotificationsRead(req, res, cache, next); });
app.post("/api/notifications/delete", function (req: Request, res: Response, next: NextFunction) { deleteNotification(req, res, cache, next); });
app.get("/api/notifications/preferences", function (req: Request, res: Response, next: NextFunction) { takeNotificationPreferences(req, res, next); });
app.post("/api/notifications/preferences", function (req: Request, res: Response, next: NextFunction) { updateNotificationPreferences(req, res, cache, next); });

// GESTIONE TRAVELS
app.post("/api/travel/create", function (req: Request, res: Response) { createTravel(req, res, cache); });
app.post("/api/travel/join", function (req: Request, res: Response, next: NextFunction) { joinTravel(req, res, cache, next); });
app.get("/api/travel/takeJoined", function (req: Request, res: Response, next: NextFunction) { takeJoinedTravels(req, res, cache, next); });
app.get("/api/travel/takeParticipants", (req: Request, res: Response) => { takeTravelsParticipants(req, res, cache); });
app.get("/api/travel/takeByCreator", function (req: Request, res: Response, next: NextFunction) { takeTravelByCreator(req, res, cache, next); });
app.post("/api/travel/update", function (req: Request, res: Response, next: NextFunction) { updateTravel(req, res, cache, next); });
app.post("/api/travel/close", function (req: Request, res: Response, next: NextFunction) { closeTravel(req, res, cache, next); });
app.post("/api/travel/delete", function (req: Request, res: Response, next: NextFunction) { deleteTravel(req, res, cache, next); });
app.post("/api/travel/leave", function (req: Request, res: Response, next: NextFunction) { leaveTravel(req, res, cache, next); });
app.post("/api/travel/setPersonalBudget", function (req: Request, res: Response, next: NextFunction) { setPersonalBudget(req, res, cache, next); });
app.post("/api/travel/markSeen", function (req: Request, res: Response, next: NextFunction) { markTravelSeen(req, res, cache, next); });
app.post('/api/travel/uploadImage', function (req: Request, res: Response, next: NextFunction) { uploadImage(req, res, next); })

// GESTIONE DEI POST
app.post("/api/post/create", function (req: Request, res: Response, next: NextFunction) { createPost(req, res, cache, next); });
app.get("/api/post/take", function (req: Request, res: Response, next: NextFunction) { takePosts(req, res, cache, next); });
app.post("/api/post/updateVote", function (req: Request, res: Response, next: NextFunction) { updateVote(req, res, cache, next); });
app.get("/api/post/takeLastsByUsername", function (req: Request, res: Response, next: NextFunction) { takeLastsPostByUsername(req, res, cache, next); });
app.post("/api/post/updatePayment", function (req: Request, res: Response, next: NextFunction) { updatePayment(req, res, cache, next); });
app.post("/api/post/updatePinPost", function (req: Request, res: Response, next: NextFunction) { updatePinPost(req, res, cache, next); });
app.post("/api/post/deletePost", function (req: Request, res: Response, next: NextFunction) { deletePost(req, res, cache, next); });
app.get("/api/post/takeTotalExpenses", function (req: Request, res: Response) { takeTotalExpenses(req, res); });
app.get("/api/post/takeTotalToPay", function (req: Request, res: Response) { takeTotalToPay(req, res); });
app.get("/api/post/takeTotalToReceive", function (req: Request, res: Response) { takeTotalToReceive(req, res); });
app.get("/api/post/takeTotalPayedByTravel", function (req: Request, res: Response) { takeTotalPayedByTravel(req, res); });
app.get("/api/post/takePayedGroupByTravel", function (req: Request, res: Response) { takePayedGroupByTravel(req, res); });
// Money: un'unica GET al posto delle quattro sopra (che restano per i client vecchi)
app.get("/api/post/takeMoneyOverview", function (req: Request, res: Response, next: NextFunction) { takeMoneyOverview(req, res, cache, next); });
app.post("/api/post/settleUp", function (req: Request, res: Response, next: NextFunction) { settleUp(req, res, cache, next); });
app.post("/api/post/notifyDebt", function (req: Request, res: Response, next: NextFunction) { notifyDebt(req, res, cache, next); });
app.post("/api/post/addImage", function (req: Request, res: Response) { addPostImage(req, res); });
app.post("/api/post/updateToDo", function (req: Request, res: Response) { updateToDo(req, res, cache); });

// GESTIONE FOLLOW
app.post("/api/follow/create", function (req: Request, res: Response) { createFollow(req, res); });
app.get("/api/follow/takeFromTo", function (req: Request, res: Response) { takeFollowFromTo(req, res); });
app.post("/api/follow/delete", function (req: Request, res: Response) { deleteFollow(req, res, cache); });
app.get("/api/follow/takeFollowersRequest", function (req: Request, res: Response) { takeFollowersRequest(req, res); });
app.post("/api/follow/accept", function (req: Request, res: Response) { acceptFollow(req, res, cache); });
app.get("/api/follow/takeFollowers", function (req: Request, res: Response) { takeFollowers(req, res, cache) });
app.get("/api/follow/takeFollowings", function (req: Request, res: Response) { takeFollowings(req, res, cache) });
app.get("/api/follow/takeFollowingsWithInfo", function (req: Request, res: Response) { takeFollowingsWithInfo(req, res, cache) });

// GESTIONE ITINERARIO
app.get("/api/itinerary/take", function (req: Request, res: Response) { takeItinerary(req, res); });
app.post("/api/itinerary/updateMode", function (req: Request, res: Response) { updateItineraryMode(req, res); });
app.post("/api/itinerary/stop/create", function (req: Request, res: Response) { createStop(req, res, cache); });
app.post("/api/itinerary/stop/update", function (req: Request, res: Response) { updateStop(req, res, cache); });
app.post("/api/itinerary/stop/delete", function (req: Request, res: Response) { deleteStop(req, res, cache); });
app.post("/api/itinerary/stop/assign", function (req: Request, res: Response) { assignStop(req, res, cache); });
app.post("/api/itinerary/stop/reorder", function (req: Request, res: Response) { reorderStops(req, res); });
app.post("/api/itinerary/stop/status", function (req: Request, res: Response) { updateStopStatus(req, res, cache); });
app.post("/api/itinerary/stop/vote", function (req: Request, res: Response) { voteStop(req, res); });
app.post("/api/itinerary/stop/checklist", function (req: Request, res: Response) { updateStopChecklist(req, res); });
app.post("/api/itinerary/day/shift", function (req: Request, res: Response) { shiftDay(req, res, cache); });
app.get("/api/itinerary/recap", function (req: Request, res: Response) { takeRecap(req, res); });
app.post("/api/itinerary/duplicate", function (req: Request, res: Response) { duplicateItinerary(req, res, cache); });
app.get("/api/itinerary/searchPlace", function (req: Request, res: Response) { searchPlace(req, res, cache); });

// Le migrazioni una tantum (partecipanti dei viaggi, immagini locali -> S3)
// non sono più esposte via HTTP: erano raggiungibili da chiunque avesse un
// token valido, non solo da chi amministra il server, e non esiste un
// concetto di ruolo/admin in questa app per limitarle. Ora sono script a sé,
// lanciati a mano: vedi scripts/migrateTravelParticipants.ts e
// scripts/migrateImagesToS3.ts (npm run migrate:travelParticipants / migrate:imagesToS3).

// Gestione ticket
app.post("/api/tickets/create", function (req: Request, res: Response) { createTicket(req, res, cache); });
app.get("/api/tickets/take", function (req: Request, res: Response) { takeTickets(req, res, cache); });
app.post("/api/tickets/delete", function (req: Request, res: Response) { deleteTicket(req, res, cache); });
app.post("/api/tickets/share", function (req: Request, res: Response) { shareTicket(req, res, cache); });
app.get("/api/tickets/lookupFlight", function (req: Request, res: Response) { lookupFlight(req, res, cache); });

/* GESTIONE SOCKET
 *
 * Come funzionava prima, e perché è stato rifatto:
 *
 * 1. L'identità arrivava dal client. `identify` accettava qualsiasi userid,
 *    quindi bastava aprire una connessione dichiarandosi un altro utente per
 *    ricevere le sue notifiche. Ora l'handshake pretende un token firmato dal
 *    server (func/socketAuth.ts) e l'userid usato è quello che la firma
 *    certifica, mai quello dichiarato nel payload.
 * 2. `joinTravel` non verificava niente: chiunque conoscesse un ObjectId
 *    poteva ascoltare feed, pagamenti e itinerario di un viaggio altrui. Ora
 *    l'ingresso nella stanza passa da isTravelParticipant().
 * 3. Gli eventi (`newpost`, `changedCheckbox`, `deletePost`) erano rilanci fra
 *    client: il server si limitava a inoltrare quello che un client gli
 *    mandava, senza controllare né il contenuto né il mittente, e nessuna
 *    schermata dell'app li emetteva davvero — erano codice morto. Ora gli
 *    eventi partono dagli handler REST, dopo la scrittura su Mongo, tramite
 *    func/realtime.ts. Il client non può più iniettare eventi arbitrari nella
 *    stanza di un viaggio.
 * 4. `leaveTravel` faceva `socket.leave(user.travel)` mentre l'ingresso era
 *    `socket.join('travel=' + user.travelId)`: nomi di stanza diversi, quindi
 *    non usciva mai. Ora c'è un solo posto che costruisce il nome (travelRoom).
 * 5. La variabile `user` era una closure valorizzata solo dall'ultimo
 *    joinTravel, e l'array `users` cresceva a ogni connessione senza essere
 *    mai svuotato al disconnect. Lo stato per socket ora è un Set di id, e
 *    socket.io libera da sé le stanze alla disconnessione.
 * 6. `custom-event` faceva `io.emit` a TUTTI i client connessi: rimosso.
 */

io.use((socket: Socket, next: (err?: Error) => void) => {
  const auth = (socket.handshake.auth ?? {}) as { userid?: unknown; token?: unknown };
  const result = verifySocketToken(auth.userid, auth.token);

  if (!result.ok) {
    // Il messaggio è il codice che il client legge in `connect_error` per
    // decidere se rinnovare il token e riprovare (scaduto/non valido) o
    // arrendersi. Non contiene dettagli utili a un attaccante.
    if (ISDEBUG) console.log("[socket] handshake rifiutato:", result.reason);
    return next(new Error("auth:" + result.reason));
  }

  // Da qui in poi l'unica fonte dell'identità è questo campo.
  socket.data.userId = result.userId;
  next();
});

io.on("connection", (socket: Socket) => {
  const userId: string = socket.data.userId;

  // Stanza personale: notifiche, badge, riepilogo Money. Non serve un evento
  // "identify" separato — l'utente è già noto dall'handshake, e farlo qui
  // significa che la stanza c'è dal primo istante, anche per gli eventi
  // emessi mentre il client sta ancora montando le schermate.
  socket.join(userRoom(userId));
  if (ISDEBUG) console.log("[socket] connesso:", userId);

  socket.on(CLIENT_EVENTS.JOIN_TRAVEL, async (payload: { travelId?: string }, ack?: (r: unknown) => void) => {
    const travelId = payload?.travelId;
    if (!travelId) {
      ack?.({ ok: false, reason: "missing" });
      return;
    }

    const allowed = await isTravelParticipant(userId, travelId);
    if (!allowed) {
      if (ISDEBUG) console.log("[socket] join negato:", userId, "->", travelId);
      ack?.({ ok: false, reason: "forbidden" });
      return;
    }

    socket.join(travelRoom(travelId));
    if (ISDEBUG) console.log("[socket] join:", userId, "->", travelRoom(travelId));
    ack?.({ ok: true });
  });

  socket.on(CLIENT_EVENTS.LEAVE_TRAVEL, (payload: { travelId?: string }) => {
    const travelId = payload?.travelId;
    if (!travelId) return;
    socket.leave(travelRoom(travelId));
    if (ISDEBUG) console.log("[socket] leave:", userId, "->", travelRoom(travelId));
  });

  socket.on("disconnect", (reason: string) => {
    // Nessuna pulizia da fare: le stanze le libera socket.io, e non esiste
    // più nessuna struttura dati globale per socket — che è esattamente il
    // punto, visto che l'array `users` di prima non veniva mai svuotato.
    if (ISDEBUG) console.log("[socket] disconnesso:", userId, reason);
  });
});

/**
 * Middleware di errore Express (4 argomenti: è la firma che Express usa per
 * riconoscerlo come tale, non un dettaglio stilistico). Prima di questo
 * commit qui c'era un middleware "/api/" vuoto, senza `next()` e senza `err`
 * — non faceva nulla e ogni richiesta restava appesa finché non scattava un
 * timeout. Va registrato per ultimo: Express ci arriva solo se un handler
 * precedente chiama `next(err)` o lancia sincrono senza gestirlo da sé.
 *
 * `paginaErrore` (letta da static/error.html in init()) restava valorizzata
 * ma inutilizzata: nessuna rotta la mandava mai in risposta. La usiamo qui
 * solo per le richieste non-API (pagine statiche), mentre /api/* riceve un
 * JSON coerente con lo stile delle altre rotte REST.
 */
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  console.error("[errore]", req.method, req.originalUrl, err);

  const isBadObjectId = err instanceof Error && err.name === "BSONTypeError";
  const isApiRequest = req.originalUrl.startsWith("/api/");

  if (isBadObjectId) {
    if (isApiRequest) {
      res.status(400).send("Parametro id non valido");
    } else {
      res.status(400).send(paginaErrore || "Richiesta non valida");
    }
    return;
  }

  if (isApiRequest) {
    res.status(500).send("Errore esecuzione query");
  } else {
    res.status(500).send(paginaErrore || "Errore interno");
  }
});

startConnection();

function startConnection() {
  new MongoClient(connectionString)
    .connect()
    .then((client) => {
      console.log("Started connection")
      mongoConnection = client;
      ensureNotificationIndexes();
    })
    .catch(() => {
      console.log("Errore di connessione al db");
    });
}

/**
 * Indici della collection "notifications".
 *
 * Il centro notifiche legge sempre per (user, createdAt desc) e conta le
 * non lette per (user, read): senza indici entrambe le query diventano un
 * collection scan che cresce con lo storico di TUTTI gli utenti.
 * `createIndex` è idempotente, quindi si può chiamare a ogni avvio.
 */
function ensureNotificationIndexes() {
  const collection = mongoConnection.db(DB_NAME).collection("notifications");
  Promise.all([
    collection.createIndex({ user: 1, createdAt: -1 }),
    collection.createIndex({ user: 1, read: 1 }),
    // Serve alla fusione per groupKey entro la finestra di 30 minuti.
    collection.createIndex({ user: 1, groupKey: 1, createdAt: -1 }),
  ]).catch((err) => {
    console.log("Indici notifiche non creati", err);
  });
}