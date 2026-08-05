import { ObjectId } from "mongodb";
import { Request, Response, NextFunction } from "express";
import { DB_NAME, mongoConnection } from "../server";
import { Cache } from "../types/common";
import { TravelDocument } from "../types/travel";
import { UserDocument } from "../types/user";
import { PaymentPost, PostDocument } from "../types/post";
import { MoneyOverview, NotifyDebtBody, SettleUpBody, SettleUpResponse } from "../types/money";
import { buildOverview, emptyOverview, PersonInfo, round2 } from "./moneyMath";
import { notify } from "./notifications";
import { emitMoneyChanged, emitToTravel } from "./realtime";
import { TRAVEL_EVENTS } from "../types/realtime";
import { isSelf } from "./socketAuth";
import { parseObjectId, parseObjectIds } from "../util/mongoIds";

/*

-----------
Cached data
-----------
"money-overview=" + user_id -> Riepilogo economico completo di un utente

La chiave dipende dai pagamenti di TUTTI i viaggi a cui l'utente partecipa,
quindi ogni mutazione su un post di tipo "payments" deve invalidarla per
ogni partecipante del viaggio: vedi invalidateMoneyCache(), chiamata da
createPost/updatePayment/deletePost in func/post.ts e da settleUp qui.

*/

const GENERIC_ERROR = "Errore esecuzione query";
const OVERVIEW_TTL = 120;

function postsCollection() {
    return mongoConnection.db(DB_NAME).collection<PostDocument>("posts");
}

function travelsCollection() {
    return mongoConnection.db(DB_NAME).collection<TravelDocument>("travels");
}

function userCollection() {
    return mongoConnection.db(DB_NAME).collection<UserDocument>("user");
}

// =====================================================================================
// Cache
// =====================================================================================

/**
 * Invalida il riepilogo Money di tutti i partecipanti di un viaggio.
 * Va chiamata dopo ogni creazione/modifica/eliminazione di un pagamento.
 * È volutamente "fire and forget": un fallimento qui non deve far fallire
 * la request che l'ha originata (al massimo il riepilogo resta vecchio di
 * un paio di minuti, quanto il TTL).
 */
export function invalidateMoneyCache(cache: Cache, travelId: ObjectId | string | undefined) {
    if (!travelId) return;

    const id = parseObjectId(travelId);
    if (!id) return;

    travelsCollection()
        .findOne({ _id: id }, { projection: { participants: 1 } })
        .then((travel) => {
            if (!travel) return;
            for (const participant of travel.participants) {
                const userid = participant.userid?.toString();
                if (userid) cache.del("money-overview=" + userid);
            }
        })
        .catch(() => {
            /* invalidazione best effort: vedi commento sopra */
        });
}

// =====================================================================================
// GET /api/post/takeMoneyOverview
// =====================================================================================

/**
 * Riepilogo economico completo di un utente in una sola chiamata: totali,
 * andamento mensile, spesa per viaggio, saldi per persona e lista movimenti.
 *
 * Sostituisce le quattro GET separate usate in precedenza dalla schermata
 * Money (takeTotalExpenses / takeTotalToPay / takeTotalToReceive /
 * takePayedGroupByTravel), che restavano comunque incoerenti fra loro
 * perché applicavano filtri diversi sugli stessi documenti.
 *
 * L'aggregazione vera e propria è fatta in JS invece che in pipeline mongo:
 * i pagamenti dei viaggi di un singolo utente sono nell'ordine delle
 * centinaia, e ricavare in una sola passata cinque viste diverse degli
 * stessi documenti è molto più leggibile così.
 */
