/**
 * Walking a finished run back.
 *
 * Every reversible tool has recorded its inverse since the day the tool layer
 * was written. This is the module that finally applies them, and the
 * interesting part is not the applying — it is everything the plan refuses to
 * do.
 *
 * **The plan is a pure function of ledger rows.** Not of the model, not of the
 * conversation, not of anything a tool returned. A recovery path that asks a
 * language model which effects to undo has put an untrusted decision at exactly
 * the moment the system is already known to have got something wrong. `plan`
 * reads `tool_invocations`, sorts, and stops.
 *
 * **Nothing is undone.** The word throughout is *compensation*, because undo
 * promises something that is false for half the ledger. An email that was read
 * cannot be unread and money that left is gone. The plan applies the inverses
 * that exist and *reports* the acts that have none, and a compensation whose
 * plan contains one of those finishes `partial` rather than `applied` no matter
 * how well the rest of it went. `partial` is the expected outcome, not a
 * degraded one.
 *
 * **Order is load-bearing.** Inverses are applied newest first. Two priority
 * changes on one ticket — normal to high at step 3, high to urgent at step 7 —
 * record the inverses "set it to normal" and "set it to high". Apply them in
 * the order they were captured and the ticket lands on `high`, which is a value
 * it held for four steps and was never supposed to keep. Apply them backwards
 * and it lands on `normal`, which is where it started. Each inverse restores
 * the state its own call overwrote, so it is only correct while every later
 * call has already been walked back.
 *
 * **A failure stops everything.** An inverse that throws leaves the
 * compensation `blocked` with the remaining items `skipped`. Continuing would
 * mean applying an inverse whose precondition — that every later effect is
 * already gone — is no longer true. Nothing here knows which items are
 * independent of each other, and guessing wrong writes a state that neither the
 * run nor the compensation intended.
 */

import { createHash } from "node:crypto";
import type pg from "pg";
import { settings } from "../config.ts";
import { all, execute, fetchOne, one, type Queryable, type Row } from "../db.ts";
import { ToolError, applyInverse, get as toolDef, isRegistered } from "../tools/index.ts";
import type { Inverse, ToolContext } from "../tools/index.ts";
import * as runs from "./runs.ts";

/** A compensation races the worker if the run can still act. Cancel it first. */
export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "exhausted", "cancelled"];

/** Why a compensation stopped, in the same fixed vocabulary `runs` uses. */
export const STOP_COMPLETE = "complete";
export const STOP_INVERSE_FAILED = "inverse_failed";
export const STOP_ATTEMPTS = "attempts_exhausted";
export const STOP_CANCELLED = "cancelled";

export const REVERT = "revert";
export const REPORT = "report";

/** Another worker took this compensation. Stop touching it immediately. */
export class LeaseLost extends Error {
  override readonly name = "LeaseLost";
}

/** The compensation cannot be created as asked. */
export class PlanError extends Error {
  override readonly name = "PlanError";
}

export interface PlanItem {
  seq: number;
  invocationId: string;
  stepSeq: number;
  toolName: string;
  risk: string;
  inverse: Inverse | null;
  disposition: string;
  describe: string;
}

// ----------------------------------------------------------------- planning

/**
 * The ordered list of items a compensation for this run would contain.
 *
 * Read-only and side-effect free, so the same call renders the preview a human
 * reads and validates the request they submit.
 *
 * What is excluded, and why each exclusion is a decision rather than a filter:
 *
 * * **Failed invocations.** A handler that threw did so inside a savepoint, so
 *   its writes were rolled back before the ledger row was written. There is no
 *   effect to walk back.
 * * **Read tools.** Nothing happened.
 * * **Reversible calls with a null inverse.** Every reversible handler returns
 *   early without an inverse exactly when it changed nothing — tagging a ticket
 *   that already carries the tags, setting a priority to the value it already
 *   has. tests/tools.test.ts asserts that correspondence, because if a handler
 *   ever changes state and forgets its inverse, this filter is where the effect
 *   quietly leaves the plan.
 * * **Anything already reverted**, by an earlier compensation on the same run.
 *   A blocked compensation that a human fixes and re-requests must not walk the
 *   same items back twice.
 *
 * Irreversible calls are *not* excluded. They cannot be reverted and they are
 * the most important line in the preview.
 */
