/**
 * Setup for the trajectory evals.
 *
 * Deliberately thin. The evals drive the *real* runtime against a *real*
 * database — same loop, same tools, same approval gate the API uses — because
 * an eval that runs against a simplified copy of the system is measuring the
 * copy. Only the model is substituted, and only because a scripted one lets a
 * scenario say "now the agent asks for a refund" without paying for a token or
 * hoping.
 */

import {
  all,
  closePool,
  fetchOne,
  one,
  pool,
  transaction,
  withClient,
  type Row,
} from "../src/db.ts";
import type { Provider } from "../src/providers.ts";
import * as approvals from "../src/runtime/approvals.ts";
import * as compensation from "../src/runtime/compensation.ts";
import * as loop from "../src/runtime/loop.ts";
import * as runs from "../src/runtime/runs.ts";
import { seed } from "../src/seed.ts";
import "../src/tools/index.ts";

export { closePool };

/** Rebuild the world. Every scenario starts from the same fixtures. */
export async function reset(): Promise<void> {
  await transaction((db) => seed(db));
}

export async function org(slug = "northwind"): Promise<string> {
  const row = await one(pool(), "select id from orgs where slug = $1", [slug]);
  return String(row["id"]);
}

export async function user(email = "owner@northwind.test"): Promise<string> {
  const row = await one(pool(), "select id from users where email = $1", [email]);
  return String(row["id"]);
}

export async function start(ticketReference: string): Promise<string> {
  const row = await fetchOne(
    pool(),
    "select id, org_id from tickets where reference = $1",
    [ticketReference],
  );
  if (row === null) throw new Error(`no ticket ${ticketReference}`);
  return transaction(async (db) =>
    runs.create(db, {
      orgId: String(row["org_id"]),
      ticketId: String(row["id"]),
      startedBy: await user(),
    }),
  );
}

/** Claim the run and advance it, exactly as a worker does. */
export async function drive(
  runId: string,
  provider: Provider,
  worker = "eval",
): Promise<string> {
  await transaction((db) =>
    db.query(
      `update runs set status = 'running', lease_owner = $1,
                       lease_expires_at = now() + interval '60 seconds',
                       attempt = attempt + 1
        where id = $2`,
      [worker, runId],
    ),
  );
  return withClient((db) => loop.advance(db, runId, worker, provider));
}

/** Stop renewing the lease, which is all dying actually looks like. */
export async function killWorker(runId: string): Promise<void> {
  await transaction((db) =>
    db.query("update runs set lease_expires_at = now() - interval '1 second' where id = $1", [
      runId,
    ]),
  );
}

export async function claim(worker: string): Promise<Row | null> {
  return transaction((db) => runs.claimNext(db, worker));
}

export async function decide(
  runId: string,
  decision: "approved" | "denied",
  reason: string | null = null,
): Promise<void> {
  const approval = await fetchOne(
    pool(),
    "select id, org_id from approvals where run_id = $1 and status = 'pending'",
    [runId],
  );
  if (approval === null) throw new Error("no pending approval to decide");
  await transaction(async (db) =>
    approvals.decide(db, {
      approvalId: String(approval["id"]),
      orgId: String(approval["org_id"]),
      decision,
      decidedBy: await user(),
      reason,
    }),
  );
}

export async function expireApprovals(runId: string): Promise<void> {
  await transaction((db) =>
    db.query(
      "update approvals set expires_at = now() - interval '1 second' where run_id = $1",
      [runId],
    ),
  );
}

/**
 * Columns `shrink` is allowed to set.
 *
 * The column names come from the caller rather than from a literal, so this is
 * the one query in the project that has to be *composed*. An allow-list is how
 * that is done safely here: a name that is not in this set never reaches the
 * SQL, so there is no path from a caller's string to an identifier. Postgres
 * has no placeholder for an identifier, and interpolating one is the exact
 * shape of an injection — so the safe version is to not interpolate anything
 * the caller chose.
 */
const SHRINKABLE = new Set([
  "status",
  "lease_owner",
  "lease_expires_at",
  "finished_at",
  "suspended_at",
  "max_steps",
  "max_tokens",
  "max_spend_micros",
  "max_refund_cents",
  "cost_micros",
  "deadline_at",
  "attempt",
]);

/** Tighten a bound on a live run, so a scenario need not burn 24 steps. */
export async function shrink(runId: string, columns: Record<string, unknown>): Promise<void> {
  const names = Object.keys(columns);
  for (const name of names) {
    if (!SHRINKABLE.has(name)) throw new Error(`shrink will not set ${JSON.stringify(name)}`);
  }
  const assignments = names.map((name, index) => `${name} = $${index + 1}`).join(", ");
  await transaction((db) =>
    db.query(`update runs set ${assignments} where id = $${names.length + 1}`, [
      ...names.map((name) => columns[name]),
      runId,
    ]),
  );
}

export async function refunds(): Promise<Row[]> {
  return all(pool(), "select * from refunds order by created_at");
}

export async function emails(): Promise<Row[]> {
  return all(pool(), "select * from customer_emails order by sent_at");
}

// ----------------------------------------------------------- compensation

/** Preview a plan and authorise that exact plan, as the two endpoints do. */
export async function compensate(
  runId: string,
  reason = "the run did the wrong thing",
): Promise<string> {
  return transaction(async (db) => {
    const items = await compensation.plan(db, runId);
    return compensation.create(db, {
      orgId: await org(),
      runId,
      requestedBy: await user(),
      reason,
      expectedPlanHash: compensation.planHash(items),
    });
  });
}

export async function planOf(runId: string) {
  return compensation.plan(pool(), runId);
}

/** Claim and advance it, exactly as the worker does. */
export async function applyCompensation(
  compensationId: string,
  worker = "eval",
): Promise<string> {
  await transaction((db) =>
    db.query(
      `update compensations set status = 'running', lease_owner = $1,
                                lease_expires_at = now() + interval '60 seconds',
                                attempt = attempt + 1
        where id = $2`,
      [worker, compensationId],
    ),
  );
  return withClient((db) => compensation.advance(db, compensationId, worker));
}

export async function killCompensationWorker(compensationId: string): Promise<void> {
  await transaction((db) =>
    db.query(
      "update compensations set lease_expires_at = now() - interval '1 second' where id = $1",
      [compensationId],
    ),
  );
}

export async function claimCompensation(worker: string): Promise<Row | null> {
  return transaction((db) => compensation.claimNext(db, worker));
}

export async function compensationRow(compensationId: string): Promise<Row> {
  return one(pool(), "select * from compensations where id = $1", [compensationId]);
}

export async function compensationItems(compensationId: string): Promise<Row[]> {
  return all(
    pool(),
    "select * from compensation_items where compensation_id = $1 order by seq",
    [compensationId],
  );
}

export async function ticket(reference: string): Promise<Row> {
  return one(pool(), "select * from tickets where reference = $1", [reference]);
}

export { all, fetchOne, one, pool, transaction, withClient };
export type { Row };
