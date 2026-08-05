# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Traveller — the backend server for a travel/trip-planning app (group travels, itineraries, posts/expenses, tickets, follows). Express + MongoDB + Socket.io, written in TypeScript but run directly via `ts-node`/`nodemon` (not compiled to `dist`).

## Commands

- `npm start` — run the dev server (`nodemon server.ts`), listens on `PORT` env var (default 1337).
- `npm test` — run the Jest test suite (`jest`, using `babel-jest` via `babel.config.js`, not `ts-jest`, despite `ts-jest` being a devDependency).
- Run a single test file: `npx jest release.test.ts`.
- There is no build/compile step or lint script defined in `package.json`; `tsc` is not run as part of normal development (`strict` is off in `tsconfig.json`).

### Environment

Requires a `.env` file (loaded via `dotenv`) with:
- `connectionString` — MongoDB connection string.
- `AERODATABOX_API_KEY` — used by flight lookups.
- `AVIATIONSTACK_API_KEY` — optional; secondary flight-data provider used only as a fallback in `func/flights.ts` when AeroDataBox has no result or is missing gate/terminal (common for flights far in the future, since airports assign those close to departure). Free tier: 100 requests/month, and the free plan requires calling `http://api.aviationstack.com` over plain HTTP, not HTTPS. If unset, `lookupFlight` silently falls back to AeroDataBox-only behavior.
- `PORT` — optional, defaults to 1337.
- `SOCKET_SECRET` — key signing the realtime session tokens (min 16 chars). Optional in development: without it the server generates a random one per process and logs a warning, which means every restart invalidates all issued tokens (clients recover by renewing, but it also breaks any multi-instance deploy). **Required in production.**
- `AWS_S3_BUCKET` — S3 bucket used for image uploads (see below). Required for `uploadImage`/`addPostImage` to work; a missing bucket makes those endpoints throw.
- `AWS_REGION` — region of that bucket, also used to build the public object URL (`https://<bucket>.s3.<region>.amazonaws.com/<key>`).
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — optional; if unset, the AWS SDK falls back to its default credential chain (IAM role, shared credentials file, etc.), useful in production where the process runs under an IAM role instead of static keys.

The Mongo database name is hardcoded as `DB_NAME = "traveller"` in `server.ts`.

## Architecture

**Single entrypoint, no framework routing layer.** `server.ts` does everything: creates the Express app, an `http.Server`, wraps it with `socket.io`, wires all middleware, and declares every REST route inline as `app.get/post(path, handler)` calls that delegate to functions imported from `func/*.ts`. There's no router module split — to find where a route lives, grep `server.ts` for the path, then jump to the imported handler.

**`func/*.ts` — one file per domain**, each exporting plain handler functions with the signature `(req, res, [cache], next)`. Domains: `user`, `travels`, `post` (posts + expense/payment tracking + to-dos), `money` (the Money tab: overview, settle up, debt notifications), `follow`, `tickets`, `flights` (AeroDataBox lookups), `itinerary` (by far the largest, ~1300 lines — stops, days, voting, checklists, recap), `utility` (one-off migration scripts, e.g. `migrateTravelParticipants`, exposed at `GET /api/utility`).

**Payments data model** (`type: "payments"` posts) — get this wrong and every money figure is wrong: `amount` is the **per-person share**, not the total; `destinator` holds the *other* participants (the creator advanced the money and is the creditor); `paymentType: "personal"` means `destinator` is just the creator and no debt exists. Total cost of a payment is therefore `amount * destinator.length`.

**Money domain:** `func/money.ts` holds the handlers (`takeMoneyOverview`, `settleUp`, `notifyDebt`, plus `invalidateMoneyCache`) and `func/moneyMath.ts` the pure aggregation (`buildOverview`) — kept separate so it imports neither mongo nor `../server` and can be unit-tested without booting the app (`func/money.test.ts`, 13 cases, runs with plain `npx jest func/money.test.ts`). `GET /api/post/takeMoneyOverview?userid=` returns totals, a 12-month series, per-travel spend, per-person balances and the movements list in one response; it supersedes `takeTotalExpenses`/`takeTotalToPay`/`takeTotalToReceive`/`takePayedGroupByTravel`, which are kept only for older clients. `settleUp` is creditor-only (only the post creator can mark a share paid, same rule the payment detail screen enforces); a debtor uses `notifyDebt` with `kind: "paid"` instead.

