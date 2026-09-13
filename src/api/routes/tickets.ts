/**
 * Tickets: the queue, and one ticket with its thread and its run history.
 */

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { all, fetchOne, pool } from "../../db.ts";
import { HttpError, requireCaller } from "../deps.ts";
import { TicketDetail, TicketSummary } from "../schemas.ts";
import { runSummary, ticketSummary } from "../views.ts";

const TICKET_COLUMNS = `
  t.id, t.reference, t.subject, t.status::text as status,
  t.priority::text as priority, t.tags, t.created_at,
  c.name as customer_name, c.email as customer_email,
  (select r.id from runs r where r.ticket_id = t.id
    and r.status in ('queued','running','awaiting_approval')
   order by r.created_at desc limit 1) as open_run_id
`;

export async function ticketRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/tickets",
    {
      preHandler: requireCaller,
      schema: { response: { 200: Type.Array(TicketSummary) } },
    },
    async (request) => {
      const rows = await all(
        pool(),
        `select ${TICKET_COLUMNS} from tickets t
           join customers c on c.id = t.customer_id
          where t.org_id = $1 order by t.created_at`,
        [request.caller.orgId],
      );
      return rows.map(ticketSummary);
    },
  );

  app.get(
    "/tickets/:reference",
    { preHandler: requireCaller, schema: { response: { 200: TicketDetail } } },
    async (request) => {
      const { reference } = request.params as { reference: string };
      const row = await fetchOne(
        pool(),
        `select ${TICKET_COLUMNS} from tickets t
           join customers c on c.id = t.customer_id
          where t.org_id = $1 and t.reference = $2`,
        [request.caller.orgId, reference],
      );
      if (row === null) throw new HttpError(404, "no such ticket");

      const messages = await all(
        pool(),
        `select author_kind::text as author_kind, is_internal, body, created_at
           from ticket_messages where ticket_id = $1 order by created_at`,
        [row["id"]],
      );

      // Every run this ticket has ever had, not just a live one.
      //
      // `open_run_id` above names only a run that can still act, which is the
      // right answer for "what should this screen jump to". It is the wrong
      // answer for "how do I get back to what happened": a run that finished
      // while you were watching would stay on screen, and a run that finished
      // before you arrived would be unreachable. Everything a finished run
      // leads to — the replay, the cost, the compensation plan — would sit
      // behind a screen you could only reach by not leaving it.
      const history = await all(
        pool(),
        `select r.*, t.reference as ticket_reference from runs r
           join tickets t on t.id = r.ticket_id
          where r.ticket_id = $1 order by r.created_at desc limit 20`,
        [row["id"]],
      );

      return {
        ...ticketSummary(row),
        messages,
        runs: history.map(runSummary),
      };
    },
  );
}