export async function plan(db: Queryable, runId: string): Promise<PlanItem[]> {
  const rows = await all(
    db,
    `select ti.id as invocation_id, ti.tool_name, ti.risk, ti.inverse, ti.args,
            s.seq as step_seq
       from tool_invocations ti
       join steps s on s.id = ti.step_id
      where ti.run_id = $1
        and ti.status = 'succeeded'
        and ti.risk <> 'read'
        and (ti.risk = 'irreversible' or ti.inverse is not null)
        and not exists (
              select 1 from compensation_items ci
               where ci.invocation_id = ti.id and ci.status = 'reverted')
      order by s.seq desc`,
    [runId],
  );

  return rows.map((row, index) => {
    const inverse = (row["inverse"] ?? null) as Inverse | null;
    return {
      seq: index + 1,
      invocationId: String(row["invocation_id"]),
      stepSeq: Number(row["step_seq"]),
      toolName: row["tool_name"] as string,
      risk: row["risk"] as string,
      inverse,
      disposition: inverse !== null ? REVERT : REPORT,
      describe: describe(row["tool_name"] as string, inverse),
    };
  });
}

/**
 * A fingerprint of "this exact plan".
 *
 * The consent story, one level up from `argsHash`. That hash stops a human who
 * approved a USD 19.00 refund from having approved a USD 1,900.00 one; this one
 * stops a human who authorised walking back four specific acts from having
 * authorised whatever the ledger says a moment later.
 *
 * Covers the identity and treatment of every item, in order. It does not cover
 * the inverse payload, which is immutable in the ledger — a row there is
 * written once and never updated.
 */
export function planHash(items: PlanItem[]): string {
  const payload = JSON.stringify(items.map((i) => [i.seq, i.invocationId, i.disposition]));
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * One line a human reads before authorising. Deliberately plain.
 *
 * Rendered from the tool name, the *inverse*, and the registry — all three of
 * which this system wrote. Never from a tool's result text, which is where a
 * customer's words live.
 *
 * For an act with no inverse the sentence comes from `irreversibleNote` on the
 * tool definition, so the most important line on the screen is the tool's own
 * declaration rather than a string this module guessed about it.
 */
export function describe(toolName: string, inverse: Inverse | null): string {
  if (inverse === null) {
    const note = isRegistered(toolName) ? toolDef(toolName).irreversibleNote : null;
    return note || `${toolName} did something this system cannot take back`;
  }
  switch (inverse["op"]) {
    case "set_tags": {
      const tags = (inverse["tags"] ?? []) as string[];
      return `restore tags to ${tags.length > 0 ? tags.join(", ") : "(none)"}`;
    }
    case "set_priority":
      return `restore priority to ${inverse["priority"]}`;
    case "set_status":
      return `restore status to ${inverse["status"]}`;
    case "set_assignee":
      return inverse["assignee_id"] == null
        ? "restore assignee to nobody"
        : "restore the previous assignee";
    case "delete_message":
      return "delete the note it added";
    default:
      return `apply the recorded inverse for ${toolName}`;
  }
}

// ----------------------------------------------------------------- creating

/**
 * Authorise a compensation, or refuse.
 *
 * Refuses for four reasons, and each of them is the point rather than
 * validation noise:
 *
 * * the run belongs to somebody else
 * * the run can still act, so a compensation would race its worker
 * * there is nothing in the plan
 * * the plan is not the plan the caller was shown
 */
export async function create(
  db: Queryable,
  p: {
    orgId: string;
    runId: string;
    requestedBy: string;
    reason: string;
    expectedPlanHash: string;
  },
): Promise<string> {
  const run = await runForOrg(db, p.runId, p.orgId);

  if (!TERMINAL_RUN_STATUSES.includes(run["status"] as string)) {
    throw new PlanError(
      `run is ${run["status"]}; cancel it before compensating, ` +
        "or a compensation and its worker will race for the same rows",
    );
  }

  const items = await plan(db, p.runId);
  if (items.length === 0) {
    throw new PlanError("this run changed nothing that can be walked back");
  }

  // A plan made entirely of `report` items has nothing to do. It is also
  // permanent: an irreversible act is never marked `reverted`, so it stays in
  // every future plan for this run forever. Without this the UI would keep
  // offering to walk back a run that had already been walked back, with a count
  // of zero, and each press would write a compensation that changed nothing and
  // finished `partial`.
  if (!items.some((item) => item.disposition === REVERT)) {
    throw new PlanError(
      `nothing left that can be reverted; ${items.length} irreversible ` +
        `${items.length === 1 ? "act" : "acts"} stay on the record`,
    );
  }

  const actual = planHash(items);
  if (actual !== p.expectedPlanHash) {
    throw new PlanError(
      "the plan changed since it was shown; refusing to walk back something nobody looked at",
    );
  }

  const row = await one(
    db,
    `insert into compensations (org_id, run_id, requested_by, reason, plan_hash, max_attempts)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [p.orgId, p.runId, p.requestedBy, p.reason, actual, settings.maxCompensationAttempts],
  );
  const compensationId = String(row["id"]);

  for (const item of items) {
    await execute(
      db,
      `insert into compensation_items
         (compensation_id, seq, invocation_id, step_seq, tool_name, risk,
          inverse, disposition)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        compensationId,
        item.seq,
        item.invocationId,
        item.stepSeq,
        item.toolName,
        item.risk,
        item.inverse ? JSON.stringify(item.inverse) : null,
        item.disposition,
      ],
    );
  }

  await runs.audit(db, {
    orgId: p.orgId,
    runId: p.runId,
    actorKind: "human",
    actorId: p.requestedBy,
    action: "compensation.requested",
    detail: {
      compensation_id: compensationId,
      reason: p.reason,
      items: items.length,
      unrevertable: items.filter((i) => i.disposition === REPORT).length,
      plan_hash: actual,
    },
  });
  return compensationId;
}

