# Piano di remediation sicurezza — Traveller Server

Stato: **completato**. Tutti e 7 i punti sono stati implementati e verificati (`npx tsc --noEmit`, `npx jest` — 41/41 — e avvio del server), nell'ordine proposto sotto. Decisioni prese lungo il percorso, dove il piano segnalava una scelta necessaria:
- CORS (#4): nessun client web di produzione → whitelist ristretta a `localhost`/`127.0.0.1` (qualunque porta, per il dev locale), nessun altro origin riflesso.
- Rate limiting (#7): approvata l'aggiunta di `express-rate-limit`, ma l'ambiente in cui è stato scritto questo codice non ha accesso al registro npm per installarla e verificarla — implementato invece un limiter equivalente senza dipendenze (`util/rateLimit.ts`), sostituibile con `express-rate-limit` in un secondo momento se preferito (interfaccia compatibile).
- itinerary.ts (#3): "admin" confermato come "solo il creatore del viaggio", coerente con `updateTravel`/`closeTravel`/`deleteTravel`. Il file aveva già l'infrastruttura di permessi (`loadContext`/`canManagePlan`/`canContribute`), ma derivava l'identità da un `userid` dichiarato dal client invece che da `req.auth.userId` — bastava dichiararsi un altro partecipante per ereditarne i permessi. Fix applicato a tutti e 13 gli handler che la usano.

Il resto di questo documento è la traccia originale del piano, lasciata intatta come riferimento.

---

## 1. Upload immagini: whitelist estensione/content-type

**Dove:** `func/travels.ts` (`uploadImage`), `func/post.ts` (`addPostImage`).

**Problema:** l'estensione del file scritto su disco/S3 arriva dal nome file dichiarato dal client (`imgName.split(".").pop()`), senza whitelist né verifica del contenuto reale. Un client può caricare un file `.html` o `.svg` con JavaScript incluso e farlo servire dallo stesso dominio dell'app (stored XSS), oppure un'estensione a piacere.

**Fix proposto:**
- Whitelist fissa di estensioni immagine (`jpg`, `jpeg`, `png`, `gif`, `webp`, `heic`, `heif` — le stesse già note a `util/s3.ts:CONTENT_TYPES`), rifiuto con 400 se non matcha.
- Verifica dei magic bytes del buffer decodificato (i primi byte identificano il formato reale) invece di fidarsi solo dell'estensione dichiarata — libreria leggera tipo `file-type`, oppure controllo manuale delle signature più comuni.
- Stesso controllo su entrambi gli endpoint.

**Effort:** piccolo (S) — un helper condiviso, due call site.
**Decisione da prendere:** nessuna, è un fix contenuto.

---

## 2. Validazione sistematica di `ObjectId`

**Dove:** trasversale, ~59 punti in `func/*.ts`.

**Problema:** `new ObjectId(id)` lanciata su un id malformato non è quasi mai in un `try/catch`. In un handler sincrono Express la intercetta e risponde con l'error page generica; in un handler `async` non protetto diventa una unhandled promise rejection — nella peggiore delle ipotesi un crash del processo (DoS a costo di una singola richiesta con un id qualsiasi).

**Fix proposto:**
- Helper `parseObjectId(value): ObjectId | null` in un modulo condiviso (es. `util/mongoIds.ts`), che gli handler usano al posto di `new ObjectId(...)` diretto, rispondendo 400 quando torna `null`.
- Un error-handling middleware Express a 4 argomenti (`(err, req, res, next)`) montato in fondo a `server.ts`, rete di sicurezza per qualunque eccezione sincrona sfuggita, così anche dove l'helper non è ancora stato applicato la risposta è un 500 pulito e non un crash.
- Applicazione dell'helper handler per handler — il grosso del lavoro, meccanico ma va fatto con attenzione per non cambiare comportamento dove l'id invalido è già gestito (es. `takeMoneyOverview`, `settleUp` lo fanno già bene).

**Effort:** medio (M) — helper piccolo, ma tocca quasi ogni file in `func/`.
**Decisione da prendere:** nessuna.

---

## 3. Controlli di proprietà in `itinerary.ts`

**Dove:** `func/itinerary.ts` (~1300 righe — di gran lunga il file più grande).

**Problema:** dietro `requireAuth` (serve un token valido), ma senza il secondo livello di controllo aggiunto altrove — verificare che chi chiama sia davvero partecipante del viaggio, ed eventualmente rispettare `ITINERARY_PERMISSION_MODES` (già esistente: `open` / `proposal` / `admin`) anche lato server e non solo lato UI.

**Fix proposto:**
- Mappare ogni handler esportato (stop create/update/delete/assign/reorder/status/vote/checklist, day/shift, duplicate, updateMode, recap, searchPlace) e classificarlo: sola lettura (richiede solo partecipazione) vs scrittura (richiede partecipazione + rispetto della modalità di permesso del viaggio).
- Riusare `isTravelParticipant()` (già in `func/realtime.ts`) come base, più un controllo aggiuntivo sulla modalità per le scritture quando `mode !== "open"`.
- Questo è il file più grande del progetto: è ragionevole spezzarlo in più turni (es. prima gli stop, poi voti/checklist, poi duplicate/updateMode).

**Effort:** grande (L) — il pezzo più corposo del piano.
**Decisione da prendere:** confermare se `admin` deve intendersi "solo il creatore del viaggio" (coerente con `updateTravel`/`closeTravel`/`deleteTravel`, già così) prima di implementare.

---

## 4. CORS: restringere l'origin

**Dove:** `server.ts`, configurazione `cors()`.

**Problema:** `origin: (origin, callback) => callback(null, true)` riflette qualunque origine, con `credentials: true`. Qualsiasi sito web può fare richieste cross-origin verso l'API.

**Fix proposto:** whitelist esplicita di origin consentiti invece del riflesso automatico.

**Decisione necessaria prima di poterlo fare (da te):** l'app mobile (Expo) non manda header `Origin` in produzione, quindi il CORS attuale probabilmente esiste per un client web — c'è una build web dell'app, o un pannello/landing che chiama l'API da browser? Se sì, quali domini (dev locale incluso: `localhost:xxxx`)? Senza questa lista rischio di rompere qualcosa che oggi funziona.

**Effort:** piccolo (S) una volta nota la lista di origin.

---

## 5. ReDoS in `searchUser`

**Dove:** `func/user.ts`.

**Problema:** `new RegExp(username, 'i')` costruisce la regex direttamente dall'input utente e la esegue su username/nome/cognome di tutti gli utenti. Un pattern con backtracking esponenziale (es. `(a+)+$`) può bloccare l'event loop.

**Fix proposto:** escape dei metacaratteri regex (funzione tipo `escapeRegExp`) prima di costruire il pattern, così il testo viene cercato letteralmente e non interpretato come regex.

**Effort:** piccolo (S), 5 minuti.

---

## 6. `ISDEBUG` e `SOCKET_SECRET` in produzione

**Dove:** `server.ts` (`ISDEBUG = true` hardcoded), `func/socketAuth.ts` (fallback a segreto casuale).

**Problema:**
- `ISDEBUG` è cablato a `true`; `release.test.ts` lo segnala già in rosso. Con `ISDEBUG` acceso restano attivi logging verboso e il middleware di debug.
- Se `SOCKET_SECRET` manca o è troppo corto, il server logga un warning ma parte comunque con un segreto casuale per processo — in produzione questo invalida tutti i token a ogni riavvio invece di essere un errore bloccante.

**Fix proposto:**
- `ISDEBUG` derivato da `process.env.NODE_ENV !== "production"` invece che hardcoded, così resta comodo in sviluppo e si spegne da solo in produzione.
- In `func/socketAuth.ts`: se `NODE_ENV === "production"` e `SOCKET_SECRET` manca/è corto, il processo deve rifiutarsi di avviarsi (`process.exit(1)`) invece di continuare con un segreto casuale.

**Effort:** piccolo (S).
**Decisione da prendere:** confermare che il deploy imposta `NODE_ENV=production` (altrimenti la derivazione automatica di `ISDEBUG` non scatta).

---

## 7. Limiti body / rate limiting

**Dove:** `server.ts` (body parser), rotte di login/registrazione.

**Problema:** `express.json({ limit: "50mb" })` globale (necessario per le immagini in base64 nel body) e nessun rate limiting da nessuna parte — `login`/`register` sono liberamente attaccabili a forza bruta, e non solo loro.

**Fix proposto:**
- `express-rate-limit` su `/api/user/login` e `/api/user/register` come minimo indispensabile (es. N tentativi per IP ogni M minuti).
- Valutare se il limite di 50MB debba restare globale o essere ristretto alle sole rotte che caricano immagini (`travel/uploadImage`, `post/addImage`), con un limite più basso ovunque altro.

**Effort:** piccolo/medio (S/M) — dipende se aggiungere una nuova dipendenza (`express-rate-limit`) è accettabile.
**Decisione da prendere:** ok ad aggiungere `express-rate-limit` come dipendenza?

---

## Ordine di esecuzione proposto

1. Upload immagini (#1) — contenuto, rischio concreto di XSS.
2. ReDoS in searchUser (#5) — 5 minuti, alto rapporto beneficio/sforzo.
3. ISDEBUG / SOCKET_SECRET (#6) — piccolo, chiude un residuo della fase precedente.
4. Validazione ObjectId (#2) — meccanico ma esteso, meglio farlo tutto insieme.
5. Rate limiting (#7) — dopo aver confermato la dipendenza nuova.
6. CORS (#4) — appena hai la lista degli origin da autorizzare.
7. itinerary.ts (#3) — il più grande, da spezzare in più turni.

Dimmi da quale vuoi ripartire, oppure "vai in ordine" e procedo punto per punto.
