import NodeCache from "node-cache";

/** Cache in memoria condivisa tra le richieste (istanza unica creata in server.ts). */
export type Cache = NodeCache;

/** Risposta generica per gli endpoint che restituiscono solo un esito/errore testuale. */
export type TextResponse = string;
