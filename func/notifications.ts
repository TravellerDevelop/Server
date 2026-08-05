import { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import { ObjectId } from "mongodb";
import { Request, Response, NextFunction } from "express";
import { DB_NAME, mongoConnection } from "../server";
import { emitToUser as emitToUserRoom } from "./realtime";
import { parseObjectId } from "../util/mongoIds";
import { Cache } from "../types/common";
import { UserDocument } from "../types/user";
import { TravelDocument } from "../types/travel";
import {
    DeleteNotificationBody,
    MarkNotificationsReadBody,
    NOTIFICATION_CATALOG,
    NOTIFICATION_MERGE_WINDOW_MS,
    NotificationDocument,
    NotificationItem,
    NotificationTarget,
    NotificationType,
    RemoveUserNotifTokenBody,
    TakeNotificationsResponse,
    UnreadCountResponse,
    UpdateNotificationPreferencesBody,
} from "../types/notification";
import { FollowDocument } from "../types/follow";
import { isPushAllowed, isTypeEnabled, mergeSettings, resolvePreferences } from "./notificationRules";
import { isSelf } from "./socketAuth";

export { isTypeEnabled, resolvePreferences } from "./notificationRules";

/* ============================================================
   Dispatcher unico delle notifiche.

   Prima di questo modulo l'invio push era duplicato in due punti
   (createPost in func/post.ts e notifyDebt in func/money.ts), con
   due bug in comune: i messaggi venivano accumulati e rispediti a
   ogni giro del ciclo sui token, e i token non più validi restavano
   in eterno sul documento utente. Qui l'invio è uno solo, i ticket
   Expo vengono letti e i token morti rimossi.

   Chi genera un evento non decide i canali: dichiara il tipo, e i
   canali (push / centro notifiche) escono da NOTIFICATION_CATALOG.
   ============================================================ */

const expo = new Expo();
const NOTIFICATIONS_COLLECTION = "notifications";
const GENERIC_ERROR = "Errore esecuzione query";
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

function notificationsCollection() {
    return mongoConnection.db(DB_NAME).collection<NotificationDocument>(NOTIFICATIONS_COLLECTION);
}

function userCollection() {
    return mongoConnection.db(DB_NAME).collection<UserDocument>("user");
}

function travelsCollection() {
    return mongoConnection.db(DB_NAME).collection<TravelDocument>("travels");
}

function followCollection() {
    return mongoConnection.db(DB_NAME).collection<FollowDocument>("follow");
}

// Era una copia locale della stessa logica non-throwing: consolidata su
// util/mongoIds.ts (unica differenza: quella condivisa è più stretta, non
// accetta più le stringhe "grezze" da 12 byte, mai un caso voluto qui).
function toObjectId(value: ObjectId | string | null | undefined): ObjectId | null {
    if (!value) return null;
    return parseObjectId(value);
}

// =====================================================================================
// Invio
// =====================================================================================

export interface NotifyParams {
    type: NotificationType;
    /** Destinatari. L'attore viene tolto in automatico: nessuno si autonotifica. */
    to: (ObjectId | string)[];
    actor?: ObjectId | string | null;
    /** Se assente viene risolto dal db a partire da `actor`. */
    actorName?: string | null;
    /**
     * Titolo e testo. Il segnaposto `{actor}` viene sostituito con il nome di
     * chi ha generato l'evento: così chi invia non deve fare una query in più
     * per costruire la frase (il nome serve comunque per il centro notifiche).
     */
    title: string;
    body: string;
    travel?: ObjectId | string | null;
    travelName?: string | null;
    entity?: ObjectId | string | null;
    target?: NotificationTarget | null;
    /**
     * Due notifiche con lo stesso groupKey entro 30 minuti diventano una sola
     * riga aggiornata invece di due. Usarlo per gli eventi ripetibili
     * (es. modifiche allo stesso viaggio) e lasciarlo vuoto per quelli unici.
     */
    groupKey?: string | null;
    /** Payload extra nella push, oltre a type/target già inclusi. */
    data?: Record<string, unknown>;
    cache?: Cache;
}

/**
 * Punto di ingresso unico. Non lancia mai e non va atteso dagli handler:
 * una notifica non consegnata non deve far fallire l'azione che l'ha generata.
 */
export async function notify(params: NotifyParams): Promise<void> {
    try {
        const spec = NOTIFICATION_CATALOG[params.type];
        if (!spec) {
            console.log("Notifiche — tipo sconosciuto:", params.type);
            return;
        }

        const actorId = toObjectId(params.actor);
        const travelId = toObjectId(params.travel);
        const travelKey = travelId ? travelId.toString() : null;

        const recipients = new Map<string, ObjectId>();
        for (const raw of params.to || []) {
            const id = toObjectId(raw);
            if (!id) continue;
            if (actorId && id.equals(actorId)) continue;
            recipients.set(id.toString(), id);
        }
        if (recipients.size === 0) return;

        const users = await userCollection()
            .find(
                { _id: { $in: [...recipients.values()] } },
                { projection: { _id: 1, name: 1, surname: 1, username: 1, notifToken: 1, notificationSettings: 1 } }
            )
            .toArray();
        if (users.length === 0) return;

        const actorName = params.actorName ?? (await resolveActorName(actorId));
        const resolved: NotifyParams = {
            ...params,
            actorName,
            title: fillActor(params.title, actorName),
            body: fillActor(params.body, actorName),
        };
        const now = new Date();
        const messages: ExpoPushMessage[] = [];
        const messageTokens: string[] = [];

        for (const user of users) {
            const settings = user.notificationSettings;
            if (!isTypeEnabled(params.type, settings, travelKey)) continue;

            if (spec.center) {
                await writeToCenter(user._id, resolved, spec.category, actorId, actorName, travelId, now);
                params.cache?.del("notif-unread=" + user._id.toString());
                emitToUser(user._id.toString(), "notification", { type: params.type });
            }

            if (!isPushAllowed(params.type, settings)) continue;

            for (const token of user.notifToken || []) {
                if (!token || !Expo.isExpoPushToken(token)) continue;
                messages.push({
                    to: token,
                    sound: "default",
                    title: resolved.title,
                    body: resolved.body,
                    data: {
                        ...(params.data || {}),
                        notificationType: params.type,
                        target: params.target ?? null,
                        travel: travelKey,
                    },
                });
                messageTokens.push(token);
            }
        }

        if (messages.length > 0) await sendPush(messages, messageTokens);
    } catch (err) {
        console.log("Notifiche — invio fallito", err);
    }
}

/** Notifica tutti i partecipanti di un viaggio, escluso l'attore. */
export async function notifyTravel(
    travelId: ObjectId | string,
    params: Omit<NotifyParams, "to" | "travel"> & { travelName?: string | null }
): Promise<void> {
    try {
        const id = toObjectId(travelId);
        if (!id) return;

        const travel = await travelsCollection().findOne(
            { _id: id },
            { projection: { participants: 1, name: 1 } }
        );
        if (!travel) return;

        await notify({
            ...params,
            travel: id,
            travelName: params.travelName ?? travel.name,
            to: (travel.participants || []).map((p) => p.userid),
        });
    } catch (err) {
        console.log("Notifiche — invio al viaggio fallito", err);
    }
}

/** Sostituisce il segnaposto `{actor}` col nome risolto (o "Qualcuno"). */
function fillActor(text: string, actorName: string | null): string {
    if (!text.includes("{actor}")) return text;
    return text.split("{actor}").join(actorName || "Qualcuno");
}

async function resolveActorName(actorId: ObjectId | null): Promise<string | null> {
    if (!actorId) return null;
    try {
        const user = await userCollection().findOne(
            { _id: actorId },
            { projection: { name: 1, surname: 1, username: 1 } }
        );
        if (!user) return null;
        return `${user.name ?? ""} ${user.surname ?? ""}`.trim() || user.username || null;
    } catch {
        return null;
    }
}

/** Inserisce la riga nel centro, oppure aggiorna quella recente con lo stesso groupKey. */
async function writeToCenter(
    userId: ObjectId,
    params: NotifyParams,
    category: NotificationDocument["category"],
    actorId: ObjectId | null,
    actorName: string | null,
    travelId: ObjectId | null,
    now: Date
): Promise<void> {
    const doc: Omit<NotificationDocument, "_id"> = {
        user: userId,
        type: params.type,
        category,
        title: params.title,
        body: params.body,
        actor: actorId,
        actorName,
        travel: travelId,
        travelName: params.travelName ?? null,
        entity: toObjectId(params.entity),
        target: params.target ?? null,
        read: false,
        readAt: null,
        createdAt: now,
        groupKey: params.groupKey ?? null,
    };

    if (params.groupKey) {
        const recent = await notificationsCollection().findOne({
            user: userId,
            groupKey: params.groupKey,
            createdAt: { $gte: new Date(now.getTime() - NOTIFICATION_MERGE_WINDOW_MS) },
        });

        if (recent) {
            await notificationsCollection().updateOne(
                { _id: recent._id },
                { $set: { ...doc, read: false, readAt: null } }
            );
            return;
        }
    }

    await notificationsCollection().insertOne(doc as NotificationDocument);
}

/**
 * Invia i messaggi e ripulisce i token morti.
 *
 * I ticket tornano nello stesso ordine del chunk: `DeviceNotRegistered`
 * significa app disinstallata o token rigenerato, e va tolto dal documento
 * utente — altrimenti ogni invio successivo continua a provarci.
 */
async function sendPush(messages: ExpoPushMessage[], tokens: string[]): Promise<void> {
    const chunks = expo.chunkPushNotifications(messages);
    const deadTokens: string[] = [];
    let offset = 0;

    for (const chunk of chunks) {
        try {
            const tickets: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk);
            tickets.forEach((ticket, i) => {
                if (ticket.status !== "error") return;
                const token = tokens[offset + i];
                if (ticket.details?.error === "DeviceNotRegistered" && token) {
                    deadTokens.push(token);
                } else {
                    console.log("Notifiche — push rifiutata:", ticket.message);
                }
            });
        } catch (error) {
            console.log("Notifiche — chunk non inviato", error);
        }
        offset += chunk.length;
    }

    if (deadTokens.length > 0) {
        try {
            await userCollection().updateMany(
                { notifToken: { $in: deadTokens } },
                { $pull: { notifToken: { $in: deadTokens } } } as never
            );
        } catch (err) {
            console.log("Notifiche — pulizia token fallita", err);
        }
    }
}

