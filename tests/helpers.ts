/**
 * Shared test fixtures.
 *
 * Tests run against a real Postgres, not a fake. The runtime's whole subject is
 * what the database guarantees under concurrency and crashes, and none of that
 * survives being mocked out.
 */

import { after } from "node:test";
import type pg from "pg";
import { all, closePool, fetchOne, one, pool, transaction, withClient, type Row } from "../src/db.ts";
import { run as migrate } from "../src/migrate.ts";
import { seed } from "../src/seed.ts";
import { setSink } from "../src/tracing.ts";
import * as loop from "../src/runtime/loop.ts";
import * as runs from "../src/runtime/runs.ts";
import type { Provider } from "../src/providers.ts";
import "../src/tools/index.ts";

// The event stream is a product feature and a test-output disaster: a crash
// sweep emits thousands of lines and buries the assertion that failed. Silenced
// unless asked for. tests/tracing.test.ts installs its own sink, so the thing
// that actually asserts on these lines is unaffected.
if (process.env["DESKHAND_TRACE"] !== "1") setSink(() => {});

let schemaReady = false;

/** Bring the schema up to date once per process. */
export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const code = await migrate();
  if (code !== 0) throw new Error("migrations failed");
  schemaReady = true;
}

/** Reseed. Call from any test that writes. */
export async function fresh(): Promise<void> {
  await ensureSchema();
  await transaction((db) => seed(db));
}

/** Close the pool when the file's tests are done, so the process can exit. */
export function closeAfter(): void {
  after(async () => {
    await closePool();
  });
}

export async function orgId(slug = "northwind"): Promise<string> {
  const row = await one(pool(), "select id from orgs where slug = $1", [slug]);
  return String(row["id"]);
}

export async function ticketId(reference: string): Promise<string> {
  const row = await one(pool(), "select id from tickets where reference = $1", [reference]);
  return String(row["id"]);
}

export async function userId(email: string): Promise<string> {
  const row = await one(pool(), "select id from users where email = $1", [email]);
  return String(row["id"]);
}

export async function startRun(reference: string): Promise<string> {
  const slug = reference.startsWith("NW") ? "northwind" : "lumen";
  return transaction(async (db) =>
    runs.create(db, {
      orgId: await orgId(slug),
      ticketId: await ticketId(reference),
      startedBy: await userId(`agent@${slug}.test`),
    }),
  );
}

/** Claim and advance, the way a worker would. */
export async function drive(
  runId: string,
  provider: Provider,
  worker = "test-worker",
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

/** Simulate the worker being killed: the lease simply stops being renewed. */
export async function expireLease(runId: string): Promise<void> {
  await transaction((db) =>
    db.query("update runs set lease_expires_at = now() - interval '1 second' where id = $1", [
      runId,
    ]),
  );
}

export async function runRow(runId: string): Promise<Row> {
  return one(pool(), "select * from runs where id = $1", [runId]);
}

export async function stepsOf(runId: string): Promise<Row[]> {
  return all(pool(), "select * from steps where run_id = $1 order by seq", [runId]);
}

export async function refunds(): Promise<Row[]> {
  return all(pool(), "select * from refunds order by created_at");
}

export async function approvalsOf(runId: string): Promise<Row[]> {
  return all(pool(), "select * from approvals where run_id = $1 order by created_at", [runId]);
}

export async function auditOf(runId: string, action?: string): Promise<Row[]> {
  if (action !== undefined) {
    return all(pool(), "select * from audit_log where run_id = $1 and action = $2", [
      runId,
      action,
    ]);
  }
  return all(pool(), "select * from audit_log where run_id = $1 order by created_at", [runId]);
}

export { all, fetchOne, one, pool, transaction, withClient };
export type { Row, pg };
