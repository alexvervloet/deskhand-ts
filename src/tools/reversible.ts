/**
 * Reversible tools: they change state, run without approval, and each one
 * records how to undo itself at the moment it acts.
 *
 * The inverse is captured at execution time rather than derived later, because
 * the prior value is knowable now and merely guessable afterwards. A run that
 * fails at step 9 *can* be reverted precisely — set the priority back to
 * `normal`, not "back to whatever seems reasonable".
 *
 * `applyInverse` is what applies one. Its caller is
 * [src/runtime/compensation.ts](../runtime/compensation.ts), which builds an
 * ordered plan over the ledger, has a human authorise that exact plan, and
 * walks it newest-first. Nothing in the agent loop can reach this function:
 * undoing is not a tool, so the model cannot ask for it, and there is no code
 * path from a tool result to a compensation.
 *
 * **A null inverse means the handler changed nothing.** Every early return in
 * this file — tagging a ticket that already carries the tags, setting a
 * priority to the value it already has — returns an outcome with no inverse,
 * and the plan builder skips those rows on exactly that basis. The
 * correspondence is asserted in tests/tools.test.ts, because a handler that
 * ever changes state and forgets its inverse would drop out of every plan
 * silently.
 *
 * Undoing is not the same as never having acted. A reverted internal note was
 * still readable by whoever was watching the queue. That is the honest limit of
 * this class, and it is why an email is not in it.
 */

import { execute, fetchOne, one, type Row } from "../db.ts";
import {
  RiskClass,
  ToolError,
  register,
  schema,
  type ToolArgs,
  type ToolContext,
  type ToolOutcome,
} from "./base.ts";

export const PRIORITIES = ["low", "normal", "high", "urgent"];
export const STATUSES = ["open", "pending", "resolved", "escalated"];

async function ticketByReference(ctx: ToolContext, reference: string): Promise<Row> {
  const row = await fetchOne(
    ctx.db,
    `select id, reference, status::text, priority::text, tags, assignee_id
       from tickets where org_id = $1 and reference = $2`,
    [ctx.orgId, reference],
  );
  if (row === null) {
    throw new ToolError(`no ticket ${JSON.stringify(reference)} for this merchant`);
  }
  return row;
}

export interface Inverse {
  op: string;
  [key: string]: unknown;
}

/**
 * Undo one recorded effect. Dispatches on the `op` captured at write time.
 *
 * Deliberately not expressed as "call the opposite tool": restoring a deleted
 * row is not something any tool in the registry can do, and pretending
 * otherwise would mean adding tools whose only caller is the revert path —
 * tools the model could then also reach.
 *
 * Two rules hold for every branch.
 *
 * **Every statement is scoped to `ctx.orgId`.** The ids inside an inverse were
 * captured by handlers that already filtered on the org, so they are in-tenant
 * by construction. Scoping again means the guarantee survives a future handler
 * that forgets, and it means a hand-written row in `tool_invocations.inverse`
 * cannot reach across a tenancy boundary.
 *
 * **A statement that changes no rows throws.** The row an inverse names can be
 * gone: a ticket deleted, a note already removed by a person. Letting that pass
 * would write `reverted` against something that was not reverted, and an audit
 * trail that overstates what it undid is worse than one that stops. The caller
 * turns this into a `blocked` compensation.
 */