// ------------------------------------------------------------------ reading

export async function get(db: Queryable, compensationId: string): Promise<Row> {
  const row = await fetchOne(db, "select * from compensations where id = $1", [compensationId]);
  if (row === null) throw new Error(`no compensation ${compensationId}`);
  return row;
}

export async function itemsFor(db: Queryable, compensationId: string): Promise<Row[]> {
  return all(
    db,
    "select * from compensation_items where compensation_id = $1 order by seq",
    [compensationId],
  );
}

export async function forRun(db: Queryable, runId: string): Promise<Row[]> {
  return all(db, "select * from compensations where run_id = $1 order by created_at desc", [
    runId,
  ]);
}

async function runForOrg(db: Queryable, runId: string, orgId: string): Promise<Row> {
  const row = await fetchOne(db, "select * from runs where id = $1 and org_id = $2", [
    runId,
    orgId,
  ]);
  if (row === null) throw new PlanError("no such run for this merchant");
  return row;
}

// ------------------------------------------------------------------ leasing

/**
 * Lease one runnable compensation, or return null.
 *
 * The same shape as `runs.claimNext`, for the same reason: `for update skip
 * locked` lets several workers share the queue without coordinating, and a
 * `running` row whose lease expired is a worker that died.
 */
export async function claimNext(
  db: Queryable,
  workerId: string,
  leaseSeconds = 60,
): Promise<Row | null> {
  return fetchOne(
    db,
    `update compensations set
       status = 'running',
       lease_owner = $1,
       lease_expires_at = now() + make_interval(secs => $2),
       attempt = attempt + 1,
       updated_at = now()
     where id = (
       select id from compensations
        where status = 'queued'
           or (status = 'running' and lease_expires_at < now())
        order by created_at
        for update skip locked
        limit 1
     )
     returning *`,
    [workerId, leaseSeconds],
  );
}

export async function renewLease(
  db: Queryable,
  compensationId: string,
  workerId: string,
  leaseSeconds = 60,
): Promise<boolean> {
  const changed = await execute(
    db,
    `update compensations set lease_expires_at = now() + make_interval(secs => $1),
                              updated_at = now()
      where id = $2 and lease_owner = $3 and status = 'running'`,
    [leaseSeconds, compensationId, workerId],
  );
  return changed === 1;
}

// ---------------------------------------------------------------- executing

/**
 * Drive one leased compensation to a terminal status.
 *
 * One item per iteration, one commit per item. A worker that dies between two
 * items loses nothing: the next one reads the item statuses and continues from
 * the first that is still `pending`. Nothing about the position lives in a
 * variable here either.
 */
