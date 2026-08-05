import { ObjectId } from "mongodb";
import { Request, Response, NextFunction } from "express";
import { DB_NAME, mongoConnection } from "../server";
import { Cache } from "../types/common";
import {
    UserDocument,
    RegisterUserBody,
    LoginBody,
    FromIdToUsernameBody,
    SetUserNotifTokenBody,
    SetUserNotifTokenResponse,
    VerifyTokenBody,
    VerifyTokenResponse,
    TakeTravelsNumResponse,
    UserForClient,
} from "../types/user";
import { TravelDocument } from "../types/travel";
import { isSelf, issueSocketToken } from "./socketAuth";
import { hashPassword, verifyPassword } from "./passwordHash";

function userCollection() {
    return mongoConnection.db(DB_NAME).collection<UserDocument>("user");
}

function travelsCollection() {
    return mongoConnection.db(DB_NAME).collection<TravelDocument>("travels");
}

/**
 * Prepara i documenti utente per l'invio al client.
 *
 * Due cose in un posto solo, perché vanno fatte sempre insieme e dimenticarne
 * una è facile:
 *
 * - toglie `password` (il digest SHA-256 inviato dal client al login). Non
 *   serve a nessuna schermata — il client lo scartava già in `sanitizeUser` —
 *   e rispedirlo significa farlo passare per la rete e finire nei log a ogni
 *   lettura del profilo, quando vale quanto la password stessa;
 * - aggiunge `socketToken`, la credenziale firmata con cui l'app apre il
 *   canale realtime (vedi func/socketAuth.ts).
 */
function forClient(users: UserDocument[]): UserForClient[] {
    return users.map((user) => {
        const { password: _password, ...safe } = user as UserDocument & { password?: string };
        return { ...safe, socketToken: issueSocketToken(user._id.toString()) };
    });
}

/** Restituisce l'utente con il dato username. Usato solo in fase di registrazione. */
export function takeUserInfo(req: Request, res: Response, next: NextFunction) {
    const username = req.query.username as string;

    userCollection().find({ username }).toArray(function (err, data) {
        if (err) {
            res.status(500).send({ res: "Errore esecuzione query\n" + JSON.stringify(err) });
        } else {
            res.send(forClient(data));
        }
        next();
    });
}

export function takeUserById(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const id = req.query.id as string;
    const cachedData = cache.get<UserDocument[]>("user-id=" + id);

    // In cache finiscono i documenti grezzi, non la risposta: il socketToken
    // ha una scadenza e va emesso al momento dell'invio, altrimenti una voce
    // di cache rinnovata di continuo servirebbe per sempre lo stesso token
    // (e nel giorno della sua scadenza smetterebbe di funzionare per tutti).
    if (cachedData) {
        cache.set("user-id=" + id, cachedData, 600);
        res.status(200).send(forClient(cachedData));
        next();
    }
    else if (id) {
        userCollection().find({ _id: new ObjectId(id) }).toArray(function (err, data) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            } else {
                cache.set("user-id=" + id, data, 600);
                res.send(forClient(data));
            }
            next();
        });
    }
}

export function fromIdToUsername(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const { id }: FromIdToUsernameBody = req.body;
    const ausId: ObjectId[] = id.map((item) => new ObjectId(item));

    userCollection().find({ _id: { $in: ausId } }).toArray(function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.send(data);
        }
        next();
    });
}

/**
 * Campi che un nuovo utente può davvero impostare in fase di registrazione.
 * `RegisterUserBody` è solo un tipo TypeScript: non ha alcun effetto su cosa
 * arriva davvero in `req.body`, quindi prima di questa modifica un body come
 * `{ name, surname, username, email, password, notificationSettings: {...},
 * image: "..." }` finiva spalmato per intero nel documento inserito
 * (`{ ...body, password: hashed }`) — chiunque poteva far scrivere qualunque
 * campo di UserDocument, compresi quelli che l'app non espone in nessuna
 * schermata di registrazione. Da qui in poi il documento si costruisce campo
 * per campo, non per spread: un campo nuovo mandato dal client non entra nel
 * database finché non viene aggiunto esplicitamente qui.
 */