export async function applyInverse(ctx: ToolContext, inverse: Inverse): Promise<void> {
  const op = inverse["op"];
  let changed: number;

  switch (op) {
    case "set_tags":
      changed = await execute(
        ctx.db,
        "update tickets set tags = $1, updated_at = now() where id = $2 and org_id = $3",
        [inverse["tags"], inverse["ticket_id"], ctx.orgId],
      );
      break;
    case "set_priority":
      changed = await execute(
        ctx.db,
        `update tickets set priority = $1::ticket_priority, updated_at = now()
          where id = $2 and org_id = $3`,
        [inverse["priority"], inverse["ticket_id"], ctx.orgId],
      );
      break;
    case "set_status":
      changed = await execute(
        ctx.db,
        `update tickets set status = $1::ticket_status, updated_at = now()
          where id = $2 and org_id = $3`,
        [inverse["status"], inverse["ticket_id"], ctx.orgId],
      );
      break;
    case "set_assignee":
      changed = await execute(
        ctx.db,
        "update tickets set assignee_id = $1, updated_at = now() where id = $2 and org_id = $3",
        [inverse["assignee_id"], inverse["ticket_id"], ctx.orgId],
      );
      break;
    case "delete_message":
      changed = await execute(
        ctx.db,
        `delete from ticket_messages m using tickets t
          where m.id = $1 and t.id = m.ticket_id and t.org_id = $2`,
        [inverse["message_id"], ctx.orgId],
      );
      break;
    default:
      // Guards against a tool adding an op and forgetting this.
      throw new ToolError(`no inverse handler for op ${JSON.stringify(op)}`);
  }

  if (changed === 0) {
    throw new ToolError(
      `nothing to undo for ${JSON.stringify(op)}: the row it names is gone or belongs to another merchant`,
    );
  }
}

// --------------------------------------------------------------- tag_ticket

async function tagTicket(ctx: ToolContext, args: ToolArgs): Promise<ToolOutcome> {
  const ticket = await ticketByReference(ctx, args["reference"] as string);
  const before = [...(ticket["tags"] as string[])];
  const added = (args["tags"] as string[]).filter((t) => !before.includes(t));
  if (added.length === 0) {
    return { result: `${ticket["reference"]} already carries all of those tags.` };
  }

  const now = [...before, ...added];
  await execute(ctx.db, "update tickets set tags = $1, updated_at = now() where id = $2", [
    now,
    ticket["id"],
  ]);
  return {
    result:
      `Tagged ${ticket["reference"]} with ${added.join(", ")}.` +
      ` Tags are now: ${now.join(", ")}.`,
    inverse: { op: "set_tags", ticket_id: String(ticket["id"]), tags: before },
  };
}

register({
  name: "tag_ticket",
  risk: RiskClass.REVERSIBLE,
  description:
    "Add one or more tags to a ticket. Tags are how the human queue is " +
    "filtered, so use the vocabulary already in use on other tickets rather " +
    "than inventing synonyms. Existing tags are kept.",
  parameters: schema({
    reference: { type: "string", description: "Ticket reference." },
    tags: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 8,
      description: "Tags to add, lower-case, hyphenated.",
    },
  }),
  handler: tagTicket,
  preview: (a) => `Tag ${a["reference"]} with ${(a["tags"] as string[]).join(", ")}`,
});

// ------------------------------------------------------------- set_priority

async function setPriority(ctx: ToolContext, args: ToolArgs): Promise<ToolOutcome> {
  const ticket = await ticketByReference(ctx, args["reference"] as string);
  const before = ticket["priority"] as string;
  const after = args["priority"] as string;
  if (before === after) return { result: `${ticket["reference"]} is already ${after}.` };

  await execute(
    ctx.db,
    "update tickets set priority = $1::ticket_priority, updated_at = now() where id = $2",
    [after, ticket["id"]],
  );
  return {
    result: `Priority of ${ticket["reference"]} changed from ${before} to ${after}.`,
    inverse: { op: "set_priority", ticket_id: String(ticket["id"]), priority: before },
  };
}

register({
  name: "set_priority",
  risk: RiskClass.REVERSIBLE,
  description:
    "Set a ticket's priority. Raise it when the customer is blocked, out of " +
    "pocket, or has been waiting past the published turnaround; lower it when " +
    "a ticket turns out to be a question rather than a problem.",
  parameters: schema({
    reference: { type: "string", description: "Ticket reference." },
    priority: { type: "string", enum: PRIORITIES },
  }),
  handler: setPriority,
  preview: (a) => `Set ${a["reference"]} priority to ${a["priority"]}`,
});

// --------------------------------------------------------- set_ticket_status