export async function takeMoneyOverview(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const userid = req.query.userid as string;

    if (!userid) {
        res.status(400).send("Parametro userid mancante");
        next();
        return;
    }
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    const cacheKey = "money-overview=" + userid;
    const cached = cache.get<MoneyOverview>(cacheKey);
    if (cached) {
        res.status(200).send(cached);
        next();
        return;
    }

    const userObjectId = parseObjectId(userid);
    if (!userObjectId) {
        res.status(400).send("Parametro userid non valido");
        next();
        return;
    }

    try {
        const travels = await travelsCollection()
            .find({ "participants.userid": userObjectId })
            .project<{ _id: ObjectId; name: string; closed?: boolean }>({ _id: 1, name: 1, closed: 1 })
            .toArray();

        if (travels.length === 0) {
            const empty = emptyOverview();
            cache.set(cacheKey, empty, OVERVIEW_TTL);
            res.status(200).send(empty);
            next();
            return;
        }

        const travelIds = travels.map((travel) => travel._id);
        const travelById = new Map(travels.map((travel) => [travel._id.toString(), travel]));

        const payments = (await postsCollection()
            .find({ travel: { $in: travelIds }, type: "payments" } as any)
            .sort({ dateTime: -1 })
            .toArray()) as PaymentPost[];

        // Un'unica lettura per tutti i nomi che serviranno (creatori + debitori),
        // invece di una query per riga come faceva la vecchia schermata.
        const peopleIds = new Set<string>();
        for (const payment of payments) {
            if (payment.creator) peopleIds.add(payment.creator.toString());
            for (const destinator of payment.destinator || []) {
                if (destinator.userid) peopleIds.add(String(destinator.userid));
            }
        }

        const people = await usersById([...peopleIds]);

        const overview = buildOverview(userid, payments, travelById, people);
        cache.set(cacheKey, overview, OVERVIEW_TTL);
        res.status(200).send(overview);
    } catch (err) {
        console.log(GENERIC_ERROR, err);
        res.status(500).send(GENERIC_ERROR);
    } finally {
        next();
    }
}


async function usersById(ids: string[]): Promise<Map<string, PersonInfo>> {
    // Id non validi (dato legacy) vengono semplicemente ignorati, non risolti.
    const objectIds = parseObjectIds(ids);

    const map = new Map<string, PersonInfo>();
    if (objectIds.length === 0) return map;

    const users = await userCollection()
        .find({ _id: { $in: objectIds } })
        .project<{ _id: ObjectId; name: string; surname: string; username: string }>({
            _id: 1,
            name: 1,
            surname: 1,
            username: 1,
        })
        .toArray();

    for (const user of users) {
        map.set(user._id.toString(), {
            _id: user._id.toString(),
            name: user.name,
            surname: user.surname,
            username: user.username,
        });
    }

    return map;
}

// =====================================================================================
// POST /api/post/settleUp
// =====================================================================================

/**
 * Salda in blocco tutte le quote aperte che una persona ha verso di me.
 *
 * Solo il CREDITORE (cioè il creatore dei pagamenti) può eseguirla: è la
 * stessa regola già applicata dalla schermata "Dettagli pagamento", dove
 * la riga del destinatario è toccabile solo dal creatore. Il debitore non
 * può quindi azzerarsi il debito da solo; per avvisare di aver pagato usa
 * notifyDebt con kind "paid".
 */
