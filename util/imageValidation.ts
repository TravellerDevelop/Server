/**
 * Validazione delle immagini caricate dal client (copertine viaggio, foto
 * dei post — vedi func/travels.ts#uploadImage, func/post.ts#addPostImage).
 *
 * PERCHÉ ESISTE. Entrambi gli endpoint prendevano l'estensione dal nome
 * file dichiarato dal client (`imgName.split(".").pop()`), senza alcuna
 * whitelist né verifica del contenuto reale, e caricavano il buffer
 * decodificato su un bucket S3 configurato public-read. Un client poteva
 * dichiarare `imgName: "foo.html"` (o ".svg", con dentro uno script) e il
 * file sarebbe finito pubblicamente raggiungibile dallo stesso dominio
 * dell'app — stored XSS, non serve nemmeno convincere qualcuno a cliccare
 * un link esterno.
 *
 * La difesa è in due passi, non uno solo:
 * 1. whitelist sull'estensione dichiarata — blocca i formati ovviamente non
 *    immagine (.html, .svg, .js, ...);
 * 2. verifica della "firma" (i primi byte, i cosiddetti magic bytes) del
 *    buffer decodificato — perché la sola estensione si aggira dichiarando
 *    un nome falso ("foo.png" con dentro tutt'altro): un browser/S3 non
 *    guardano l'estensione per decidere se eseguire un contenuto, ma un
 *    controllo di coerenza qui costa pochissimo ed elimina la classe di
 *    attacco "rinomina il payload con estensione immagine".
 *
 * Entrambe le condizioni devono valere.
 */

export type ImageFormat = "jpeg" | "png" | "gif" | "webp" | "heic";

/** Estensione (senza punto, minuscola) -> famiglia di formato attesa. */
const EXTENSION_TO_FORMAT: Record<string, ImageFormat> = {
    jpg: "jpeg",
    jpeg: "jpeg",
    png: "png",
    gif: "gif",
    webp: "webp",
    heic: "heic",
    heif: "heic",
};

export function isAllowedImageExtension(ext: string | undefined | null): boolean {
    return !!ext && Object.prototype.hasOwnProperty.call(EXTENSION_TO_FORMAT, ext.toLowerCase());
}

/**
 * Riconosce il formato reale di un'immagine dai primi byte del buffer.
 * Ritorna null se non corrisponde a nessuna delle firme note (quindi non è
 * un'immagine in uno dei formati che l'app supporta, indipendentemente da
 * cosa dichiari il nome file).
 */
export function sniffImageFormat(buffer: Buffer): ImageFormat | null {
    if (buffer.length < 12) return null;

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
        buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
    ) {
        return "png";
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return "jpeg";
    }

    // GIF: "GIF87a" o "GIF89a"
    const gifHeader = buffer.toString("ascii", 0, 6);
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
        return "gif";
    }

    // WEBP: "RIFF" <4 byte dimensione> "WEBP"
    if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
        return "webp";
    }

    // HEIC/HEIF: box ISOBMFF "ftyp" a offset 4, con uno dei brand noti a offset 8.
    // Non è un'unica firma fissa come le altre (è un container generico),
    // quindi si verifica il brand invece dei soli byte grezzi.
    if (buffer.toString("ascii", 4, 8) === "ftyp") {
        const HEIC_BRANDS = new Set([
            "heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis", "hevm", "hevs",
        ]);
        if (HEIC_BRANDS.has(buffer.toString("ascii", 8, 12))) return "heic";
    }

    return null;
}

export interface ImageValidationResult {
    ok: boolean;
    reason?: string;
}

/**
 * Verifica che `imgName` abbia un'estensione ammessa E che il contenuto
 * reale di `buffer` corrisponda a quella famiglia di formato.
 */
export function validateImageUpload(imgName: string, buffer: Buffer): ImageValidationResult {
    const ext = imgName?.split(".").pop()?.toLowerCase();
    if (!isAllowedImageExtension(ext)) {
        return { ok: false, reason: "Estensione file non ammessa" };
    }

    const expected = EXTENSION_TO_FORMAT[ext as string];
    const detected = sniffImageFormat(buffer);
    if (detected !== expected) {
        return { ok: false, reason: "Il contenuto del file non corrisponde a un'immagine valida" };
    }

    return { ok: true };
}