export async function advance(
  db: pg.PoolClient,
  compensationId: string,
  workerId: string,
  leaseSeconds = 60,
): Promise<string> {
  for (;;) {
    await db.query("begin");
    let comp: Row;
    let item: Row | null;
    try {
      if (!(await renewLease(db, compensationId, workerId, leaseSeconds))) {
        await db.query("commit");
        throw new LeaseLost(compensationId);
      }

      comp = await get(db, compensationId);

      // Boundedness. A run is bounded by steps, tokens, spend and a deadline. A
      // compensation makes no model calls and has a plan that cannot grow, so
      // the only way it can fail to terminate is by crashing and being
      // re-claimed forever. This is that bound, and it is checked before doing
      // any work rather than after.
      if (Number(comp["attempt"]) > Number(comp["max_attempts"])) {
        await finish(db, comp, {
          status: "blocked",
          reason: STOP_ATTEMPTS,
          detail:
            `gave up after ${comp["attempt"]} attempts;` +
            " a person needs to look at why it keeps failing",
        });
        await db.query("commit");
        return "blocked";
      }

      item = await nextPending(db, compensationId);
      if (item === null) {
        const [status, reason, detail] = await outcome(db, compensationId);
        await finish(db, comp, { status, reason, detail });
        await db.query("commit");
        return status;
      }

      if (item["disposition"] === REPORT) {
        // Nothing to execute. The row exists so that "what could this not take
        // back" has an answer that outlives the incident.
        await mark(db, String(item["id"]), "unrevertable", {
          detail: `${item["tool_name"]} is irreversible; no inverse exists`,
        });
        await db.query("commit");
        continue;
      }

      await db.query("commit");
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error;
    }

    // Claim the item and apply its inverse in one transaction. Not a savepoint,
    // unlike `tools/invoke`: there, the failure has to be recorded alongside the
    // rest of a step that is still in flight, so the surrounding transaction
    // must survive. Here nothing else is in flight, so a failure rolls the whole
    // thing back and the record of it is written fresh. Either the ticket moved
    // and the row says `reverted`, or neither happened.
    await db.query("begin");
    // Set only when the inverse itself refused. Anything else thrown in here —
    // the connection went away, a bug in this function — is not something this
    // module can describe, so it propagates and the worker lets the lease
    // expire rather than writing a diagnosis it does not have.
    let refused: unknown = null;
    try {
      const claimed = await claimItem(db, String(item["id"]));
      if (!claimed) {
        // Another worker took it between the read and here. Its own transaction
        // owns the outcome.
        await db.query("commit");
        continue;
      }

      const ctx = await context(db, comp, item);
      try {
        await applyInverse(ctx, item["inverse"] as Inverse);
      } catch (error) {
        if (!isInverseFailure(error)) throw error;
        refused = error;
      }

      if (refused === null) await db.query("commit");
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error;
    }

    if (refused !== null) {
      // The claim and the inverse were in one transaction, so rolling back
      // un-claims the item as well as undoing whatever the inverse managed.
      // `fail` then writes the record of the refusal in a fresh transaction.
      await db.query("rollback").catch(() => {});
      await fail(db, comp, item, refused);
      return "blocked";
    }
  }
}

/**
 * Whether a thrown value is the inverse refusing, rather than the process
 * falling over. `ToolError` is the tool layer saying no; a `pg` error carries a
 * SQLSTATE `code` and means the statement itself was rejected. Both describe
 * this item. Anything else is not about the item at all.
 */
