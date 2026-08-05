import { ObjectId } from "mongodb";
import { PaymentPost } from "../types/post";
import {
    MoneyBalance,
    MoneyMovement,
    MoneyOverview,
    MoneyTravelRow,
} from "../types/money";

/* ============================================================
   Calcolo puro del riepilogo Money.

   Sta in un modulo a sé — senza import di ../server né di mongo —
   così è testabile senza avviare l'applicazione (vedi money.test.ts).
   func/money.ts si occupa solo di leggere i documenti e passarli qui.

   Convenzioni del modello dati (vedi types/money.ts):
   `amount` è la quota pro capite, `destinator` contiene gli altri
   partecipanti e non il creatore, i pagamenti "personal" hanno come
   unico destinatario il creatore e non generano debiti.
   ============================================================ */

const MONTH_LABELS = [
    "gen", "feb", "mar", "apr", "mag", "giu",
    "lug", "ago", "set", "ott", "nov", "dic",
];

/** Tetto alla lista movimenti: oltre non è navigabile e appesantisce la response. */
export const MOVEMENTS_LIMIT = 200;

export interface TravelRef {
    _id: ObjectId | string;
    name: string;
    closed?: boolean;
}

export interface PersonInfo {
    _id: string;
    name: string;
    surname: string;
    username: string;
}

