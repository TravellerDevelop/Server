import {
    _setSecretForTests,
    issueSocketToken,
    TOKEN_TTL_MS,
    verifySocketToken,
} from "./socketAuth";

/**
 * Test del token del canale realtime.
 *
 * Come moneyMath.test.ts e notificationRules.test.ts, gira senza mongo e
 * senza avviare il server: socketAuth.ts importa solo `crypto`, ed è tenuto
 * così apposta perché è il punto in cui si decide chi è chi.
 */

const SECRET = "segreto-di-test-abbastanza-lungo";
const USER = "507f1f77bcf86cd799439011";
const OTHER = "507f1f77bcf86cd799439012";

beforeEach(() => {
    _setSecretForTests(SECRET);
});

describe("issueSocketToken / verifySocketToken", () => {
    test("un token appena emesso è valido per il suo utente", () => {
        const token = issueSocketToken(USER);
        expect(verifySocketToken(USER, token)).toEqual({ ok: true, userId: USER });
    });

    test("il token di un utente non vale per un altro", () => {
        // È il caso che il vecchio 'identify' non copriva affatto: bastava
        // dichiarare un userid qualsiasi per entrare nella stanza altrui.
        const token = issueSocketToken(USER);
        expect(verifySocketToken(OTHER, token)).toEqual({ ok: false, reason: "invalid" });
    });

    test("token scaduto", () => {
        const issuedAt = Date.now();
        const token = issueSocketToken(USER, issuedAt);
        const afterExpiry = issuedAt + TOKEN_TTL_MS + 1;
        expect(verifySocketToken(USER, token, afterExpiry)).toEqual({ ok: false, reason: "expired" });
    });

    test("token valido fino all'istante prima della scadenza", () => {
        const issuedAt = Date.now();
        const token = issueSocketToken(USER, issuedAt);
        const justBefore = issuedAt + TOKEN_TTL_MS - 1;
        expect(verifySocketToken(USER, token, justBefore).ok).toBe(true);
    });

    test("firma manomessa", () => {
        const token = issueSocketToken(USER);
        const parts = token.split(".");
        const tampered = [parts[0], parts[1], parts[2].replace(/.$/, (c) => (c === "a" ? "b" : "a"))].join(".");
        expect(verifySocketToken(USER, tampered)).toEqual({ ok: false, reason: "invalid" });
    });

    test("scadenza allungata a mano non passa: è dentro la firma", () => {
        const token = issueSocketToken(USER);
        const parts = token.split(".");
        const extended = [parts[0], String(Number(parts[1]) + TOKEN_TTL_MS), parts[2]].join(".");
        expect(verifySocketToken(USER, extended)).toEqual({ ok: false, reason: "invalid" });
    });

    test("formati non riconosciuti", () => {
        expect(verifySocketToken(USER, "").reason).toBe("missing");
        expect(verifySocketToken("", "qualcosa").reason).toBe("missing");
        expect(verifySocketToken(USER, undefined).reason).toBe("missing");
        expect(verifySocketToken(USER, 42).reason).toBe("missing");
        expect(verifySocketToken(USER, "senza-punti").reason).toBe("malformed");
        expect(verifySocketToken(USER, "v2.123.abc").reason).toBe("malformed");
        expect(verifySocketToken(USER, "v1.non-un-numero.abc").reason).toBe("malformed");
    });

    test("un token firmato con un altro segreto non vale", () => {
        // È lo scenario del riavvio del server senza SOCKET_SECRET: i token
        // emessi prima devono smettere di funzionare, e il client deve
        // accorgersene per chiederne uno nuovo (vedi connect_error nel
        // socketClient dell'app).
        const token = issueSocketToken(USER);
        _setSecretForTests("un-altro-segreto-lungo-abbastanza");
        expect(verifySocketToken(USER, token)).toEqual({ ok: false, reason: "invalid" });
    });

    test("due token dello stesso utente sono entrambi validi", () => {
        // Il token è stateless: emetterne uno nuovo (secondo dispositivo,
        // rilettura del profilo) non deve invalidare quello già in uso.
        const first = issueSocketToken(USER, Date.now());
        const second = issueSocketToken(USER, Date.now() + 1000);
        expect(verifySocketToken(USER, first).ok).toBe(true);
        expect(verifySocketToken(USER, second).ok).toBe(true);
    });
});
