/**
 * Regole pure delle notifiche: quali tipi sono attivi per un utente e come
 * si risolvono le sue preferenze.
 *
 * Sta in un file a parte — come moneyMath.ts rispetto a money.ts — perché
 * non importa né mongo né ../server: si può quindi testare senza avviare
 * l'app (vedi notificationRules.test.ts).
 */

import {
    NOTIFICATION_CATALOG,
    NOTIFICATION_CATEGORY_LABELS,
    NotificationCatalogEntry,
    NotificationCategory,
    NotificationType,
    ResolvedNotificationPreferences,
    UserNotificationSettings,
} from "../types/notification";

const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_CATALOG) as NotificationType[];

/**
 * Un tipo è attivo se l'utente non l'ha spento e il viaggio non è silenziato.
 *
 * I tipi `configurable: false` ignorano entrambe le cose: sono l'unico modo
 * in cui l'utente scopre qualcosa che richiede una sua azione (una richiesta
 * di follow da accettare, un sollecito di pagamento). Silenziare un viaggio
 * non deve nascondere il fatto che qualcuno ti sta chiedendo dei soldi.
 */
export function isTypeEnabled(
    type: NotificationType,
    settings: UserNotificationSettings | undefined,
    travelId?: string | null
): boolean {
    const spec = NOTIFICATION_CATALOG[type];
    if (!spec) return false;
    if (!spec.configurable) return true;

    if (travelId && settings?.mutedTravels?.includes(travelId)) return false;

    const override = settings?.types?.[type];
    if (typeof override === "boolean") return override;
    return spec.defaultEnabled;
}

/**
 * Le push seguono anche l'interruttore generale, che però non tocca i tipi
 * non configurabili: spegnere "notifiche push" non deve far sparire i
 * solleciti di pagamento.
 */
export function isPushAllowed(
    type: NotificationType,
    settings: UserNotificationSettings | undefined
): boolean {
    const spec = NOTIFICATION_CATALOG[type];
    if (!spec?.push) return false;
    if (!spec.configurable) return true;
    return settings?.pushEnabled !== false;
}

/**
 * Default del catalogo + scelte dell'utente, nella forma che consuma il
 * client. Include il catalogo stesso, così la schermata preferenze si
 * costruisce dai dati del server e non esiste un secondo elenco di
 * etichette da tenere allineato a mano.
 */
export function resolvePreferences(
    settings: UserNotificationSettings | undefined
): ResolvedNotificationPreferences {
    const types = {} as Record<NotificationType, boolean>;
    const catalog: NotificationCatalogEntry[] = [];

    for (const type of NOTIFICATION_TYPES) {
        const spec = NOTIFICATION_CATALOG[type];
        const override = settings?.types?.[type];
        types[type] = typeof override === "boolean" ? override : spec.defaultEnabled;
        catalog.push({
            type,
            category: spec.category,
            label: spec.label,
            description: spec.description,
            configurable: spec.configurable,
            push: spec.push,
            center: spec.center,
        });
    }

    return {
        pushEnabled: settings?.pushEnabled !== false,
        mutedTravels: settings?.mutedTravels ?? [],
        types,
        catalog,
        categories: (Object.keys(NOTIFICATION_CATEGORY_LABELS) as NotificationCategory[]).map((key) => ({
            key,
            label: NOTIFICATION_CATEGORY_LABELS[key],
        })),
    };
}

/**
 * Applica una modifica parziale alle preferenze salvate.
 * I tipi non configurabili vengono scartati: non devono finire nel
 * documento utente nemmeno se un client li manda.
 */
export function mergeSettings(
    current: UserNotificationSettings | undefined,
    patch: {
        types?: Partial<Record<NotificationType, boolean>>;
        mutedTravels?: string[];
        pushEnabled?: boolean;
    }
): UserNotificationSettings {
    const base = current ?? {};
    const types = { ...(base.types ?? {}) };

    for (const [key, value] of Object.entries(patch.types ?? {})) {
        const type = key as NotificationType;
        if (!NOTIFICATION_CATALOG[type]?.configurable) continue;
        if (typeof value === "boolean") types[type] = value;
    }

    return {
        types,
        mutedTravels: Array.isArray(patch.mutedTravels) ? patch.mutedTravels : base.mutedTravels ?? [],
        pushEnabled: typeof patch.pushEnabled === "boolean" ? patch.pushEnabled : base.pushEnabled !== false,
    };
}