/**
 * Aggiorna in tempo reale badge e centro notifiche di chi ha l'app aperta.
 *
 * Delega a func/realtime.ts invece di chiamare `getIo()` da qui: il nome
 * della stanza e la gestione degli errori devono stare in un posto solo,
 * altrimenti basta un "user=" scritto a mano in modo diverso perché gli
 * eventi finiscano in una stanza che non esiste, senza che nulla fallisca.
 */
function emitToUser(userId: string, event: string, payload: unknown): void {
    emitToUserRoom(userId, event, payload);
}

// =====================================================================================
// GET /api/notifications/take
// =====================================================================================

export async function takeNotifications(req: Request, res: Response, next: NextFunction) {
    const userid = req.query.userid as string;
    const before = req.query.before as string | undefined;
    const unreadOnly = req.query.unreadOnly === "1";
    const limit = Math.min(Number(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const userId = toObjectId(userid);
    if (!userId) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    try {
        const filter: Record<string, unknown> = { user: userId };
        if (unreadOnly) filter.read = false;
        if (before) {
            const cursor = new Date(before);
            if (!isNaN(cursor.getTime())) filter.createdAt = { $lt: cursor };
        }

        // limit + 1 per sapere se esiste una pagina successiva senza una count
        const docs = await notificationsCollection()
            .find(filter)
            .sort({ createdAt: -1 })
            .limit(limit + 1)
            .toArray();

        const hasMore = docs.length > limit;
        const page = hasMore ? docs.slice(0, limit) : docs;
        const unreadCount = await notificationsCollection().countDocuments({ user: userId, read: false });

        const response: TakeNotificationsResponse = {
            items: page.map(serialize),
            unreadCount,
            nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
        };
        res.status(200).send(response);
    } catch (err) {
        console.log(GENERIC_ERROR, err);
        res.status(500).send(GENERIC_ERROR);
    } finally {
        next();
    }
}

function serialize(doc: NotificationDocument): NotificationItem {
    return {
        _id: doc._id.toString(),
        type: doc.type,
        category: doc.category,
        title: doc.title,
        body: doc.body,
        actor: doc.actor ? doc.actor.toString() : null,
        actorName: doc.actorName ?? null,
        travel: doc.travel ? doc.travel.toString() : null,
        travelName: doc.travelName ?? null,
        entity: doc.entity ? doc.entity.toString() : null,
        target: doc.target ?? null,
        read: !!doc.read,
        createdAt: doc.createdAt.toISOString(),
    };
}

// =====================================================================================
// GET /api/notifications/unreadCount
// =====================================================================================

/**
 * Alimenta il badge in home. Include le richieste di follow ancora da
 * accettare: prima erano l'unica cosa che il badge contava, ora sono una
 * delle due voci (le richieste vivono nella collection "follow", non qui).
 */
export async function takeUnreadCount(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const userid = req.query.userid as string;
    const userId = toObjectId(userid);
    if (!userId) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    const cacheKey = "notif-unread=" + userid;
    const cached = cache.get<UnreadCountResponse>(cacheKey);
    if (cached) {
        res.status(200).send(cached);
        next();
        return;
    }

    try {
        const [unreadCount, pendingFollowRequests] = await Promise.all([
            notificationsCollection().countDocuments({ user: userId, read: false }),
            followCollection().countDocuments({ to: userid, accepted: false }),
        ]);

        const response: UnreadCountResponse = { unreadCount, pendingFollowRequests };
        cache.set(cacheKey, response, 60);
        res.status(200).send(response);
    } catch (err) {
        console.log(GENERIC_ERROR, err);
        res.status(500).send(GENERIC_ERROR);
    } finally {
        next();
    }
}

// =====================================================================================
// POST /api/notifications/markRead
// =====================================================================================

export async function markNotificationsRead(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { userid, ids }: MarkNotificationsReadBody = req.body;
    const userId = toObjectId(userid);
    if (!userId) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    try {
        const filter: Record<string, unknown> = { user: userId, read: false };
        if (ids && ids.length > 0) {
            const objectIds = ids.map(toObjectId).filter(Boolean) as ObjectId[];
            if (objectIds.length === 0) {
                res.status(400).send("Parametri mancanti");
                next();
                return;
            }
            filter._id = { $in: objectIds };
        }

        const result = await notificationsCollection().updateMany(filter, {
            $set: { read: true, readAt: new Date() },
        });
        cache.del("notif-unread=" + userid);
        res.status(200).send({ updated: result.modifiedCount });
    } catch (err) {
        console.log(GENERIC_ERROR, err);
        res.status(500).send(GENERIC_ERROR);
    } finally {
        next();
    }
}

// =====================================================================================
// POST /api/notifications/delete
// =====================================================================================

export async function deleteNotification(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { userid, id }: DeleteNotificationBody = req.body;
    const userId = toObjectId(userid);
    if (!userId) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    try {
        // Il filtro include sempre l'utente: un id altrui non cancella niente.
        const filter: Record<string, unknown> = { user: userId };
        if (id) {
            const notificationId = toObjectId(id);
            if (!notificationId) {
                res.status(400).send("Parametri mancanti");
                next();
                return;
            }
            filter._id = notificationId;
        }

        const result = await notificationsCollection().deleteMany(filter);
        cache.del("notif-unread=" + userid);
        res.status(200).send({ deleted: result.deletedCount });
    } catch (err) {
        console.log(GENERIC_ERROR, err);
        res.status(500).send(GENERIC_ERROR);
    } finally {
        next();
    }
}

// =====================================================================================
// GET / POST /api/notifications/preferences
// =====================================================================================

export async function takeNotificationPreferences(req: Request, res: Response, next: NextFunction) {
    const userid = req.query.userid as string;
    const userId = toObjectId(userid);
    if (!userId) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    try {
        const user = await userCollection().findOne(
            { _id: userId },
            { projection: { notificationSettings: 1 } }
        );
        res.status(200).send(resolvePreferences(user?.notificationSettings));
    } catch (err) {
        console.log(GENERIC_ERROR, err);
        res.status(500).send(GENERIC_ERROR);
    } finally {
        next();
    }
}

export async function updateNotificationPreferences(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { userid, types, mutedTravels, pushEnabled }: UpdateNotificationPreferencesBody = req.body;
    const userId = toObjectId(userid);
    if (!userId) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    try {
        const user = await userCollection().findOne(
            { _id: userId },
            { projection: { notificationSettings: 1 } }
        );

        // Merge parziale: il client può mandare solo i campi che ha toccato.
        const settings = mergeSettings(user?.notificationSettings, { types, mutedTravels, pushEnabled });

        await userCollection().updateOne({ _id: userId }, { $set: { notificationSettings: settings } });
        cache.del("user-id=" + userid);
        res.status(200).send(resolvePreferences(settings));
    } catch (err) {
        console.log(GENERIC_ERROR, err);
        res.status(500).send(GENERIC_ERROR);
    } finally {
        next();
    }
}

// =====================================================================================
// POST /api/user/removeNotifToken
// =====================================================================================

/**
 * Sgancia il token del dispositivo dall'utente (logout).
 * Senza questa chiamata, chi si disconnette continua a ricevere le push
 * dell'account precedente finché non disinstalla l'app.
 */
export async function removeUserNotifToken(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { userid, notifToken }: RemoveUserNotifTokenBody = req.body;
    const userId = toObjectId(userid);
    if (!userId || !notifToken) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    try {
        await userCollection().updateOne(
            { _id: userId },
            { $pull: { notifToken: notifToken } } as never
        );
        cache.del("user-id=" + userid);
        res.status(200).send({ removed: true });
    } catch (err) {
        console.log(GENERIC_ERROR, err);
        res.status(500).send(GENERIC_ERROR);
    } finally {
        next();
    }
}
