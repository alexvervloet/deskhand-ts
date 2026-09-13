/**
 * Run records: creating them, leasing them, appending to them, ending them.
 *
 * The lease is the concurrency story. A worker claims a run for a bounded
 * window and must keep renewing it; if the worker dies, the lease simply
 * expires and the run becomes claimable again. Nothing has to notice the death,
 * no supervisor has to reap anything, and a network partition that makes a live
 * worker *look* dead costs at most a duplicated attempt — which the idempotency
 * ledger absorbs.
 */

import { settings } from "../config.ts";
import { execute, fetchOne, one, type Queryable, type Row } from "../db.ts";

/**
 * The vocabulary of endings. Fixed, because the UI renders these, the tests
 * assert on them, and "why did it stop" is the first question anyone asks.
 */
export const STOP_END_TURN = "end_turn";
export const STOP_STEP_CAP = "step_cap";
export const STOP_TOKEN_CAP = "token_cap";
export const STOP_SPEND_CAP = "spend_cap";
export const STOP_DEADLINE = "deadline";
export const STOP_LOOP = "loop_detected";
export const STOP_NO_PROGRESS = "no_progress";
export const STOP_APPROVAL_DENIED = "approval_denied";
export const STOP_APPROVAL_EXPIRED = "approval_expired";
export const STOP_ORG_BUDGET = "org_daily_budget";
export const STOP_PLATFORM_BUDGET = "platform_daily_budget";
export const STOP_REFUSAL = "model_refusal";
export const STOP_ERROR = "error";
export const STOP_CANCELLED = "cancelled";

export type StepKind = "model_call" | "tool_result" | "approval" | "final" | "error";

/**
 * Queue a run against one ticket.
 *
 * Bounds are snapshotted here rather than read at each step: a config change
 * mid-flight must not move the goalposts for a run already under way.
 *
 * **The prompt names the ticket and quotes none of it.** The reference is an
 * identifier this system minted; the subject is a line a customer typed into a
 * form. Interpolating the subject here used to look harmless — it is one short
 * line, and it helps the agent know what it is picking up — but the opening
 * prompt is the one message `transcript.rebuild` does not fence, so that line
 * was the single piece of customer text reaching the model as trusted
 * narration. The subject is not lost: `get_ticket` returns it, inside the
 * fence, along with the body it belongs to.
 */
export async function create(
  db: Queryable,
  params: { orgId: string; ticketId: string; startedBy?: string | null },
): Promise<string> {
  const ticket = await fetchOne(
    db,
    "select reference from tickets where id = $1 and org_id = $2",
    [params.ticketId, params.orgId],
  );
  if (ticket === null) throw new Error("no such ticket for this org");

  const prompt =
    `Work support ticket ${ticket["reference"]}.\n\n` +
    "Read the ticket, establish the facts from the order record and the knowledge " +
    "base, and then do what is actually due. Finish by summarising what you did and " +
    "why. If the right answer is that a human has to decide, say so and escalate " +
    "rather than guessing.";

  const row = await one(
    db,
    `insert into runs (org_id, ticket_id, started_by, prompt, max_steps, max_tokens,
                       max_spend_micros, max_refund_cents, deadline_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))
     returning id`,
    [
      params.orgId,
      params.ticketId,
      params.startedBy ?? null,
      prompt,
      settings.maxStepsPerRun,
      settings.maxTokensPerRun,
      settings.maxSpendMicrosPerRun,
      settings.maxRefundCentsPerRun,
      settings.maxWallclockSecondsPerRun,
    ],
  );
  return String(row["id"]);
}

/**
 * Lease one runnable run, or return null.
 *
 * `for update skip locked` is what lets several workers share the queue without
 * coordinating: each takes a different row instead of blocking on the same one.
 * The `or` clause is the recovery path — a run still marked `running` whose
 * lease has expired is a run whose worker died, and it is claimable again.
 */