Two long-standing query bugs were fixed in `func/post.ts` while wiring this up: `takeTotalToReceive` matched `creator` against a *username* though it is stored as an `ObjectId` (so "da ricevere" was always 0), and `takeTotalPayedByTravel` matched `travel` against a *string* for the same reason (so the travel budget bar always showed 0 spent). When adding a handler that filters on `creator` or `travel`, convert to `ObjectId` first.

**No ORM/model layer.** Handlers open a Mongo collection directly per call via small local helpers like `userCollection()` / `travelsCollection()` (`mongoConnection.db(DB_NAME).collection<XDocument>("...")`), typed against interfaces in `types/*.ts`. `mongoConnection` is a module-level `MongoClient` exported from `server.ts`, connected once at startup (`startConnection()`) and lazily re-connected by the `/api/*` middleware if it isn't set yet.

**Notifications domain:** `types/notification.ts` holds `NOTIFICATION_CATALOG`, the single place declaring, per notification type, its category, whether it sends a **push**, whether it persists a row in the **notification centre** (collection `notifications`), its default on/off value and whether the user may turn it off at all (`configurable: false` for follow requests and payment reminders — the only way the user learns of something requiring their action). Callers never pick channels: they call `notify()` / `notifyTravel()` from `func/notifications.ts` with a type, and the dispatcher reads the catalogue. `func/notificationRules.ts` holds the pure logic (`isTypeEnabled`, `isPushAllowed`, `resolvePreferences`, `mergeSettings`) — like `moneyMath.ts`, it imports neither mongo nor `../server`, so it's unit-tested standalone (`func/notificationRules.test.ts`, 15 cases).

`notify()` excludes the actor from recipients, applies per-user preferences (`user.notificationSettings`), merges repeats sharing a `groupKey` within 30 minutes, reads the Expo tickets back and `$pull`s `DeviceNotRegistered` tokens off the user document. It never throws and is not awaited by handlers. Titles/bodies may contain `{actor}`, substituted with the resolved actor name. Push `data` carries `target` (`{screen, params, root?}`) with **ids only** — the app hydrates them into the objects its screens expect (`TravelDetail` wants `data`, `PaymentInfo` wants `item`). Routes live under `/api/notifications/*` plus `POST /api/user/removeNotifToken`; `ensureNotificationIndexes()` in `server.ts` creates the three indexes the centre relies on. Realtime: `socket.on("identify")` puts a socket in room `user=<id>`, which the dispatcher emits to.

Before this existed, push sending was duplicated in `createPost` and `notifyDebt`, both rebuilding the message array *inside* the per-token loop (so a two-device user got the first push twice), notifying the post's own author, and never cleaning dead tokens. `setUserNotifToken`/`verifyToken` rewrote the whole array instead of `$addToSet`, accumulating duplicates and `null`s.

**Types** live in `types/` (one file per domain, e.g. `user.ts`, `travel.ts`, `itinerary.ts`, `post.ts`, `ticket.ts`, `follow.ts`, `flight.ts`, plus shared `common.ts` for `Cache`/`TextResponse`), all re-exported from `types/index.ts`. Handlers destructure `req.body`/`req.query` into these request-body types and type Mongo documents with the `*Document` interfaces.

**Caching:** a single shared `NodeCache` instance (`cache`, created in `server.ts`, no default TTL) is passed into most handlers as a parameter. The convention is manual, per-endpoint string keys (e.g. `"user-id=" + id`, `"travelsNum-id=" + userid`) with per-call TTLs (commonly 600s), checked/set by hand at the top of each handler, and explicitly invalidated (`cache.del(...)`) on mutations. There is no central invalidation strategy — when adding/editing a mutating handler, check for and clear any cache keys that read the same data. `"money-overview=" + userid` is special: it depends on the payments of *every* travel the user belongs to, so a mutation must clear it for all participants — call `invalidateMoneyCache(cache, travelId)` from `func/money.ts` (already wired into `createPost`/`updatePayment`/`deletePost`) rather than deleting the key by hand.

