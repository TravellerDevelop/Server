import dotenv from "dotenv";

/**
 * Carica il .env PRIMA di qualunque altro modulo del progetto.
 *
 * PERCHÉ QUESTO FILE ESISTE. `server.ts` chiamava `dotenv.config()` come
 * riga di codice normale, dopo i suoi `import`. Ma gli `import` di un
 * modulo vengono sempre valutati prima di qualunque altra riga dello stesso
 * file — è la stessa ragione per cui `util/s3.ts` e `func/flights.ts`
 * leggono le loro variabili d'ambiente dentro le funzioni e non in cima al
 * modulo (vedi i commenti lì). Un modulo che legge una env var al momento
 * dell'import, invece che dentro una funzione, la leggeva quindi PRIMA che
 * il `.env` fosse stato caricato, vedendo sempre `undefined` — è
 * esattamente quello che succedeva a `func/socketAuth.ts`: non leggeva mai
 * `SOCKET_SECRET` dal `.env`, nemmeno quando il file lo conteneva, e finiva
 * sempre sul fallback casuale.
 *
 * Fix: un modulo che non fa altro che caricare il `.env`, importato per
 * primo — prima di qualunque altro import — in `server.ts`. Gli `import`
 * vengono valutati nell'ordine in cui compaiono nel file: finché questo
 * resta il primo, il `.env` è già caricato quando qualunque altro modulo
 * del progetto viene valutato.
 */
dotenv.config({ path: ".env" });
