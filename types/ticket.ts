import { ObjectId } from "mongodb";

export interface TicketAirport {
    iata: string;
    name: string;
}

export interface TicketCompany {
    name: string;
    iata: string;
    icao: string;
}

/** Documento della collection "tickets". */
export interface TicketDocument {
    _id: ObjectId;
    name: string;
    surname: string;
    from: TicketAirport;
    to: TicketAirport;
    company: TicketCompany;
    flightNumber: string;
    aircraft: string;
    qrdata: string;
    qrtype: number;
    title: string;
    date: Date;
    creator: ObjectId;
    seat: string;
    /** Presente solo se il biglietto è stato condiviso da un altro utente (vedi shareTicket in func/tickets.ts). */
    sharedBy?: ObjectId;

    // --- Campi opzionali letti dal barcode IATA-BCBP e/o dall'arricchimento
    // via api/tickets/lookupFlight (vedi func/flights.ts). Mirror in
    // Mobile-App/Traveller/shared/types/api.ts (ApiTicket).
    compartmentCode?: string;
    classLabel?: string;
    checkInSequence?: string;
    pnr?: string;
    aircraftReg?: string;
    departureTerminal?: string;
    departureGate?: string;
    departureCheckInDesk?: string;
    departureTimeLocal?: string;
    arrivalTerminal?: string;
    arrivalGate?: string;
    arrivalBaggageBelt?: string;
    arrivalTimeLocal?: string;
    status?: string;
}

// ======================================================================
// Request DTO
// ======================================================================

/** Payload inviato dal client per un nuovo biglietto: creator/date arrivano ancora come stringhe. */
export type NewTicketInput = Omit<TicketDocument, "_id" | "creator" | "date" | "sharedBy"> & {
    creator: string;
    date: string;
};

export interface CreateTicketBody {
    data: NewTicketInput;
}

export interface DeleteTicketBody {
    id: string;
}

export interface ShareTicketBody {
    userid: string;
    createBy: string;
    content: NewTicketInput;
}

// ======================================================================
// Response DTO
// ======================================================================

/** Biglietto restituito da takeTickets: sharedBy è risolto nello username (o assente). */
export type TicketWithResolvedSharedBy = Omit<TicketDocument, "sharedBy"> & {
    sharedBy?: string;
};