function buildNewUserDocument(body: RegisterUserBody, hashedPassword: string): UserDocument {
    return {
        name: body.name.trim(),
        surname: body.surname.trim(),
        username: body.username.trim(),
        email: body.email.trim(),
        password: hashedPassword,
    } as UserDocument;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

export function registerUser(req: Request, res: Response, next: NextFunction) {
    const body: RegisterUserBody = req.body;

    if (
        !isNonEmptyString(body?.name) ||
        !isNonEmptyString(body?.surname) ||
        !isNonEmptyString(body?.username) ||
        !isNonEmptyString(body?.email) ||
        !isNonEmptyString(body?.password)
    ) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }

    userCollection().find({ username: body.username }).toArray(function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
            console.log("Errore esecuzione query 1");
            next();
        } else {
            if (data.length != 0) {
                res.status(202).send("Username già in uso");
            } else {
                // Non si salva mai il digest mandato dal client così com'è:
                // vedi func/passwordHash.ts sul perché.
                hashPassword(body.password)
                    .then((hashed) => {
                        const toInsert = buildNewUserDocument(body, hashed);
                        userCollection().insertOne(toInsert, function (err, data) {
                            if (err) {
                                res.status(500).send("Errore esecuzione query");
                                console.log("Errore esecuzione query 2\n", err);
                            } else {
                                res.status(200).send(data);
                            }
                            next();
                        });
                    })
                    .catch((err) => {
                        res.status(500).send("Errore esecuzione query");
                        console.log("Errore hashing password\n", err);
                        next();
                    });
            }
        }

    });
}

export function takeTravelsNum(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const userid = req.query.userid as string;
    const cachedData = cache.get<TakeTravelsNumResponse>("travelsNum-id=" + userid);
    if (cachedData) {
        cache.set("travelsNum-id=" + userid, cachedData, 600);
        res.send(cachedData).status(200);
        next();
    }
    else {
        travelsCollection()
            .countDocuments({ "participants": { "$elemMatch": { "userid": new ObjectId(userid), "creator": true } } })
            .then(function (count) {
                const response: TakeTravelsNumResponse = { count };
                cache.set("travelsNum-id=" + userid, response, 600);
                res.send(response).status(200);
            })
            .catch((ex) => {
                console.log(ex);
                next();
            });
    }
}

export function login(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const body: LoginBody = req.body;

    userCollection().find({ username: body.username }).toArray(function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
            next();
        } else {
            if (data.length == 0) {
                res.status(202).send("Utente non trovato");
            } else {
                // verifyPassword gestisce da sola sia gli utenti già in bcrypt
                // sia quelli non ancora migrati (vedi func/passwordHash.ts):
                // in quest'ultimo caso restituisce anche l'hash da salvare,
                // upgrade "pigro" al primo login riuscito.
                verifyPassword(body.password, data[0].password)
                    .then((result) => {
                        if (!result.valid) {
                            res.status(201).send("Password errata");
                            next();
                            return;
                        }

                        if (result.upgradeTo) {
                            userCollection()
                                .updateOne({ _id: data[0]._id }, { $set: { password: result.upgradeTo } })
                                .catch((err) => console.log("Upgrade password a bcrypt fallito", err));
                        }

                        // forClient(): via il digest della password, dentro il
                        // token del canale realtime. Vedi il commento su forClient.
                        res.status(200).send(forClient(data));
                        next();
                    })
                    .catch((err) => {
                        console.log("Errore verifica password", err);
                        res.status(500).send("Errore esecuzione query");
                        next();
                    });
            }
        }
    });
}