function isInverseFailure(error: unknown): boolean {
  if (error instanceof ToolError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

/**
 * The scope an inverse is applied under.
 *
 * `orgId` is the compensation's, not the inverse's. The ids inside an inverse
 * were captured by handlers that already filtered on the org, so they are
 * in-tenant by construction — but `applyInverse` scopes every statement to
 * `ctx.orgId` anyway, so the guarantee does not depend on that argument still
 * being true two releases from now.
 */
async function context(db: Queryable, comp: Row, item: Row): Promise<ToolContext> {
  const subject = await one(
    db,
    `select t.id as ticket_id, t.customer_id from runs r
       join tickets t on t.id = r.ticket_id where r.id = $1`,
    [comp["run_id"]],
  );
  return {
    orgId: String(comp["org_id"]),
    runId: String(comp["run_id"]),
    // The step whose effect is being walked back. Carried so a handler that
    // wants to know has a true answer rather than a placeholder.
    stepId: String(item["invocation_id"]),
    ticketId: String(subject["ticket_id"]),
    customerId: String(subject["customer_id"]),
    db,
  };
}

async function nextPending(db: Queryable, compensationId: string): Promise<Row | null> {
  return fetchOne(
    db,
    `select * from compensation_items
      where compensation_id = $1 and status = 'pending'
      order by seq limit 1`,
    [compensationId],
  );
}

/**
 * Flip one item to `reverted`, losing the race if somebody already did.
 *
 * This is `tools/invoke`'s guarantee expressed in a different table. The write
 * that says "this was undone" and the undoing itself are in one transaction, so
 * a crash before the commit leaves neither and a crash after leaves both. The
 * conditional `status = 'pending'` is what makes a second attempt a no-op
 * instead of a second revert.
 */
async function claimItem(db: Queryable, itemId: string): Promise<boolean> {
  const row = await fetchOne(
    db,
    `update compensation_items set status = 'reverted', applied_at = now()
      where id = $1 and status = 'pending' returning id`,
    [itemId],
  );
  return row !== null;
}

async function mark(
  db: Queryable,
  itemId: string,
  status: string,
  opts: { detail?: string | null } = {},
): Promise<void> {
  await execute(
    db,
    `update compensation_items set status = $1::compensation_item_status, detail = $2
      where id = $3`,
    [status, opts.detail ?? null, itemId],
  );
}

/**
 * Record a failed inverse and stop, leaving everything after it untouched.
 *
 * The remaining items are marked `skipped` rather than left `pending`, because
 * `pending` would mean "a worker will get to this" and no worker will. A person
 * decides whether to fix the obstruction and request a fresh compensation,
 * which will re-plan around whatever this one managed.
 */
async function fail(
  db: pg.PoolClient,
  comp: Row,
  item: Row,
  error: unknown,
): Promise<void> {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const detail = `${name}: ${message}`;

  await db.query("begin");
  try {
    await mark(db, String(item["id"]), "failed", { detail });
    await execute(
      db,
      `update compensation_items set status = 'skipped',
              detail = 'not attempted: an earlier inverse failed'
        where compensation_id = $1 and status = 'pending'`,
      [comp["id"]],
    );
    await finish(db, comp, {
      status: "blocked",
      reason: STOP_INVERSE_FAILED,
      detail: `could not revert ${item["tool_name"]} from step ${item["step_seq"]}: ${detail}`,
    });
    await db.query("commit");
  } catch (error_) {
    await db.query("rollback").catch(() => {});
    throw error_;
  }
}

async function outcome(
  db: Queryable,
  compensationId: string,
): Promise<[string, string, string]> {
  const rows = await all(
    db,
    `select status::text as status, count(*) as n from compensation_items
      where compensation_id = $1 group by status`,
    [compensationId],
  );
  const counts = new Map(rows.map((r) => [r["status"] as string, Number(r["n"])]));
  const reverted = counts.get("reverted") ?? 0;
  const unrevertable = counts.get("unrevertable") ?? 0;

  if (unrevertable > 0) {
    return [
      "partial",
      STOP_COMPLETE,
      `reverted ${reverted}; ${unrevertable} irreversible ` +
        `${unrevertable === 1 ? "act" : "acts"} could not be taken back`,
    ];
  }
  return ["applied", STOP_COMPLETE, `reverted ${reverted}`];
}

async function finish(
  db: Queryable,
  comp: Row,
  p: { status: string; reason: string; detail?: string | null },
): Promise<void> {
  await execute(
    db,
    `update compensations set status = $1::compensation_status, stop_reason = $2,
                              stop_detail = $3, lease_owner = null,
                              lease_expires_at = null, finished_at = now(),
                              updated_at = now()
      where id = $4`,
    [p.status, p.reason, p.detail ?? null, comp["id"]],
  );
  await runs.audit(db, {
    orgId: String(comp["org_id"]),
    runId: String(comp["run_id"]),
    actorKind: "system",
    action: `compensation.${p.status}`,
    detail: {
      compensation_id: String(comp["id"]),
      stop_reason: p.reason,
      stop_detail: p.detail ?? null,
    },
  });
}
