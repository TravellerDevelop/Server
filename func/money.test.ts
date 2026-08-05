import { ObjectId } from "mongodb";
import { PaymentPost, PostDestinator } from "../types/post";
import { buildOverview, lastTwelveMonths, PersonInfo, round2, TravelRef } from "./moneyMath";

/* ============================================================
   Test del calcolo del riepilogo Money.

   Il modulo sotto test è puro (nessun accesso a mongo né a
   ../server), quindi qui non serve né database né app avviata.

   Promemoria: `amount` è la QUOTA PRO CAPITE e `destinator` non
   contiene il creatore. Metà dei bug della vecchia schermata
   nasceva dal trattare `amount` come totale della spesa.
   ============================================================ */

const ME = "aaaaaaaaaaaaaaaaaaaaaaa1";
const ANNA = "aaaaaaaaaaaaaaaaaaaaaaa2";
const BRUNO = "aaaaaaaaaaaaaaaaaaaaaaa3";

const TRAVEL_A = new ObjectId("bbbbbbbbbbbbbbbbbbbbbbb1");
const TRAVEL_B = new ObjectId("bbbbbbbbbbbbbbbbbbbbbbb2");

/** "adesso" fisso, così i test non dipendono dal giorno in cui girano. */
const NOW = new Date(2026, 7, 15); // 15 agosto 2026

const travels: Map<string, TravelRef> = new Map([
    [TRAVEL_A.toString(), { _id: TRAVEL_A, name: "Barcellona", closed: false }],
    [TRAVEL_B.toString(), { _id: TRAVEL_B, name: "Lisbona", closed: true }],
]);

const people: Map<string, PersonInfo> = new Map([
    [ME, { _id: ME, name: "Pietro", surname: "Bossolasco", username: "pietro" }],
    [ANNA, { _id: ANNA, name: "Anna", surname: "Rossi", username: "anna" }],
    [BRUNO, { _id: BRUNO, name: "Bruno", surname: "Verdi", username: "bruno" }],
]);

let counter = 0;

function payment(options: {
    creator: string;
    amount: number;
    destinator: PostDestinator[];
    date?: Date;
    travel?: ObjectId;
    personal?: boolean;
    description?: string;
}): PaymentPost {
    counter += 1;
    return {
        _id: new ObjectId(String(counter).padStart(24, "c")),
        type: "payments",
        creator: new ObjectId(options.creator),
        travel: options.travel || TRAVEL_A,
        pinned: false,
        dateTime: options.date || NOW,
        amount: options.amount,
        destinator: options.destinator,
        paymentType: options.personal ? "personal" : "normal",
        description: options.description || "",
    };
}

const run = (payments: PaymentPost[]) => buildOverview(ME, payments, travels, people, NOW);

describe("round2", () => {
    it("elimina l'errore di somma dei float", () => {
        expect(round2(0.1 + 0.2)).toBe(0.3);
        expect(round2(10.005)).toBe(10.01);
    });
});

describe("lastTwelveMonths", () => {
    it("restituisce 12 mesi che finiscono con quello corrente", () => {
        const months = lastTwelveMonths(NOW);
        expect(months).toHaveLength(12);
        expect(months[11]).toEqual({ month: "2026-08", label: "ago" });
        expect(months[0]).toEqual({ month: "2025-09", label: "set" });
    });
});

describe("buildOverview — quota a mio carico", () => {
    it("conta come debito la mia quota non pagata su un pagamento altrui", () => {
        const overview = run([
            payment({
                creator: ANNA,
                amount: 25,
                destinator: [{ userid: ME, payed: false }, { userid: BRUNO, payed: false }],
                description: "Cena",
            }),
        ]);

        expect(overview.totals.toPay).toBe(25);
        expect(overview.totals.toReceive).toBe(0);
        expect(overview.totals.net).toBe(-25);
        // La spesa a mio carico è la mia quota, non il totale della cena (50).
        expect(overview.totals.last12Months).toBe(25);

        expect(overview.balances).toHaveLength(1);
        expect(overview.balances[0]).toMatchObject({
            userid: ANNA,
            iOweThem: 25,
            theyOweMe: 0,
            net: -25,
            openCount: 1,
        });

        expect(overview.movements[0]).toMatchObject({
            direction: "out",
            myShare: 25,
            pending: 25,
            settled: false,
            peopleCount: 2,
            paidCount: 0,
        });
    });

    it("non crea debito se la mia quota è già saldata", () => {
        const overview = run([
            payment({ creator: ANNA, amount: 25, destinator: [{ userid: ME, payed: true }] }),
        ]);

        expect(overview.totals.toPay).toBe(0);
        expect(overview.balances).toHaveLength(0);
        expect(overview.movements[0].settled).toBe(true);
        // Resta comunque una spesa sostenuta.
        expect(overview.totals.last12Months).toBe(25);
    });
});

