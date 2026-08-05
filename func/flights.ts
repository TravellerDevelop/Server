import axios from "axios";
import { Request, Response } from "express";
import { Cache } from "../types/common";
import { FlightAirportInfo, FlightLookupResult } from "../types/flight";

/* Proxy verso AeroDataBox (RapidAPI): prima la chiave era incorporata nel
 * client mobile (leggibile decompilando l'app), qui invece resta solo lato
 * server. Il client chiama GET /api/tickets/lookupFlight passando i campi già
 * letti dal barcode del boarding pass (vettore, numero volo, data), non più
 * limitato alle 4 compagnie hardcoded del vecchio codice.
 *
 * AeroDataBox spesso non ha gate/terminal per voli lontani nel tempo (non
 * ancora assegnati dall'aeroporto) o esaurisce la quota gratuita: in quel
 * caso si prova un secondo provider, Aviationstack (aviationstack.com),
 * gratuito fino a 100 richieste/mese, usato solo come fallback per non
 * consumarne la quota ad ogni apertura biglietto. Aviationstack non espone
 * checkInDesk né i dati aeromobile: quei campi restano quindi affidati solo
 * ad AeroDataBox quando disponibile. */

const AERODATABOX_HOST = "aerodatabox.p.rapidapi.com";
const AERODATABOX_BASE_URL = "https://aerodatabox.p.rapidapi.com";
// Il piano free di Aviationstack richiede HTTP, non HTTPS (limite del loro piano gratuito, non nostro).
const AVIATIONSTACK_BASE_URL = "http://api.aviationstack.com/v1/flights";
const FLIGHT_CACHE_TTL = 60 * 30; // 30 minuti: gate/terminal possono cambiare, ma non serve interrogare l'API ad ogni apertura del biglietto

function mapAirport(raw: any): FlightAirportInfo {
    if (!raw) return {};
    return {
        iata: raw.airport?.iata,
        icao: raw.airport?.icao,
        name: raw.airport?.name,
        municipality: raw.airport?.municipalityName,
        country: raw.airport?.countryCode,
        timeZone: raw.airport?.timeZone,
        terminal: raw.terminal || undefined,
        gate: raw.gate || undefined,
        checkInDesk: raw.checkInDesk || undefined,
        baggageBelt: raw.baggageBelt || undefined,
        scheduledTimeLocal: raw.scheduledTime?.local || undefined,
    };
}

function normalizeFlight(flightNumber: string, raw: any): FlightLookupResult {
    return {
        flightNumber,
        airline: {
            name: raw.airline?.name || "",
            iata: raw.airline?.iata,
            icao: raw.airline?.icao,
        },
        aircraft: raw.aircraft
            ? { model: raw.aircraft.model, registration: raw.aircraft.reg }
            : undefined,
        departure: mapAirport(raw.departure),
        arrival: mapAirport(raw.arrival),
        status: raw.status,
        codeshareStatus: raw.codeshareStatus,
    };
}

async function requestAeroDataBox(path: string) {
    const apiKey = process.env.AERODATABOX_API_KEY;
    if (!apiKey) {
        throw new Error("AERODATABOX_API_KEY non configurata sul server");
    }

    return axios.get(AERODATABOX_BASE_URL + path, {
        headers: {
            "X-RapidAPI-Key": apiKey,
            "X-RapidAPI-Host": AERODATABOX_HOST,
        },
        timeout: 8000,
    });
}

/** Mappa il blocco "departure"/"arrival" di Aviationstack (campi piatti,
 *  niente wrapper "airport") sul DTO condiviso con AeroDataBox. */
function mapAviationstackAirport(raw: any): FlightAirportInfo {
    if (!raw) return {};
    return {
        iata: raw.iata || undefined,
        icao: raw.icao || undefined,
        name: raw.airport || undefined,
        timeZone: raw.timezone || undefined,
        terminal: raw.terminal || undefined,
        gate: raw.gate || undefined,
        baggageBelt: raw.baggage || undefined,
        scheduledTimeLocal: raw.scheduled || undefined,
    };
}

function normalizeAviationstackFlight(flightNumber: string, raw: any): FlightLookupResult {
    return {
        flightNumber,
        airline: {
            name: raw.airline?.name || "",
            iata: raw.airline?.iata,
            icao: raw.airline?.icao,
        },
        // Aviationstack non restituisce info aeromobile sull'endpoint /flights.
        departure: mapAviationstackAirport(raw.departure),
        arrival: mapAviationstackAirport(raw.arrival),
        status: raw.flight_status,
    };
}

async function requestAviationstack(flightNumber: string, date: string) {
    const apiKey = process.env.AVIATIONSTACK_API_KEY;
    if (!apiKey) {
        throw new Error("AVIATIONSTACK_API_KEY non configurata sul server");
    }

    return axios.get(AVIATIONSTACK_BASE_URL, {
        params: {
            access_key: apiKey,
            flight_iata: flightNumber,
            flight_date: date || undefined,
        },
        timeout: 8000,
    });
}

