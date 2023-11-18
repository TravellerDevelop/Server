
import { ISDEBUG, DB_NAME } from "./server";

describe('server config', () => {
    test('isDebug', () => {
        expect(ISDEBUG).toBe(false);
    });

    test("dbName", () => {
        expect(DB_NAME).toBe("traveller")
    })
})