export function userTravels(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const username = req.query.username as string;
    const cachedData = cache.get("userTravels-usn=" + username);
    if (cachedData) {
        cache.set("userTravels-usn=" + username, cachedData, 600);
        res.send(cachedData).status(200);
        next();
    }
    // NOTA: TravelDocument non ha un campo "creator" a livello di documento (solo
    // participants[].creator); la query è preesistente e viene preservata così com'è.
    travelsCollection().find({ creator: username } as any).toArray(function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        }
        else {
            cache.set("userTravels-usn=" + username, data, 600);
            res.status(200).send(data);
        }
        next();
    });
}

export function searchUser(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const username = req.query.username as string;
    const cachedData = cache.get("usr-search-keys=" + username);
    if (cachedData) {
        cache.set("usr-search-keys=" + username, cachedData, 100);
        res.send(cachedData).status(200);
        next();
    }
    else {
        const regex = new RegExp(username, 'i');
        userCollection()
            .find({ $or: [{ username: { $regex: regex } }, { name: { $regex: regex } }, { surname: { $regex: regex } }] })
            .limit(3)
            .toArray(function (err, data) {
                if (err) {
                    res.status(500).send("Errore esecuzione query");
                }
                else {
                    cache.set("usr-search-keys=" + username, data, 100);
                    res.status(200).send(data);
                }
                next();
            });
    }
}

/**
 * Aggiunge il token push del dispositivo all'utente.
 *
 * Prima riscriveva l'array intero con `[...vecchi, nuovo]`: riaprendo l'app
 * dopo aver svuotato il SecureStore lo stesso token veniva accodato di nuovo,
 * e ogni push partiva duplicata. I `null` accumulati allo stesso modo
 * finivano in `Expo.isExpoPushToken(null)` a ogni invio.
 * Ora l'aggiunta è un `$addToSet` e i valori non validi vengono scartati.
 */
export async function setUserNotifToken(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const body: SetUserNotifTokenBody = req.body;

    if (!body?.userid || !body?.notifToken) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }
    if (!isSelf(req, body.userid)) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    try {
        const userId = new ObjectId(body.userid);
        await userCollection().updateOne(
            { _id: userId },
            {
                // $pull rimuove i null storici, $addToSet evita i duplicati.
                $pull: { notifToken: null },
            } as never
        );
        await userCollection().updateOne(
            { _id: userId },
            { $addToSet: { notifToken: body.notifToken } } as never
        );

        const updated = await userCollection().findOne({ _id: userId }, { projection: { notifToken: 1 } });
        cache.del("user-id=" + body.userid);

        const response: SetUserNotifTokenResponse = { updated: true, token: updated?.notifToken ?? [] };
        res.status(200).send(response);
    } catch (err) {
        console.error(err);
        res.status(500).send("Errore esecuzione query");
    } finally {
        next();
    }
}

/**
 * Verifica che il token conservato dal dispositivo sia ancora associato
 * all'utente, e lo riassocia se manca (es. dopo un cambio account).
 */
export async function verifyToken(req: Request, res: Response, cache: Cache, next: NextFunction) {
    const body: VerifyTokenBody = req.body;

    if (!body?.userid || !body?.notificationToken) {
        res.status(400).send("Parametri mancanti");
        next();
        return;
    }
    if (!isSelf(req, body.userid)) {
        res.status(403).send("Non autorizzato");
        next();
        return;
    }

    try {
        const userId = new ObjectId(body.userid);
        const user = await userCollection().findOne({ _id: userId }, { projection: { notifToken: 1 } });

        if (!user) {
            res.status(404).send("Utente non trovato");
            next();
            return;
        }

        const tokens: (string | null)[] = Array.isArray(user.notifToken) ? user.notifToken : [];
        if (tokens.includes(body.notificationToken)) {
            const payload: VerifyTokenResponse = { is: true };
            res.status(200).send(payload);
            next();
            return;
        }

        await userCollection().updateOne(
            { _id: userId },
            { $addToSet: { notifToken: body.notificationToken } } as never
        );
        cache.del("user-id=" + body.userid);

        const payload: VerifyTokenResponse = { is: false, updated: true };
        res.status(200).send(payload);
    } catch (err) {
        console.error(err);
        res.status(500).send("Errore esecuzione query");
    } finally {
        next();
    }
}
