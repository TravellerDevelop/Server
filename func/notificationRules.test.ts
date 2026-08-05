/**
 * Test delle regole pure delle notifiche.
 *
 * Come func/money.test.ts, gira senza mongo e senza avviare il server:
 * `npx jest func/notificationRules.test.ts`.
 */

import { NOTIFICATION_CATALOG, NotificationType } from "../types/notification";
import { isPushAllowed, isTypeEnabled, mergeSettings, resolvePreferences } from "./notificationRules";

describe("isTypeEnabled", () => {
    it("segue il default del catalogo se l'utente non ha preferenze", () => {
        expect(isTypeEnabled("post_new", undefined)).toBe(
            NOTIFICATION_CATALOG.post_new.defaultEnabled
        );
    });

    it("rispetta lo spegnimento esplicito di un tipo configurabile", () => {
        expect(isTypeEnabled("post_new", { types: { post_new: false } })).toBe(false);
    });

    it("silenzia i tipi legati a un viaggio messo in muto", () => {
        const settings = { mutedTravels: ["viaggio-1"] };
        expect(isTypeEnabled("post_new", settings, "viaggio-1")).toBe(false);
        expect(isTypeEnabled("post_new", settings, "viaggio-2")).toBe(true);
    });

    it("non lascia spegnere i tipi non configurabili", () => {
        // I solleciti di pagamento restano anche spegnendo tutto e mettendo
        // in muto il viaggio: sono l'unico avviso di un'azione dovuta.
        expect(NOTIFICATION_CATALOG.payment_reminder.configurable).toBe(false);
        expect(
            isTypeEnabled(
                "payment_reminder",
                { types: { payment_reminder: false } as any, mutedTravels: ["v1"] },
                "v1"
            )
        ).toBe(true);
    });

    it("rifiuta un tipo che non esiste nel catalogo", () => {
        expect(isTypeEnabled("inesistente" as NotificationType, undefined)).toBe(false);
    });
});

describe("isPushAllowed", () => {
    it("è falso per i tipi che vivono solo nel centro notifiche", () => {
        expect(NOTIFICATION_CATALOG.itinerary_mode_changed.push).toBe(false);
        expect(isPushAllowed("itinerary_mode_changed", undefined)).toBe(false);
    });

    it("l'interruttore generale spegne le push configurabili", () => {
        expect(isPushAllowed("post_new", { pushEnabled: false })).toBe(false);
    });

    it("l'interruttore generale non tocca i tipi non configurabili", () => {
        expect(isPushAllowed("payment_reminder", { pushEnabled: false })).toBe(true);
    });
});

describe("resolvePreferences", () => {
    it("espone un valore per ogni tipo del catalogo", () => {
        const resolved = resolvePreferences(undefined);
        const types = Object.keys(NOTIFICATION_CATALOG) as NotificationType[];

        expect(Object.keys(resolved.types).sort()).toEqual([...types].sort());
        expect(resolved.catalog).toHaveLength(types.length);
    });

    it("push attive di default", () => {
        expect(resolvePreferences(undefined).pushEnabled).toBe(true);
        expect(resolvePreferences({ pushEnabled: false }).pushEnabled).toBe(false);
    });

    it("le scelte dell'utente vincono sui default", () => {
        const resolved = resolvePreferences({ types: { travel_updated: false } });
        expect(resolved.types.travel_updated).toBe(false);
    });

    it("porta con sé etichette e canali, così il client non li duplica", () => {
        const entry = resolvePreferences(undefined).catalog.find((item) => item.type === "post_new");
        expect(entry).toMatchObject({
            label: NOTIFICATION_CATALOG.post_new.label,
            push: true,
            center: false,
        });
    });
});

describe("mergeSettings", () => {
    it("conserva i tipi non toccati dalla patch", () => {
        const merged = mergeSettings(
            { types: { post_new: false, vote_new: false } },
            { types: { vote_new: true } }
        );
        expect(merged.types).toEqual({ post_new: false, vote_new: true });
    });

    it("scarta i tipi non configurabili anche se il client li manda", () => {
        const merged = mergeSettings(undefined, {
            types: { payment_reminder: false } as any,
        });
        expect(merged.types?.payment_reminder).toBeUndefined();
    });

    it("scarta i tipi sconosciuti", () => {
        const merged = mergeSettings(undefined, { types: { boh: true } as any });
        expect(merged.types).toEqual({});
    });

    it("mutedTravels viene sostituito solo se presente nella patch", () => {
        const current = { mutedTravels: ["v1"] };
        expect(mergeSettings(current, {}).mutedTravels).toEqual(["v1"]);
        expect(mergeSettings(current, { mutedTravels: [] }).mutedTravels).toEqual([]);
    });
});