/** true se mancano gate/terminal, i campi che più spesso Aviationstack riesce
 *  a colmare quando AeroDataBox non li ha ancora (o non li avrà mai per quel
 *  volo/quota); include il caso "nessun risultato" da AeroDataBox. */
function needsAviationstackFallback(result: FlightLookupResult | null): boolean {
    if (!result) return true;
    return !result.departure.gate || !result.departure.terminal;
}

/** Combina i due DTO campo per campo: AeroDataBox resta la fonte primaria
 *  (più completa: aeromobile, check-in desk, nastro bagagli), Aviationstack
 *  riempie solo i buchi. */
function mergeAirport(primary: FlightAirportInfo, fallback: FlightAirportInfo): FlightAirportInfo {
    return {
        iata: primary.iata || fallback.iata,
        icao: primary.icao || fallback.icao,
        name: primary.name || fallback.name,
        municipality: primary.municipality || fallback.municipality,
        country: primary.country || fallback.country,
        timeZone: primary.timeZone || fallback.timeZone,
        terminal: primary.terminal || fallback.terminal,
        gate: primary.gate || fallback.gate,
        checkInDesk: primary.checkInDesk || fallback.checkInDesk,
        baggageBelt: primary.baggageBelt || fallback.baggageBelt,
        scheduledTimeLocal: primary.scheduledTimeLocal || fallback.scheduledTimeLocal,
    };
}

function mergeFlightResults(
    primary: FlightLookupResult | null,
    fallback: FlightLookupResult | null
): FlightLookupResult | null {
    if (!primary) return fallback;
    if (!fallback) return primary;
    return {
        flightNumber: primary.flightNumber || fallback.flightNumber,
        airline: {
            name: primary.airline.name || fallback.airline.name,
            iata: primary.airline.iata || fallback.airline.iata,
            icao: primary.airline.icao || fallback.airline.icao,
        },
        aircraft: primary.aircraft || fallback.aircraft,
        departure: mergeAirport(primary.departure, fallback.departure),
        arrival: mergeAirport(primary.arrival, fallback.arrival),
        status: primary.status || fallback.status,
        codeshareStatus: primary.codeshareStatus || fallback.codeshareStatus,
    };
}

/**
 * GET /api/tickets/lookupFlight?carrier=FR&flightNumber=1234&date=2026-08-13
 *
 * Risponde sempre 200: `null` se il volo non è stato trovato o l'arricchimento
 * fallisce per qualunque motivo (rete, quota RapidAPI esaurita, volo troppo nel
 * futuro/passato per la fonte dati). Il biglietto scansionato resta comunque
 * utilizzabile lato client con i soli dati letti dal barcode: l'arricchimento
 * è un "di più", mai un blocco alla creazione del biglietto.
 */
export async function lookupFlight(req: Request, res: Response, cache: Cache) {
    const carrier = String(req.query.carrier || "").trim().toUpperCase();
    const flightNumberRaw = String(req.query.flightNumber || "").trim();
    const date = String(req.query.date || "").trim(); // atteso YYYY-MM-DD

    if (!carrier || !flightNumberRaw) {
        res.status(200).send(null);
        return;
    }

    const flightNumber = carrier + flightNumberRaw.replace(/^0+(?=\d)/, "");
    const cacheKey = "flight=" + flightNumber + "@" + date;
    const cached = cache.get<FlightLookupResult | null>(cacheKey);
    if (cached !== undefined) {
        res.status(200).send(cached);
        return;
    }

    let primaryResult: FlightLookupResult | null = null;
    try {
        const path = date
            ? `/flights/number/${flightNumber}/${date}`
            : `/flights/number/${flightNumber}`;

        const { data } = await requestAeroDataBox(path);
        const match = Array.isArray(data) ? data[0] : data;
        primaryResult = match ? normalizeFlight(flightNumber, match) : null;
    } catch (err) {
        // Nessun errore bloccante verso il client: AeroDataBox può fallire
        // (rete, quota esaurita) e si prosegue comunque con Aviationstack.
        primaryResult = null;
    }

    let result = primaryResult;
    if (needsAviationstackFallback(primaryResult)) {
        try {
            const { data } = await requestAviationstack(flightNumber, date);
            const match = Array.isArray(data?.data) ? data.data[0] : null;
            const fallbackResult = match ? normalizeAviationstackFlight(flightNumber, match) : null;
            result = mergeFlightResults(primaryResult, fallbackResult);
        } catch (err) {
            // Anche qui: Aviationstack non configurata/quota esaurita/rete
            // giù non deve bloccare la risposta, si resta con AeroDataBox.
        }
    }

    const cacheTtl = result ? FLIGHT_CACHE_TTL : 60 * 5; // TTL corto per gli esiti vuoti, riprova prima che per un match confermato
    cache.set(cacheKey, result, cacheTtl);
    res.status(200).send(result);
}
