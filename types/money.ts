import { ObjectId } from "mongodb";

/* ============================================================
   Tipi del dominio "Money" (riepilogo economico di un utente).

   Nota sul modello dati dei pagamenti (collection "posts",
   type: "payments") — vale per tutto questo file:

   - `amount` NON è il totale della spesa ma la QUOTA PRO CAPITE:
     ogni elemento di `destinator` deve quella cifra.
   - `destinator` per i pagamenti "normal" contiene gli ALTRI
     partecipanti, non il creatore: il creatore ha anticipato ed è
     quindi il creditore.
   - per i pagamenti "personal" `destinator` contiene solo il
     creatore stesso: è una spesa personale, non genera debiti.

   Da qui discendono le tre grandezze mostrate in app:
   - spesa a mio carico  = somma delle mie quote (+ spese personali)
   - da pagare           = mie quote ancora `payed: false`
   - da ricevere         = quote altrui `payed: false` sui pagamenti
                           che ho creato io
   ============================================================ */

/** Verso di un movimento rispetto all'utente che guarda la schermata. */
export type MoneyDirection = "in" | "out" | "personal";

/** Totali in cima alla schermata Money. */
export interface MoneyTotals {
    /** Quota a mio carico sui pagamenti degli ultimi 12 mesi. */
    last12Months: number;
    /** Idem, ma limitato agli ultimi 30 giorni. */
    last30Days: number;
    /** Somma delle mie quote non ancora saldate. */
    toPay: number;
    /** Somma delle quote altrui non saldate sui pagamenti creati da me. */
    toReceive: number;
    /** toReceive - toPay: positivo se sono in credito. */
    net: number;
    /** Spese personali (paymentType "personal") degli ultimi 12 mesi. */
    personal: number;
    /** Numero di pagamenti che mi riguardano, in tutto lo storico. */
    movementsCount: number;
}

/** Un punto del grafico di andamento mensile. */
export interface MoneyMonthPoint {
    /** Chiave ordinabile "YYYY-MM". */
    month: string;
    /** Etichetta breve già localizzata ("gen", "feb", …). */
    label: string;
    /** Quota a mio carico nel mese. */
    total: number;
}

/** Riga del riepilogo per viaggio. */
export interface MoneyTravelRow {
    travelId: string;
    name: string;
    /** Quota a mio carico su quel viaggio. */
    total: number;
    /** Quanto di quel totale è ancora da saldare. */
    pending: number;
    /** Numero di pagamenti del viaggio che mi riguardano. */
    count: number;
    closed: boolean;
}

/** Saldo netto con una singola persona, aggregato su tutti i viaggi in comune. */
export interface MoneyBalance {
    userid: string;
    name: string;
    surname: string;
    username: string;
    /** Quanto questa persona deve a me (quote non saldate su miei pagamenti). */
    theyOweMe: number;
    /** Quanto io devo a questa persona. */
    iOweThem: number;
    /** theyOweMe - iOweThem. */
    net: number;
    /** Numero di quote aperte che compongono il saldo. */
    openCount: number;
}

/** Dati minimi del creatore di un pagamento, per la lista movimenti. */
export interface MoneyMovementCreator {
    _id: string;
    name: string;
    surname: string;
    username: string;
}

/** Una riga della lista movimenti. */
export interface MoneyMovement {
    _id: string;
    travelId: string;
    travelName: string;
    description: string;
    /** ISO string. */
    dateTime: string;
    paymentType: "normal" | "personal";
    direction: MoneyDirection;
    /** Quota pro capite del pagamento. */
    amount: number;
    /**
     * Cifra che riguarda me:
     * - "out"/"personal": la mia quota;
     * - "in": la somma delle quote degli altri (quanto ho anticipato).
     */
    myShare: number;
    /** Parte di `myShare` ancora non saldata. */
    pending: number;
    /** true se, per quel che mi riguarda, il movimento è chiuso. */
    settled: boolean;
    peopleCount: number;
    paidCount: number;
    creator: MoneyMovementCreator;
}

/** Payload completo di GET /api/post/takeMoneyOverview. */
export interface MoneyOverview {
    totals: MoneyTotals;
    byMonth: MoneyMonthPoint[];
    byTravel: MoneyTravelRow[];
    balances: MoneyBalance[];
    movements: MoneyMovement[];
}

// ======================================================================
// Request DTO
// ======================================================================

/**
 * POST /api/post/settleUp — il CREDITORE dichiara saldate tutte le quote
 * aperte di una persona. Solo chi ha creato i pagamenti può farlo: è la
 * stessa regola già applicata dalla schermata "Dettagli pagamento".
 */
export interface SettleUpBody {
    /** Chi effettua l'operazione: deve essere il creatore dei pagamenti. */
    userid: string;
    /** Persona di cui si azzerano i debiti. */
    otherUserId: string;
    /** Se valorizzato, limita l'operazione a un singolo viaggio. */
    travelid?: string;
}

export interface SettleUpResponse {
    /** Numero di quote marcate come saldate. */
    settledCount: number;
    /** Importo complessivo saldato. */
    settledAmount: number;
}

/** Tipo di notifica inviabile dalla schermata Money / Dettagli pagamento. */
export type MoneyNotificationKind = "reminder" | "paid";

/**
 * POST /api/post/notifyDebt — invia una push:
 * - "reminder": il creditore sollecita il debitore;
 * - "paid": il debitore avvisa il creditore di aver pagato.
 */
export interface NotifyDebtBody {
    fromUserId: string;
    toUserId: string;
    kind: MoneyNotificationKind;
    /** Importo citato nel messaggio; opzionale. */
    amount?: number;
    /** Nome del viaggio citato nel messaggio; opzionale. */
    travelName?: string;
}

// ======================================================================
// Documenti di appoggio
// ======================================================================

/** Proiezione usata internamente da takeMoneyOverview. */
export interface MoneyTravelRef {
    _id: ObjectId;
    name: string;
    closed?: boolean;
}
