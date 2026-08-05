
import { computeIsDebug, DB_NAME } from "./server";

describe('server config', () => {
    // ISDEBUG non è più un interruttore manuale da ricordarsi di rimettere a
    // false prima di ogni release (vedi il commento su computeIsDebug in
    // server.ts): è derivato da NODE_ENV, quindi qui si testa la funzione di
    // derivazione — deterministica, non l'ambiente in cui gira jest — invece
    // di dipendere da NODE_ENV al momento in cui questo file viene eseguito.
    test('isDebug è false in produzione', () => {
        expect(computeIsDebug("production")).toBe(false);
    });

    test('isDebug è true fuori produzione (sviluppo, test, non impostato)', () => {
        expect(computeIsDebug("development")).toBe(true);
        expect(computeIsDebug("test")).toBe(true);
        expect(computeIsDebug(undefined)).toBe(true);
    });

    test("dbName", () => {
        expect(DB_NAME).toBe("traveller")
    })
})