/**
 * The approval gate.
 *
 * Invariant 2: *no irreversible tool executes without a recorded human approval
 * tied to that exact run, step, and argument hash.*
 *
 * The binding to `args_hash` is the part that does the work. An approval is not
 * "this agent may issue refunds" or even "this run may issue a refund" — it is
 * "this run may issue *this* refund, of this amount, against this order". If
 * the arguments differ by a cent when the run resumes, the hash differs, and
 * the runtime refuses rather than executing something a human never saw.
 *
 * Expiry is deliberately loud. An approval nobody answers ends the run with
 * `approval_expired`, which is a different outcome from `approval_denied` and
 * should be read differently: denial is the process working, expiry is the
 * process being absent.
 */

import { settings } from "../config.ts";
import { all, execute, fetchOne, type Queryable, type Row } from "../db.ts";
import { argsHash, get, type ToolArgs } from "../tools/index.ts";
import * as runs from "./runs.ts";

export type Decision = "approved" | "denied";

/**
 * Record that a human decision is needed, or return the existing request.
 *
 * Idempotent on (run_id, tool_use_id): a resumed run re-derives the same
 * tool_use id from its persisted step log and must find the decision that was
 * already made, not ask for a second one.
 */
export async function request(
  db: Queryable,
  p: {
    orgId: string;
    runId: string;
    stepSeq: number;
    toolUseId: string;
    toolName: string;
    args: ToolArgs;
  },
): Promise<Row> {
  const tool = get(p.toolName);
  const preview = tool.preview ? tool.preview(p.args) : `${p.toolName}(${JSON.stringify(p.args)})`;

  await execute(
    db,
    `insert into approvals (org_id, run_id, step_seq, tool_use_id, tool_name, args,
                            args_hash, preview, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))
     on conflict (run_id, tool_use_id) do nothing`,
    [
      p.orgId,
      p.runId,
      p.stepSeq,
      p.toolUseId,
      p.toolName,
      JSON.stringify(p.args),
      argsHash(p.toolName, p.args),
      preview,
      settings.approvalTtlSeconds,
    ],
  );
  const row = await lookup(db, p.runId, p.toolUseId);
  if (row === null) throw new Error(`approval vanished for ${p.runId}/${p.toolUseId}`);
  return row;
}

export async function lookup(
  db: Queryable,
  runId: string,
  toolUseId: string,
): Promise<Row | null> {
  return fetchOne(
    db,
    `select *, (status = 'pending' and expires_at < now()) as is_stale
       from approvals where run_id = $1 and tool_use_id = $2`,
    [runId, toolUseId],
  );
}

export async function pendingForOrg(db: Queryable, orgId: string): Promise<Row[]> {
  return all(
    db,
    `select a.*, r.ticket_id, t.reference as ticket_reference, t.subject
       from approvals a
       join runs r on r.id = a.run_id
       join tickets t on t.id = r.ticket_id
      where a.org_id = $1 and a.status = 'pending' and a.expires_at > now()
      order by a.created_at`,
    [orgId],
  );
}

/**
 * Record a human decision and make the run claimable again.
 *
 * Only a pending, unexpired approval can be decided. Approving something that
 * already expired would resurrect consent the process had already declared
 * stale, so it is rejected rather than accepted late.
 */
export async function decide(
  db: Queryable,
  p: {
    approvalId: string;
    orgId: string;
    decision: Decision;
    decidedBy: string;
    reason?: string | null;
  },
): Promise<Row> {
  if (p.decision !== "approved" && p.decision !== "denied") {
    throw new Error(`decision must be approved or denied, not ${JSON.stringify(p.decision)}`);
  }

  const row = await fetchOne(
    db,
    `update approvals set status = $1::approval_status, decided_by = $2,
                          decided_at = now(), reason = $3
      where id = $4 and org_id = $5 and status = 'pending' and expires_at > now()
      returning *`,
    [p.decision, p.decidedBy, p.reason ?? null, p.approvalId, p.orgId],
  );
  if (row === null) {
    throw new ApprovalNotPending("approval is not pending, has expired, or does not exist");
  }

  await runs.requeue(db, String(row["run_id"]));
  return row;
}

export class ApprovalNotPending extends Error {
  override readonly name = "ApprovalNotPending";
}

/**
 * Mark timed-out approvals expired and wake their runs so they can fail.
 *
 * Waking the run matters: a run left in `awaiting_approval` forever is
 * indistinguishable from one waiting on an attentive human. It has to be given
 * the chance to notice and end.
 */
export async function expireStale(db: Queryable): Promise<number> {
  const rows = await all(
    db,
    `update approvals set status = 'expired'
      where status = 'pending' and expires_at <= now() returning run_id`,
  );
  for (const row of rows) await runs.requeue(db, String(row["run_id"]));
  return rows.length;
}