export async function claimNext(
  db: Queryable,
  workerId: string,
  leaseSeconds = 60,
): Promise<Row | null> {
  return fetchOne(
    db,
    `update runs set
       status = 'running',
       lease_owner = $1,
       lease_expires_at = now() + make_interval(secs => $2),
       attempt = attempt + 1,
       updated_at = now()
     where id = (
       select id from runs
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

/**
 * Extend this worker's lease. False means we lost it and must stop.
 *
 * Losing a lease is not an error — it means we were slow enough to look dead
 * and somebody else has the run. Continuing to write would be the error.
 */
export async function renewLease(
  db: Queryable,
  runId: string,
  workerId: string,
  leaseSeconds = 60,
): Promise<boolean> {
  const changed = await execute(
    db,
    `update runs set lease_expires_at = now() + make_interval(secs => $1), updated_at = now()
      where id = $2 and lease_owner = $3 and status = 'running'`,
    [leaseSeconds, runId, workerId],
  );
  return changed === 1;
}

export async function get(db: Queryable, runId: string): Promise<Row> {
  const row = await fetchOne(db, "select * from runs where id = $1", [runId]);
  if (row === null) throw new Error(`no run ${runId}`);
  return row;
}

export async function nextSeq(db: Queryable, runId: string): Promise<number> {
  const row = await one(
    db,
    "select coalesce(max(seq), 0) + 1 as seq from steps where run_id = $1",
    [runId],
  );
  return Number(row["seq"]);
}

export interface AppendStepParams {
  runId: string;
  seq: number;
  kind: StepKind;
  content: Record<string, unknown>;
  toolName?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costMicros?: number;
  latencyMs?: number;
}

export async function appendStep(db: Queryable, p: AppendStepParams): Promise<string> {
  const row = await one(
    db,
    `insert into steps (run_id, seq, kind, content, tool_name, input_tokens,
                        output_tokens, cost_micros, latency_ms)
     values ($1, $2, $3::step_kind, $4, $5, $6, $7, $8, $9) returning id`,
    [
      p.runId,
      p.seq,
      p.kind,
      JSON.stringify(p.content),
      p.toolName ?? null,
      p.inputTokens ?? 0,
      p.outputTokens ?? 0,
      p.costMicros ?? 0,
      p.latencyMs ?? 0,
    ],
  );
  return String(row["id"]);
}

export async function addUsage(
  db: Queryable,
  runId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    provider: string;
    model: string;
  },
): Promise<void> {
  await execute(
    db,
    `update runs set input_tokens = input_tokens + $1,
                     output_tokens = output_tokens + $2,
                     cost_micros = cost_micros + $3,
                     provider = $4, model = $5, updated_at = now()
      where id = $6`,
    [usage.inputTokens, usage.outputTokens, usage.costMicros, usage.provider, usage.model, runId],
  );
}

/**
 * Park the run. Note the lease is released at the same time — a run waiting on
 * a human could be waiting for a day, and holding a 60-second lease across that
 * would make it look perpetually crashed.
 *
 * `suspended_at` is stamped here so `requeue` can give the wait back to the
 * deadline. Without it the wall-clock budget runs while a person is reading the
 * approval screen, and they are penalised for taking it seriously.
 */
export async function suspendForApproval(db: Queryable, runId: string): Promise<void> {
  await execute(
    db,
    `update runs set status = 'awaiting_approval', lease_owner = null,
                     lease_expires_at = null, suspended_at = now(),
                     updated_at = now()
      where id = $1`,
    [runId],
  );
}

/**
 * Make a suspended run claimable again, once a human has decided.
 *
 * The deadline moves forward by exactly the time the run spent suspended. That
 * is not the deadline resetting: only *measured* wait on a human is ever added,
 * so a run that crash-loops still cannot earn itself a fresh clock, and a run
 * nobody answers still ends — on the approval's own TTL, which is the bound
 * that belongs to a person not answering.
 *
 * Without this the deadline bounded human deliberation as well as agent work,
 * and the failure was the worst shape available: a refund approved after the
 * budget ran out executed, and the run then died on the deadline with the money
 * gone and no summary written.
 */
export async function requeue(db: Queryable, runId: string): Promise<void> {
  await execute(
    db,
    `update runs set status = 'queued',
                     deadline_at = deadline_at
                                   + (now() - coalesce(suspended_at, now())),
                     suspended_at = null,
                     updated_at = now()
      where id = $1 and status = 'awaiting_approval'`,
    [runId],
  );
}

export async function finish(
  db: Queryable,
  runId: string,
  p: { status: string; stopReason: string; stopDetail?: string | null },
): Promise<void> {
  await execute(
    db,
    `update runs set status = $1::run_status, stop_reason = $2, stop_detail = $3,
                     lease_owner = null, lease_expires_at = null,
                     finished_at = now(), updated_at = now()
      where id = $4`,
    [p.status, p.stopReason, p.stopDetail ?? null, runId],
  );
}

export async function audit(
  db: Queryable,
  p: {
    orgId: string;
    action: string;
    actorKind?: string;
    actorId?: string | null;
    runId?: string | null;
    detail?: Record<string, unknown> | null;
  },
): Promise<void> {
  await execute(
    db,
    `insert into audit_log (org_id, actor_kind, actor_id, run_id, action, detail)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      p.orgId,
      p.actorKind ?? "system",
      p.actorId ?? null,
      p.runId ?? null,
      p.action,
      JSON.stringify(p.detail ?? {}),
    ],
  );
}
