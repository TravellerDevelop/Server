/** DTO normalizzato restituito da GET /api/tickets/lookupFlight (vedi func/flights.ts).
 *  Mirror lato client in Mobile-App/Traveller/components/tickets/types.ts, come da
 *  convenzione già usata per l'itinerario (types.ts è copia manuale, non pacchetto condiviso). */

export interface FlightAirlineInfo {
    name: string;
    iata?: string;
    icao?: string;
}

export interface FlightAircraftInfo {
    model?: string;
    registration?: string;
}

export interface FlightAirportInfo {
    iata?: string;
    icao?: string;
    name?: string;
    municipality?: string;
    country?: string;
    timeZone?: string;
    /** Presenti solo se la fonte dati li espone per quel volo (spesso assenti per voli lontani nel tempo). */
    terminal?: string;
    gate?: string;
    checkInDesk?: string;
    baggageBelt?: string;
    scheduledTimeLocal?: string;
}

export interface FlightLookupResult {
    flightNumber: string;
    airline: FlightAirlineInfo;
    aircraft?: FlightAircraftInfo;
    departure: FlightAirportInfo;
    arrival: FlightAirportInfo;
    status?: string;
    codeshareStatus?: string;
}
