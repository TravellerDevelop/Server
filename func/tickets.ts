import { ObjectId } from "mongodb";
import { Request, Response } from "express";
import { DB_NAME, mongoConnection } from "../server";
import { Cache } from "../types/common";
import {
    TicketDocument,
    CreateTicketBody,
    DeleteTicketBody,
    ShareTicketBody,
} from "../types/ticket";
import { notify } from "./notifications";
import { emitToUser } from "./realtime";
import { USER_EVENTS } from "../types/realtime";
import { isSelf } from "./socketAuth";
import { parseObjectId } from "../util/mongoIds";

function ticketsCollection() {
    return mongoConnection.db(DB_NAME).collection<TicketDocument>("tickets");
}

/** Ticket con lo "sharedBy" ancora come array di utenti risolti dal lookup (prima del post-processing). */
interface TicketWithSharedByLookup extends Omit<TicketDocument, "sharedBy"> {
    sharedBy: { username: string }[];
}

export function createTicket(req: Request, res: Response, cache: Cache) {
    const { data }: CreateTicketBody = req.body;
    const authUserId = req.auth?.userId;
    if (!authUserId) {
        res.status(401).send("Non autenticato");
        return;
    }
    const param = {
        ...data,
        // Il creatore è sempre chi chiama, non il valore dichiarato nel body.
        creator: new ObjectId(authUserId),
        date: new Date(data.date),
    };

    ticketsCollection().insertOne(param as TicketDocument, function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query");
        } else {
            res.status(200).send(data);
            cache.del("tickets=" + param.creator);
            // I ticket sono per utente, non per viaggio: l'unico caso da
            // coprire è lo stesso account su più dispositivi (e la
            // condivisione, vedi shareTicket).
            emitToUser(param.creator, USER_EVENTS.TICKETS_CHANGED, {});
        }
    });
}

export function takeTickets(req: Request, res: Response, cache: Cache) {
    const userid = req.query.userid as string;
    if (!isSelf(req, userid)) {
        res.status(403).send("Non autorizzato");
        return;
    }
    const cachedData = cache.get("tickets=" + userid);
    if (cachedData) {
        res.send(cachedData).status(200);
        cache.set("tickets=" + userid, cachedData, 600);
    }
    else {
        const creatorId = parseObjectId(userid);
        if (!creatorId) {
            res.status(400).send("Id non valido");
            return;
        }
        ticketsCollection().aggregate<TicketWithSharedByLookup>([
            {
                $match: {
                    creator: creatorId
                }
            },
            {
                $lookup: {
                    from: "user",
                    localField: "sharedBy",
                    foreignField: "_id",
                    as: "sharedBy"
                }
            },
            {
                $project: {
                    "sharedBy._id": 0,
                    "sharedBy.name": 0,
                    "sharedBy.surname": 0,
                    "sharedBy.password": 0,
                    "sharedBy.email": 0,
                    "sharedBy.notifToken": 0,
                }
            }
        ]).toArray(function (err, data) {
            if (err) {
                res.status(500).send("Errore esecuzione query");
            }
            else {
                for (const item of data) {
                    if (item.sharedBy.length > 0)
                        (item as any).sharedBy = item.sharedBy[0].username;
                    else
                        delete (item as any).sharedBy;
                }
                res.status(200).send(data);
                cache.set("tickets=" + userid, data, 600);
            }
        });
    }
}

export function deleteTicket(req: Request, res: Response, cache: Cache) {
    const { id }: DeleteTicketBody = req.body;

    const ticketId = parseObjectId(id);
    if (!ticketId) {
        res.status(400).send("Id non valido");
        return;
    }

    // Serve il creatore per invalidare la cache giusta: va letto prima della
    // cancellazione, altrimenti il documento non esiste più.
    ticketsCollection().findOne({ _id: ticketId }, function (findErr, ticket) {
        if (findErr) {
            res.status(500).send("Errore esecuzione query 1");
            return;
        }
        if (!ticket || ticket.creator?.toString() !== req.auth?.userId) {
            res.status(403).send("Non autorizzato");
            return;
        }

        ticketsCollection().deleteOne({ _id: ticketId }, function (err, data) {
            if (err) {
                res.status(500).send("Errore esecuzione query 1");
            } else {
                res.status(200).send(data);
                if (ticket) {
                    cache.del("tickets=" + ticket.creator);
                    emitToUser(ticket.creator, USER_EVENTS.TICKETS_CHANGED, {});
                }
            }
        });
    });
}

export function shareTicket(req: Request, res: Response, cache: Cache) {
    const { userid, content } = req.body as ShareTicketBody;
    // Chi condivide è sempre chi chiama, non il valore dichiarato nel body.
    const createBy = req.auth?.userId as string;

    const recipientId = parseObjectId(userid);
    const sharedById = parseObjectId(createBy);
    if (!recipientId || !sharedById) {
        res.status(400).send("Id non valido");
        return;
    }

    // NOTA: a differenza di createTicket, qui "date" non viene convertita esplicitamente
    // in Date: comportamento preesistente preservato (il contenuto condiviso arriva già
    // con i campi del ticket originale).
    const param = {
        ...content,
        creator: recipientId,
        sharedBy: sharedById,
    };

    ticketsCollection().insertOne(param as unknown as TicketDocument, function (err, data) {
        if (err) {
            res.status(500).send("Errore esecuzione query 1");
        } else {
            res.status(200).send(data);
            cache.del("tickets=" + userid);
            // Il destinatario vede il biglietto comparire mentre ha la tab
            // aperta, senza aspettare la push o il rientro in schermata.
            emitToUser(userid, USER_EVENTS.TICKETS_CHANGED, {});

            // `userid` è il destinatario della condivisione, `createBy` chi condivide.
            notify({
                type: "ticket_shared",
                to: [userid],
                actor: createBy,
                title: "Nuovo biglietto",
                body: `{actor} ha condiviso con te un biglietto${content?.title ? `: ${content.title}` : ""}`,
                entity: data?.insertedId,
                target: { screen: "Tickets", root: true },
                cache,
            });
        }
    });
}