**Response convention:** handlers reply directly on `res` (`res.status(code).send(...)`) rather than returning values, and always call `next()` at the end of async callbacks (used by the response-time debug middleware in `util/responseTime.ts`, active when `ISDEBUG` is `true` in `server.ts`). Errors are generally `500` with an Italian-language message string (`"Errore esecuzione query"`), not a structured JSON error shape — follow this existing style unless changing it project-wide.

**Realtime:** events are emitted **by the REST handlers**, after the write succeeds, through `func/realtime.ts` (`emitToTravel`, `emitToUser`, `emitToTravelParticipants`, `emitMoneyChanged`, `emitItineraryChanged`). Handlers never touch `getIo()` directly, and never `await` an emit — the realtime channel is an extra and must not be able to fail a request. Event names and room names live in `types/realtime.ts`; the app has a hand-kept twin at `components/realtime/events.ts`, so renaming an event means editing both repos.

The cheapest places to hook new emits already exist, because they are the same choke points the cache invalidation uses: `logItineraryEvent` (every itinerary mutation that writes a feed event), `invalidateTravelCaches` in `func/travels.ts` (create/update/close/delete/join/leave), and `invalidateMoneyCache` + `emitMoneyChanged` for payments. Money and the travel list go to the **per-user** rooms, not the travel room: the Money tab aggregates every travel the user belongs to, and someone who just left a travel is no longer in its room.

`io.on('connection')` in `server.ts` now only manages rooms. What it used to do — accept an `identify` with any userid, join any travel without checking, and relay `newpost`/`changedCheckbox`/`deletePost` between clients — was both insecure and dead (no screen emitted those events); the header comment on that block lists all six problems and why each one is gone.

**Socket authentication (`func/socketAuth.ts`):** an `io.use` middleware requires `{userid, token}` in the handshake, where the token is a stateless HMAC (`v1.<expiry>.<hmac>`) signed with `SOCKET_SECRET`. The connection's identity is the id the *signature* certifies — `socket.data.userId` — never the declared one. Tokens are issued by `forClient()` in `func/user.ts`, the single point that serializes a user to the client (it also strips `password` from every user response). Joining a travel room additionally goes through `isTravelParticipant()`, which checks the `travels` collection with a 15s membership cache, invalidated on join/leave. **This is not authentication for the API**: the REST routes remain unauthenticated (userid as a parameter), so anyone who can call `takeUserById` with an id can get that user's token. It closes the realtime hole and lays the groundwork; a session middleware on `/api/*` is still the real fix.

**Static files:** served from `static/` at `/` (images, uploaded user/post/travel photos, a legacy landing page in `static/index.html`/`css`/`js`, and app store assets). `static/error.html` is read once at startup for a generic error page.

**File uploads:** `express-fileupload` is mounted globally (20MB limit) but image uploads don't actually go through it — the client sends base64 in the JSON body instead. Images go to **AWS S3** via `util/s3.ts` (`uploadBuffer`/`deleteStoredImage`/`publicUrl`/`keyFromUrl`), bucket configured `public-read` (no presigned URLs): `uploadImage` in `func/travels.ts` (travel covers, key `userImage/<file>`) and `addPostImage` in `func/post.ts` (post images, key `userImage/posts/<file>`) both return the full public S3 URL, which is what gets stored in `travel.image` / `post.source` / (eventually) `user.image` going forward. Deleting an image (`updateTravel`/`deleteTravel`/`deletePost`) goes through `deleteStoredImage(ref, legacyDir)`, which deletes from S3 when `ref` is an S3 URL and falls back to `fs.unlink` on `legacyDir` when `ref` is still a pre-migration bare filename — so old and new records can coexist until `migrateImagesToS3` (`func/utility.ts`, `GET /api/utility/migrateImagesToS3`) has run. That one-off endpoint uploads everything still in `static/userImage/` (and `static/userImage/posts/`) to S3 under the same key and rewrites the matching Mongo documents to the new URL. The `cloudinary` dependency that used to be listed in `package.json` was unused dead weight (no code ever called it) and was removed as part of this migration.

## Notes

- Code comments and error strings are largely in Italian; match this when editing existing handlers.
- `example.json` and `headers.json` at the repo root are scratch/reference data, not consumed by the app at runtime.
- `release.test.ts` asserts `ISDEBUG` is `false` and `DB_NAME` is `"traveller"` — it will fail if `ISDEBUG` in `server.ts` is left `true` (a pre-release check), so flip it back before running that test/release.
