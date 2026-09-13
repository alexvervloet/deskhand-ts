/**
 * The worker: claim something, drive it, repeat.
 *
 * Two queues, one process. Runs go forwards through the agent loop;
 * compensations go backwards through a plan over the ledger. They share a
 * worker because they share the only thing that coordinates anything here,
 * which is Postgres, and because a deployment that needs a second process type
 * to be able to undo anything has made undoing the harder half of its
 * operations story.
 *
 *     npm run worker
 *
 * Run as many as you like. They coordinate only through the database — there is
 * no leader, no assignment, and no shared memory. A worker that is killed
 * mid-trajectory loses nothing except the lease it was holding, which expires
 * on its own and lets another worker pick the run up exactly where the step log
 * says it was.
 */

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { closePool, transaction, withClient } from "./db.ts";
import { getProvider, type Provider } from "./providers.ts";
import * as approvals from "./runtime/approvals.ts";
import * as compensation from "./runtime/compensation.ts";
import * as loop from "./runtime/loop.ts";
import * as runs from "./runtime/runs.ts";

export const POLL_MS = 2_000;
export const LEASE_SECONDS = 60;

/**
 * Identifies this process in the lease. Host and pid make an abandoned lease
 * traceable to the machine that abandoned it.
 */
export function workerId(): string {
  return `${hostname()}/${process.pid}/${randomBytes(3).toString("hex")}`;
}

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

/**
 * Claim and drive at most one unit of work. True if there was any.
 *
 * Compensations are drained first. A run is a live trajectory that can be
 * picked up again at any time; a compensation is somebody standing over a
 * system that has already done the wrong thing, waiting for it to stop being
 * wrong. Under load the second one should not queue behind the first.
 */
export async function workOnce(me: string, provider: Provider): Promise<boolean> {
  if (await compensateOnce(me)) return true;

  const run = await transaction(async (db) => {
    await approvals.expireStale(db);
    return runs.claimNext(db, me, LEASE_SECONDS);
  });

  if (run === null) return false;

  const runId = String(run["id"]);
  log(`claimed run ${runId} (attempt ${run["attempt"]})`);

  await withClient(async (db) => {
    try {
      const status = await loop.advance(db, runId, me, provider, LEASE_SECONDS);
      log(`run ${runId} -> ${status}`);
    } catch (error) {
      if (error instanceof loop.LeaseLost) {
        log(`lost the lease on run ${runId}; another worker has it`);
        return;
      }
      // An unexpected failure must not leave the run marked `running` with a
      // lease nobody holds — that is a run that looks alive and never moves.
      // Fail it explicitly, with the reason on the record.
      const name = error instanceof Error ? error.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      log(`run ${runId} crashed: ${name}: ${message}`);
      await transaction(async (fresh) => {
        await runs.finish(fresh, runId, {
          status: "failed",
          stopReason: runs.STOP_ERROR,
          stopDetail: `${name}: ${message}`,
        });
      });
    }
  });
  return true;
}

/** Claim and drive at most one compensation. True if there was work to do. */
export async function compensateOnce(me: string): Promise<boolean> {
  const comp = await transaction((db) => compensation.claimNext(db, me, LEASE_SECONDS));
  if (comp === null) return false;

  const compId = String(comp["id"]);
  log(`claimed compensation ${compId} (attempt ${comp["attempt"]})`);

  await withClient(async (db) => {
    try {
      const status = await compensation.advance(db, compId, me, LEASE_SECONDS);
      log(`compensation ${compId} -> ${status}`);
    } catch (error) {
      if (error instanceof compensation.LeaseLost) {
        log(`lost the lease on compensation ${compId}; another worker has it`);
        return;
      }
      // Deliberately not marked `blocked` here. A crash outside `advance` — a
      // connection that went away, a bug in this function — says nothing about
      // whether an inverse is safe to apply, and the attempt counter already
      // bounds how many times this can repeat. Leaving the lease to expire lets
      // a healthy worker try again and lets the bound end it if none is.
      const message = error instanceof Error ? error.message : String(error);
      log(`compensation ${compId} crashed: ${message}`);
    }
  });
  return true;
}

export async function main(): Promise<number> {
  let stopping = false;
  const stop = (signal: string) => () => {
    stopping = true;
    log(`signal ${signal} received; finishing the current step and stopping`);
  };
  process.on("SIGINT", stop("SIGINT"));
  process.on("SIGTERM", stop("SIGTERM"));

  const me = workerId();
  const provider = getProvider();
  log(`worker ${me} up, provider=${provider.name} model=${provider.model}`);

  while (!stopping) {
    try {
      if (!(await workOnce(me, provider))) await sleep(POLL_MS);
    } catch (error) {
      // The queue is the only thing that can be trusted to still be there after
      // an unexpected error, so back off and go round again rather than exiting
      // and losing the worker.
      const message = error instanceof Error ? error.message : String(error);
      log(`worker loop error; backing off: ${message}`);
      await sleep(POLL_MS * 2);
    }
  }

  await closePool();
  log(`worker ${me} stopped`);
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exit(await main());
}