export async function settleUp(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { otherUserId, travelid } = req.body as SettleUpBody;
    // Il creditore è sempre chi chiama, mai un valore dichiarato nel body:
    // era questo il modo in cui chiunque poteva marcare come saldati i
    // pagamenti creati da un altro utente.
    const userid = req.auth?.userId as string;

    if (!userid || !otherUserId) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }

    const creatorObjectId = parseObjectId(userid);
    if (!creatorObjectId) {
        res.status(400).send("Parametro userid non valido");
        next();
        return;
    }

    const filter: Record<string, unknown> = {
        type: "payments",
        creator: creatorObjectId,
        destinator: { $elemMatch: { userid: otherUserId, payed: false } },
    };

    if (travelid) {
        const travelObjectId = parseObjectId(travelid);
        if (!travelObjectId) {
            res.status(400).send("Parametro travelid non valido");
            next();
            return;
        }
        filter.travel = travelObjectId;
    }

    try {
        const payments = (await postsCollection().find(filter as any).toArray()) as PaymentPost[];

        let settledCount = 0;
        let settledAmount = 0;

        await Promise.all(
            payments.map(async (payment) => {
                const nextDestinator = payment.destinator.map((entry) =>
                    String(entry.userid) === otherUserId && !entry.payed
                        ? { ...entry, payed: true }
                        : entry
                );

                settledCount += 1;
                settledAmount += Number(payment.amount) || 0;

                await postsCollection().updateOne(
                    { _id: payment._id },
                    { $set: { destinator: nextDestinator } } as any
                );

                cache.del("travel-post=" + payment.travel);
            })
        );

        // I riepiloghi di entrambe le parti (e degli altri partecipanti) cambiano.
        const touchedTravels = new Set(payments.map((payment) => payment.travel.toString()));
        for (const travel of touchedTravels) {
            invalidateMoneyCache(cache, travel);
            // Stesso ragionamento dell'invalidazione, ma in tempo reale: il
            // saldo può toccare più viaggi in un colpo solo, e chi ha aperta
            // la tab Money o il feed di uno di quei viaggi deve vederlo subito.
            emitMoneyChanged(travel, userid);
            emitToTravel(travel, TRAVEL_EVENTS.POST_UPDATED, { postId: null, reason: "payment", actorId: userid });
        }

        const response: SettleUpResponse = {
            settledCount,
            settledAmount: round2(settledAmount),
        };

        res.status(200).send(response);

        // Il debitore scopre di essere a posto solo se glielo diciamo: è il
        // creditore a saldare, dall'altra parte non c'è nessuna azione.
        if (settledCount > 0) {
            notify({
                type: "payment_settled",
                to: [otherUserId],
                actor: userid,
                travel: travelid ?? null,
                title: "Debito saldato",
                body: `{actor} ha registrato il tuo pagamento di € ${round2(settledAmount).toFixed(2)} ✅`,
                target: { screen: "Money", root: true },
                cache,
            });
        }
    } catch (err) {
        console.log(GENERIC_ERROR, err);
        res.status(500).send(GENERIC_ERROR);
    } finally {
        next();
    }
}

// =====================================================================================
// POST /api/post/notifyDebt
// =====================================================================================

/**
 * Push "una tantum" legata ai soldi: il sollecito del creditore e
 * l'avviso "ho pagato" del debitore. Sostituisce il placeholder
 * ("L'invio dei promemoria sarà disponibile presto") della schermata
 * Dettagli pagamento.
 */
export async function notifyDebt(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { toUserId, kind, amount, travelName } = req.body as NotifyDebtBody;
    // Il mittente è chi chiama, non un valore dichiarato: altrimenti chiunque
    // poteva mandare un promemoria/una dichiarazione di pagamento a nome di
    // un altro utente.
    const fromUserId = req.auth?.userId as string;

    if (!fromUserId || !toUserId || (kind !== "reminder" && kind !== "paid")) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }

    try {
        const cifra = typeof amount === "number" && amount > 0 ? ` di € ${amount.toFixed(2)}` : "";
        const dove = travelName ? ` per "${travelName}"` : "";

        // L'invio (e la scrittura nel centro notifiche) passa dal dispatcher:
        // qui prima si costruivano i messaggi Expo a mano, senza leggere i
        // ticket di ritorno e quindi senza mai ripulire i token morti.
        await notify({
            type: kind === "reminder" ? "payment_reminder" : "payment_paid",
            to: [toUserId],
            actor: fromUserId,
            title: kind === "reminder" ? "Promemoria pagamento" : "Pagamento dichiarato",
            body:
                kind === "reminder"
                    ? `{actor} ti ricorda il pagamento${cifra}${dove} 💸`
                    : `{actor} ha segnato come pagato il debito${cifra}${dove} ✅`,
            target: { screen: "Money", root: true },
            cache,
        });

        res.status(200).send({ sent: 1 });
    } catch (err) {
        console.log(GENERIC_ERROR, err);
        if (!res.headersSent) res.status(500).send(GENERIC_ERROR);
    } finally {
        next();
    }
}