/** Arrotonda ai centesimi: le somme di float accumulano errore (0.1 + 0.2). */
export function round2(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function monthKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** I 12 mesi che finiscono con quello di `now`, dal più vecchio al più recente. */
export function lastTwelveMonths(now: Date = new Date()): { month: string; label: string }[] {
    const months: { month: string; label: string }[] = [];

    for (let i = 11; i >= 0; i--) {
        const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({ month: monthKey(date), label: MONTH_LABELS[date.getMonth()] });
    }

    return months;
}

export function emptyOverview(now: Date = new Date()): MoneyOverview {
    return {
        totals: {
            last12Months: 0,
            last30Days: 0,
            toPay: 0,
            toReceive: 0,
            net: 0,
            personal: 0,
            movementsCount: 0,
        },
        byMonth: lastTwelveMonths(now).map(({ month, label }) => ({ month, label, total: 0 })),
        byTravel: [],
        balances: [],
        movements: [],
    };
}

/**
 * Cuore del riepilogo: una sola passata sui pagamenti che produce
 * contemporaneamente totali, serie mensile, spesa per viaggio, saldi per
 * persona e movimenti.
 *
 * @param payments già ordinati per data decrescente.
 */
export function buildOverview(
    userid: string,
    payments: PaymentPost[],
    travelById: Map<string, TravelRef>,
    people: Map<string, PersonInfo>,
    now: Date = new Date()
): MoneyOverview {
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const months = lastTwelveMonths(now);
    const monthTotals = new Map<string, number>(months.map(({ month }) => [month, 0]));

    const travelTotals = new Map<string, MoneyTravelRow>();
    const balances = new Map<string, MoneyBalance>();
    const movements: MoneyMovement[] = [];

    let last12Months = 0;
    let last30Days = 0;
    let toPay = 0;
    let toReceive = 0;
    let personal = 0;
    let movementsCount = 0;

    for (const payment of payments) {
        const amount = Number(payment.amount) || 0;
        const destinator = payment.destinator || [];
        const creatorId = payment.creator ? payment.creator.toString() : "";
        const isCreator = creatorId === userid;
        const isPersonal = payment.paymentType === "personal";
        const myEntry = destinator.find((entry) => String(entry.userid) === userid);

        // Un pagamento mi riguarda se l'ho creato io o se sono fra i destinatari.
        if (!isCreator && !myEntry) continue;

        const date = payment.dateTime ? new Date(payment.dateTime) : new Date(0);

        let direction: MoneyMovement["direction"];
        let myShare: number;
        let pending: number;

        if (isPersonal) {
            // Spesa personale: nessun debito, conta solo come spesa mia.
            direction = "personal";
            myShare = amount;
            pending = 0;
        } else if (isCreator) {
            // Ho anticipato io: gli altri mi devono la loro quota.
            const others = destinator.filter((entry) => String(entry.userid) !== userid);
            const unpaid = others.filter((entry) => !entry.payed);

            direction = "in";
            myShare = round2(amount * others.length);
            pending = round2(amount * unpaid.length);
            toReceive = round2(toReceive + pending);

            for (const entry of unpaid) {
                const balance = ensureBalance(balances, String(entry.userid), people);
                balance.theyOweMe = round2(balance.theyOweMe + amount);
                balance.openCount += 1;
            }
        } else {
            // Quota a mio carico su un pagamento anticipato da qualcun altro.
            direction = "out";
            myShare = amount;
            pending = myEntry && !myEntry.payed ? amount : 0;
            toPay = round2(toPay + pending);

            if (pending > 0 && creatorId) {
                const balance = ensureBalance(balances, creatorId, people);
                balance.iOweThem = round2(balance.iOweThem + amount);
                balance.openCount += 1;
            }
        }

        movementsCount += 1;

        // "Spesa" = quello che è effettivamente a mio carico: la mia quota sui
        // pagamenti altrui e le spese personali. Sui pagamenti che ho creato io
        // la quota del creatore non è modellata (destinator contiene solo gli
        // altri), quindi non viene conteggiata: sarebbe un anticipo, non una spesa.
        const myCost = direction === "in" ? 0 : myShare;

        if (myCost > 0 && date >= twelveMonthsAgo) {
            last12Months = round2(last12Months + myCost);
            const key = monthKey(date);
            if (monthTotals.has(key)) monthTotals.set(key, round2(monthTotals.get(key)! + myCost));
        }
        if (myCost > 0 && date >= thirtyDaysAgo) last30Days = round2(last30Days + myCost);
        if (isPersonal && date >= twelveMonthsAgo) personal = round2(personal + myCost);

        const travelId = payment.travel ? payment.travel.toString() : "";
        const travel = travelById.get(travelId);
        const travelName = travel ? travel.name : "Viaggio";

        if (travelId) {
            const row = travelTotals.get(travelId) || {
                travelId,
                name: travelName,
                total: 0,
                pending: 0,
                count: 0,
                closed: Boolean(travel?.closed),
            };
            row.total = round2(row.total + myCost);
            row.pending = round2(row.pending + (direction === "out" ? pending : 0));
            row.count += 1;
            travelTotals.set(travelId, row);
        }

        if (movements.length < MOVEMENTS_LIMIT) {
            const creator = people.get(creatorId);
            movements.push({
                _id: payment._id.toString(),
                travelId,
                travelName,
                description: payment.description || "",
                dateTime: date.toISOString(),
                paymentType: isPersonal ? "personal" : "normal",
                direction,
                amount,
                myShare,
                pending,
                settled: pending === 0,
                peopleCount: destinator.length,
                paidCount: destinator.filter((entry) => entry.payed).length,
                creator: creator || { _id: creatorId, name: "", surname: "", username: "?" },
            });
        }
    }

    return {
        totals: {
            last12Months: round2(last12Months),
            last30Days: round2(last30Days),
            toPay: round2(toPay),
            toReceive: round2(toReceive),
            net: round2(toReceive - toPay),
            personal: round2(personal),
            movementsCount,
        },
        byMonth: months.map(({ month, label }) => ({
            month,
            label,
            total: monthTotals.get(month) || 0,
        })),
        byTravel: [...travelTotals.values()].sort((a, b) => b.total - a.total),
        balances: [...balances.values()]
            .map((balance) => ({ ...balance, net: round2(balance.theyOweMe - balance.iOweThem) }))
            .filter((balance) => balance.theyOweMe > 0 || balance.iOweThem > 0)
            .sort((a, b) => Math.abs(b.net) - Math.abs(a.net)),
        movements,
    };
}

function ensureBalance(
    balances: Map<string, MoneyBalance>,
    userid: string,
    people: Map<string, PersonInfo>
): MoneyBalance {
    const existing = balances.get(userid);
    if (existing) return existing;

    const person = people.get(userid);
    const balance: MoneyBalance = {
        userid,
        name: person?.name || "",
        surname: person?.surname || "",
        username: person?.username || "?",
        theyOweMe: 0,
        iOweThem: 0,
        net: 0,
        openCount: 0,
    };

    balances.set(userid, balance);
    return balance;
}
