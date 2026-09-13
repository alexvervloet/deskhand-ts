/**
 * Executing a tool call exactly once.
 *
 * This is the module that makes invariant 1 — *never re-execute a completed
 * side effect* — true, and it is short because the guarantee comes from where
 * the write happens rather than from cleverness.
 *
 * The protocol:
 *
 *     1. Has this idempotency key already been recorded?  -> return what it did
 *     2. Otherwise run the handler
 *     3. Record the outcome under that key, in the SAME transaction
 *
 * The caller commits. So a crash anywhere in the middle is safe in both
 * directions: nothing was written, therefore nothing is remembered, therefore
 * the resumed run does it once. And once the commit lands, the effect and the
 * memory of it landed together, so the resumed run does it zero more times.
 *
 * The reason this is allowed to be so simple is that every side effect in this
 * system is a row in this same Postgres. A tool that charged a real payment
 * processor could not share a transaction with the ledger, and would need a
 * third `claimed` state plus reconciliation.
 */

import { savepoint, type Queryable } from "../db.ts";
import * as faults from "./faults.ts";
import { ToolError, get, validate, argsHash, type ToolArgs, type ToolContext } from "./base.ts";

export interface Invocation {
  toolName: string;
  risk: string;
  args: ToolArgs;
  argsHash: string;
  result: string;
  ok: boolean;
  /**
   * True when this call was already in the ledger, i.e. a resumed run reached a
   * step it had already completed. The world was not touched again.
   */
  replayed: boolean;
  durationMs: number;
  inverse: Record<string, unknown> | null;
}

/**
 * Make a tool result storable.
 *
 * Postgres `text` and `jsonb` cannot hold a NUL byte, and a tool that returns
 * one takes the whole run down with an error thrown from the ledger write —
 * after the side effect has already happened. That is the worst possible place
 * to fail: the money moved and the record of it did not.
 *
 * Real tools return NUL bytes more often than you would like: binary payloads
 * mislabelled as text, truncated UTF-8, a C library's buffer handed over
 * intact.
 */
export function sanitise(text: string): string {
  return text.replaceAll("\u0000", "\ufffd");
}

/**
 * The key for the tool call at step `seq` of `runId`.
 *
 * Deterministic by construction: a resumed run replays its persisted steps in
 * order, recomputes the identical key, and the ledger recognises it. Nothing
 * random, nothing clock-based — a uuid here would quietly disable the whole
 * mechanism while looking more rigorous.
 */
export function idempotencyKey(runId: string, seq: number): string {
  return `${runId}:${seq}`;
}

async function recorded(db: Queryable, key: string): Promise<Invocation | null> {
  const { rows } = await db.query(
    `select tool_name, risk, args, args_hash, result, status::text, inverse, duration_ms
       from tool_invocations where idempotency_key = $1`,
    [key],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    toolName: row["tool_name"],
    risk: row["risk"],
    args: row["args"],
    argsHash: row["args_hash"],
    result: row["result"],
    ok: row["status"] === "succeeded",
    replayed: true,
    durationMs: Number(row["duration_ms"]),
    inverse: row["inverse"] ?? null,
  };
}

export interface InvokeParams {
  orgId: string;
  runId: string;
  stepId: string;
  seq: number;
  toolName: string;
  args: ToolArgs;
}

/**
 * Run one tool call, or return the record of having already run it.
 *
 * Throws only for failures that are not the model's business — a bug in a
 * handler, a database that went away. Those leave no ledger row, so the step is
 * retried intact. Failures that *are* the model's business (bad arguments, a
 * missing order, a policy violation) come back as `ok: false` with the message
 * the model should read and react to.
 */
export async function invoke(db: Queryable, params: InvokeParams): Promise<Invocation> {
  const { orgId, runId, stepId, seq, toolName, args } = params;
  const key = idempotencyKey(runId, seq);

  // Step 1. The run holds an exclusive lease while this executes, so there is
  // no concurrent writer for this key; the unique index on the ledger is the
  // backstop that turns a leasing bug into an error rather than a double refund.
  const already = await recorded(db, key);
  if (already !== null) return already;

  const tool = get(toolName);
  const fingerprint = argsHash(toolName, args);

  // The run's subject, read here rather than passed in, so no caller can hand a
  // handler a scope that disagrees with the run's own row.
  const { rows } = await db.query(
    `select t.id as ticket_id, t.customer_id from runs r
       join tickets t on t.id = r.ticket_id where r.id = $1`,
    [runId],
  );
  const subject = rows[0];
  if (subject === undefined) throw new Error(`run ${runId} has no ticket`);

  const ctx: ToolContext = {
    orgId,
    runId,
    stepId,
    ticketId: String(subject["ticket_id"]),
    customerId: String(subject["customer_id"]),
    db,
  };

  const started = process.hrtime.bigint();
  let ok: boolean;
  let result: string;
  let inverse: Record<string, unknown> | null;

  try {
    // A savepoint, so a handler that fails part-way through leaves no partial
    // write behind AND leaves the surrounding transaction usable — without it,
    // one bad statement would poison the transaction we still need in order to
    // record that the call failed.
    const outcome = await savepoint(db, async () => {
      validate(toolName, args);
      // Fault injection sits inside the savepoint so an injected crash rolls
      // back exactly what a real one would. It is a no-op unless a test
      // installed something.
      await faults.before(toolName);
      return faults.after(toolName, await tool.handler(ctx, args));
    });
    ok = true;
    result = sanitise(outcome.result);
    inverse = outcome.inverse ?? null;
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    ok = false;
    result = sanitise(error.message);
    inverse = null;
  }

  const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);

  // Step 3. Written in the caller's transaction, alongside whatever the handler
  // just did.
  await db.query(
    `insert into tool_invocations
       (org_id, run_id, step_id, tool_name, risk, idempotency_key, args_hash,
        args, status, result, inverse, duration_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      orgId,
      runId,
      stepId,
      toolName,
      tool.risk,
      key,
      fingerprint,
      JSON.stringify(args),
      ok ? "succeeded" : "failed",
      result,
      inverse ? JSON.stringify(inverse) : null,
      durationMs,
    ],
  );

  return {
    toolName,
    risk: tool.risk,
    args,
    argsHash: fingerprint,
    result,
    ok,
    replayed: false,
    durationMs,
    inverse,
  };
}