describe("buildOverview — pagamenti che ho creato io", () => {
    it("somma le quote altrui non saldate come credito", () => {
        const overview = run([
            payment({
                creator: ME,
                amount: 20,
                destinator: [
                    { userid: ANNA, payed: false },
                    { userid: BRUNO, payed: true },
                ],
            }),
        ]);

        expect(overview.totals.toReceive).toBe(20);
        expect(overview.totals.net).toBe(20);
        expect(overview.balances[0]).toMatchObject({ userid: ANNA, theyOweMe: 20, net: 20 });

        const movement = overview.movements[0];
        expect(movement.direction).toBe("in");
        // Ho anticipato la quota di due persone.
        expect(movement.myShare).toBe(40);
        expect(movement.pending).toBe(20);
        expect(movement.paidCount).toBe(1);
    });

    it("non conta come spesa personale quello che ho solo anticipato", () => {
        const overview = run([
            payment({ creator: ME, amount: 20, destinator: [{ userid: ANNA, payed: false }] }),
        ]);

        expect(overview.totals.last12Months).toBe(0);
        expect(overview.byTravel[0].total).toBe(0);
    });
});

describe("buildOverview — spese personali", () => {
    it("le conta come spesa ma non genera debiti", () => {
        const overview = run([
            payment({
                creator: ME,
                amount: 12.5,
                destinator: [{ userid: ME, payed: false }],
                personal: true,
            }),
        ]);

        expect(overview.totals.personal).toBe(12.5);
        expect(overview.totals.last12Months).toBe(12.5);
        expect(overview.totals.toPay).toBe(0);
        expect(overview.totals.toReceive).toBe(0);
        expect(overview.balances).toHaveLength(0);
        expect(overview.movements[0].direction).toBe("personal");
    });
});

describe("buildOverview — compensazione dei saldi", () => {
    it("mostra il netto quando due persone si devono a vicenda", () => {
        const overview = run([
            payment({ creator: ME, amount: 30, destinator: [{ userid: ANNA, payed: false }] }),
            payment({ creator: ANNA, amount: 10, destinator: [{ userid: ME, payed: false }] }),
        ]);

        expect(overview.balances).toHaveLength(1);
        expect(overview.balances[0]).toMatchObject({
            userid: ANNA,
            theyOweMe: 30,
            iOweThem: 10,
            net: 20,
            openCount: 2,
        });
        expect(overview.totals.net).toBe(20);
    });
});

describe("buildOverview — aggregazioni", () => {
    it("ignora i pagamenti che non mi riguardano", () => {
        const overview = run([
            payment({ creator: ANNA, amount: 50, destinator: [{ userid: BRUNO, payed: false }] }),
        ]);

        expect(overview.totals.movementsCount).toBe(0);
        expect(overview.movements).toHaveLength(0);
        expect(overview.byTravel).toHaveLength(0);
    });

    it("colloca ogni spesa nel mese giusto e taglia fuori quelle più vecchie di 12 mesi", () => {
        const overview = run([
            payment({
                creator: ANNA,
                amount: 40,
                destinator: [{ userid: ME, payed: true }],
                date: new Date(2026, 6, 3), // luglio 2026
            }),
            payment({
                creator: ANNA,
                amount: 100,
                destinator: [{ userid: ME, payed: true }],
                date: new Date(2024, 0, 3), // gennaio 2024: fuori finestra
            }),
        ]);

        const luglio = overview.byMonth.find((point) => point.month === "2026-07");
        expect(luglio?.total).toBe(40);
        expect(overview.totals.last12Months).toBe(40);
        // Il movimento vecchio resta in elenco, ma non nei totali della finestra.
        expect(overview.totals.movementsCount).toBe(2);
    });

    it("distingue ultimi 30 giorni e ultimi 12 mesi", () => {
        const overview = run([
            payment({
                creator: ANNA,
                amount: 15,
                destinator: [{ userid: ME, payed: true }],
                date: new Date(2026, 7, 10), // 5 giorni fa
            }),
            payment({
                creator: ANNA,
                amount: 35,
                destinator: [{ userid: ME, payed: true }],
                date: new Date(2026, 2, 10), // 5 mesi fa
            }),
        ]);

        expect(overview.totals.last30Days).toBe(15);
        expect(overview.totals.last12Months).toBe(50);
    });

    it("raggruppa per viaggio e ordina per spesa decrescente", () => {
        const overview = run([
            payment({
                creator: ANNA,
                amount: 10,
                destinator: [{ userid: ME, payed: false }],
                travel: TRAVEL_A,
            }),
            payment({
                creator: BRUNO,
                amount: 80,
                destinator: [{ userid: ME, payed: true }],
                travel: TRAVEL_B,
            }),
        ]);

        expect(overview.byTravel.map((row) => row.name)).toEqual(["Lisbona", "Barcellona"]);
        expect(overview.byTravel[0]).toMatchObject({ total: 80, pending: 0, closed: true });
        expect(overview.byTravel[1]).toMatchObject({ total: 10, pending: 10, closed: false });
    });

    it("non accumula errori di virgola mobile sulle somme", () => {
        const overview = run([
            payment({ creator: ANNA, amount: 0.1, destinator: [{ userid: ME, payed: false }] }),
            payment({ creator: ANNA, amount: 0.2, destinator: [{ userid: ME, payed: false }] }),
        ]);

        expect(overview.totals.toPay).toBe(0.3);
        expect(overview.balances[0].iOweThem).toBe(0.3);
    });
});