async function setTicketStatus(ctx: ToolContext, args: ToolArgs): Promise<ToolOutcome> {
  const ticket = await ticketByReference(ctx, args["reference"] as string);
  const before = ticket["status"] as string;
  const after = args["status"] as string;
  if (before === after) return { result: `${ticket["reference"]} is already ${after}.` };

  await execute(
    ctx.db,
    "update tickets set status = $1::ticket_status, updated_at = now() where id = $2",
    [after, ticket["id"]],
  );
  return {
    result: `Status of ${ticket["reference"]} changed from ${before} to ${after}.`,
    inverse: { op: "set_status", ticket_id: String(ticket["id"]), status: before },
  };
}

register({
  name: "set_ticket_status",
  risk: RiskClass.REVERSIBLE,
  description:
    "Set a ticket's status. Use 'resolved' only when the customer's problem is " +
    "actually settled, 'pending' when waiting on the customer, and 'escalated' " +
    "when the request needs a human decision you are not authorised to make.",
  parameters: schema({
    reference: { type: "string", description: "Ticket reference." },
    status: { type: "string", enum: STATUSES },
  }),
  handler: setTicketStatus,
  preview: (a) => `Set ${a["reference"]} status to ${a["status"]}`,
});

// ------------------------------------------------------------ assign_ticket

async function assignTicket(ctx: ToolContext, args: ToolArgs): Promise<ToolOutcome> {
  const ticket = await ticketByReference(ctx, args["reference"] as string);
  const email = args["assignee_email"] as string;
  const user = await fetchOne(
    ctx.db,
    "select id, email from users where org_id = $1 and lower(email) = lower($2)",
    [ctx.orgId, email],
  );
  if (user === null) {
    throw new ToolError(`no colleague ${JSON.stringify(email)} at this merchant`);
  }

  const before = ticket["assignee_id"];
  await execute(ctx.db, "update tickets set assignee_id = $1, updated_at = now() where id = $2", [
    user["id"],
    ticket["id"],
  ]);
  return {
    result: `Assigned ${ticket["reference"]} to ${user["email"]}.`,
    inverse: {
      op: "set_assignee",
      ticket_id: String(ticket["id"]),
      assignee_id: before ? String(before) : null,
    },
  };
}

register({
  name: "assign_ticket",
  risk: RiskClass.REVERSIBLE,
  description:
    "Assign a ticket to a named colleague by email. Use it when handing off " +
    "work you cannot finish, together with an internal note saying why.",
  parameters: schema({
    reference: { type: "string", description: "Ticket reference." },
    assignee_email: { type: "string", description: "Email of a colleague at this merchant." },
  }),
  handler: assignTicket,
  preview: (a) => `Assign ${a["reference"]} to ${a["assignee_email"]}`,
});

// --------------------------------------------------------- add_internal_note

async function addInternalNote(ctx: ToolContext, args: ToolArgs): Promise<ToolOutcome> {
  const ticket = await ticketByReference(ctx, args["reference"] as string);
  // Authored as 'agent', not 'system', and the difference is not cosmetic. This
  // body is model output, and the model wrote it after reading a ticket
  // somebody outside the company typed. 'system' is the most authoritative
  // label in the vocabulary — it reads as the platform stating a fact — so
  // filing model prose under it launders text that a customer influenced into
  // text a colleague trusts. `send_customer_email` already writes 'agent'.
  const row = await one(
    ctx.db,
    `insert into ticket_messages (ticket_id, author_kind, is_internal, body)
     values ($1, 'agent', true, $2) returning id`,
    [ticket["id"], args["body"]],
  );
  return {
    result: `Added an internal note to ${ticket["reference"]}. The customer cannot see it.`,
    inverse: { op: "delete_message", message_id: String(row["id"]) },
  };
}

register({
  name: "add_internal_note",
  risk: RiskClass.REVERSIBLE,
  description:
    "Write an internal note on a ticket. Staff and future runs can read it; " +
    "the customer never can. Use it to record what you checked and why you " +
    "reached a conclusion, especially before escalating — the next person to " +
    "open the ticket should not have to redo your work. This does not reply " +
    "to the customer; use send_customer_email for that.",
  parameters: schema({
    reference: { type: "string", description: "Ticket reference." },
    body: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description: "The note, in plain prose.",
    },
  }),
  handler: addInternalNote,
  preview: (a) => `Add an internal note to ${a["reference"]}`,
});
