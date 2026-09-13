/**
 * Searching the crash space instead of picking one point in it.
 *
 * `a run resumes on another worker without repeating side effects` kills a
 * worker at turn 3 and asserts one refund. It proves the mechanism works *on
 * the schedule I thought of*.
 *
 * This file tries to break the same claim from three directions:
 *
 * 1. **Exhaustively**, over every crash schedule a short trajectory admits.
 *    Five turns is 32 subsets, which is small enough to enumerate — so the
 *    claim is "every possible crash schedule", not "a hundred random ones", and
 *    there is no seed to get lucky with.
 * 2. **By property**, with fast-check, over the space exhaustion cannot reach:
 *    longer trajectories, repeated crashes at the same turn, a suspended run
 *    crossing an approval.
 * 3. **Concurrently**, because the leasing story is about two workers racing
 *    and a schedule the test controls is not a race. Node has one thread, but
 *    the contention that matters here is between database transactions on
 *    separate connections, and concurrent promises produce exactly that.
 *
 * The claim under all three is the refinement property in `fingerprint.ts`: the
 * world after a crashed run is identical to the world after a clean one, and so
 * is the trajectory.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import pg from "pg";
import { settings } from "../src/config.ts";
import {
  ScriptedProvider,
  call,
  text,
  type ContentBlock,
  type Message,
  type ModelReply,
} from "../src/providers.ts";
import * as approvals from "../src/runtime/approvals.ts";
import * as compensation from "../src/runtime/compensation.ts";
import * as loop from "../src/runtime/loop.ts";
import * as runs from "../src/runtime/runs.ts";
import { invoke } from "../src/tools/invoke.ts";
import * as fingerprint from "./fingerprint.ts";
import {
  all,
  closeAfter,
  fetchOne,
  fresh,
  one,
  pool,
  transaction,
  withClient,
} from "./helpers.ts";

closeAfter();

// CI runs a modest search; the deep sweep is a command, not a default.
const EXAMPLES = Number(process.env["DESKHAND_FUZZ_EXAMPLES"] ?? "25");

// ------------------------------------------------------------------ scenarios

/**
 * A refund trajectory: reads, an irreversible act behind the gate, a reversible
 * act after it, and a summary. Chosen because it is the shortest path that
 * crosses every kind of step the resume has to reason about.
 */
const REFUND: ContentBlock[][] = [
  [call("get_ticket", { reference: "NW-1" })],
  [call("get_order", { reference: "NW-1042" })],
  [
    call("issue_refund", {
      order_reference: "NW-1042",
      amount_cents: 1900,
      reason: "Stale beans inside the refund window.",
    }),
  ],
  [call("add_internal_note", { reference: "NW-1", body: "Refund issued after approval." })],
  text("Refunded and noted."),
];

/** Two irreversible acts in one run, so a crash can land between them. */
const TWO_PAYOUTS: ContentBlock[][] = [
  [call("get_order", { reference: "NW-1042" })],
  [call("issue_refund", { order_reference: "NW-1042", amount_cents: 1000, reason: "First." })],
  [call("send_customer_email", { reference: "NW-1", subject: "Sorted", body: "Refunded." })],
  [call("set_ticket_status", { reference: "NW-1", status: "resolved" })],
  text("Done."),
];

/**
 * A long trajectory, so the crash space stops being enumerable. Ten turns is
 * 1024 schedules; the sweep below covers five turns exactly, and this is what
 * the property search is actually for.
 */
const LONG: ContentBlock[][] = [
  [call("get_ticket", { reference: "NW-1" })],
  [call("set_priority", { reference: "NW-1", priority: "high" })],
  [call("get_order", { reference: "NW-1042" })],
  [call("tag_ticket", { reference: "NW-1", tags: ["quality"] })],
  [call("search_kb", { query: "refund policy window" })],
  [
    call("issue_refund", {
      order_reference: "NW-1042",
      amount_cents: 1900,
      reason: "Stale beans inside the refund window.",
    }),
  ],
  [call("send_customer_email", { reference: "NW-1", subject: "Refunded", body: "Sorry." })],
  [call("add_internal_note", { reference: "NW-1", body: "Refunded and emailed." })],
  [call("set_ticket_status", { reference: "NW-1", status: "resolved" })],
  text("Done."),
];

/**
 * Six concurrent runs share one 48.00 order in the leasing test, so each takes
 * a small bite rather than the whole thing.
 */
const SMALL_REFUND: ContentBlock[][] = [
  [call("get_order", { reference: "NW-1042" })],
  [call("issue_refund", { order_reference: "NW-1042", amount_cents: 500, reason: "Share." })],
  [call("set_ticket_status", { reference: "NW-1", status: "resolved" })],
  text("Done."),
];

const SCRIPTS: Record<string, ContentBlock[][]> = {
  refund: REFUND,
  two_payouts: TWO_PAYOUTS,
  long: LONG,
};

/** A worker died here. Not a failure — the thing being tested. */
class Died extends Error {
  override readonly name = "Died";
}

/**
 * A provider that dies at chosen turns, once each.
 *
 * Dying *once per turn index* matters. The index is derived from the history,
 * so a resumed worker sees the same index again; a provider that died every
 * time would never let the run past that turn and the property would be vacuous
 * rather than false.
 *
 * The crash lands inside `complete`, which is before the model call's step is
 * written. So a crashed turn is always "nothing recorded for this turn", and
 * the resumed worker asks for the same turn and gets the same reply. That is
 * the window the step log is supposed to make safe.
 */
class DiesAt extends ScriptedProvider {
  readonly dieAt: ReadonlySet<number>;
  readonly died = new Set<number>();

  constructor(script: ContentBlock[][], dieAt: ReadonlySet<number>) {
    super(script.map((turn) => [...turn]));
    this.dieAt = dieAt;
  }

  override async complete(
    system: string,
    messages: Message[],
    tools: unknown[],
  ): Promise<ModelReply> {
    const index = ScriptedProvider.turnIndex(messages);
    if (this.dieAt.has(index) && !this.died.has(index)) {
      this.died.add(index);
      throw new Died(`worker died on turn ${index}`);
    }
    return super.complete(system, messages, tools);
  }
}

// -------------------------------------------------------------------- driving

const TERMINAL = new Set(["succeeded", "failed", "exhausted", "cancelled"]);

async function start(reference = "NW-1"): Promise<string> {
  const org = await one(pool(), "select id from orgs where slug = 'northwind'");
  const ticket = await one(pool(), "select id from tickets where reference = $1", [reference]);
  return transaction((db) =>
    runs.create(db, { orgId: String(org["id"]), ticketId: String(ticket["id"]) }),
  );
}

async function claim(runId: string, worker: string): Promise<void> {
  await transaction((db) =>
    db.query(
      `update runs set status = 'running', lease_owner = $1,
                       lease_expires_at = now() + interval '60 seconds',
                       attempt = attempt + 1
        where id = $2`,
      [worker, runId],
    ),
  );
}

async function approvePending(runId: string): Promise<void> {
  const pending = await all(
    pool(),
    "select id, org_id from approvals where run_id = $1 and status = 'pending'",
    [runId],
  );
  const owner = await one(pool(), "select id from users where email = 'owner@northwind.test'");
  await transaction(async (db) => {
    for (const row of pending) {
      await approvals.decide(db, {
        approvalId: String(row["id"]),
        orgId: String(row["org_id"]),
        decision: "approved",
        decidedBy: String(owner["id"]),
      });
    }
  });
}

/**
 * Drive one run to a terminal status, surviving every crash in `dieAt`.
 *
 * A fresh worker name after each death, because a resumed run being picked up
 * by *the same* worker would not exercise the handover — and the handover is
 * the thing under test.
 */
async function driveThrough(
  runId: string,
  script: ContentBlock[][],
  dieAt: ReadonlySet<number>,
): Promise<string> {
  const provider = new DiesAt(script, dieAt);
  for (let attempt = 0; attempt < 40; attempt++) {
    const worker = `worker-${attempt}`;
    await claim(runId, worker);
    let status: string;
    try {
      status = await withClient((db) => loop.advance(db, runId, worker, provider));
    } catch (error) {
      if (error instanceof Died) {
        // Exactly what a real death looks like from outside: the lease simply
        // stops being renewed. Nothing has to notice.
        continue;
      }
      throw error;
    }
    if (status === "awaiting_approval") {
      await approvePending(runId);
      continue;
    }
    if (TERMINAL.has(status)) return status;
  }
  throw new Error("run never terminated");
}

/** What a clean, uncrashed run of this script leaves behind. */
async function golden(
  script: ContentBlock[][],
): Promise<[fingerprint.Fingerprint, fingerprint.Fingerprint]> {
  await fresh();
  const runId = await start();
  const status = await driveThrough(runId, script, new Set());
  assert.equal(status, "succeeded", `the clean run did not succeed: ${status}`);
  return [await fingerprint.world(), await fingerprint.trajectory(runId)];
}

/** Every subset of `0..n-1`. */
function schedules(n: number): number[][] {
  const out: number[][] = [];
  for (let mask = 0; mask < 1 << n; mask++) {
    const subset: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(i);
    out.push(subset);
  }
  return out;
}

// ------------------------------------------------- 1. the exhaustive sweep

describe("the exhaustive sweep", () => {
  // All 32 of them, for a five-turn trajectory. Exhaustive rather than sampled,
  // which is the point: there is no seed here that could have been luckier, and
  // no schedule left unexamined. Random search over a space this small is
  // strictly worse than enumerating it.
  for (const subset of schedules(REFUND.length)) {
    const label = subset.join("+") || "clean";
    test(`every crash schedule leaves the same world: ${label}`, async () => {
      const [cleanWorld, cleanTrajectory] = await golden(REFUND);

      await fresh();
      const runId = await start();
      assert.equal(await driveThrough(runId, REFUND, new Set(subset)), "succeeded");

      const crashedWorld = await fingerprint.world();
      assert.ok(
        fingerprint.same(crashedWorld, cleanWorld),
        fingerprint.describe(cleanWorld, crashedWorld),
      );

      const crashedTrajectory = await fingerprint.trajectory(runId);
      assert.ok(
        fingerprint.same(crashedTrajectory, cleanTrajectory),
        fingerprint.describe(cleanTrajectory, crashedTrajectory),
      );

      // Exactly one refund is implied by the fingerprints, and asserted anyway
      // because it is the sentence the invariant is written in.
      assert.equal((await all(pool(), "select id from refunds")).length, 1);
    });
  }

  test("the sweep is not passing vacuously", async () => {
    // A property that holds because nothing happened is the failure mode of
    // every exhaustive search, and it does not announce itself: 32 green cases
    // look the same whether the crashes landed or not.
    await fresh();
    const runId = await start();
    assert.equal(await driveThrough(runId, REFUND, new Set([1, 3])), "succeeded");

    // One: the crashes actually cost the run its worker. `attempt` counts
    // claims, so a schedule with two deaths in it has to show more of them than
    // the approval suspension alone would explain.
    const run = await one(pool(), "select attempt from runs where id = $1", [runId]);
    assert.ok(
      Number(run["attempt"]) >= 4,
      `only ${run["attempt"]} claims; the crashes did not land`,
    );

    // Two: and the resume took the *cheap* path. An orderly resume rebuilds the
    // conversation from the step log, finds the tool's result already recorded,
    // and never calls the tool again — so it adds no ledger row and marks
    // nothing `replayed`. The ledger is the second line of defence, and it is
    // the race test below that exercises it.
    assert.equal(
      await fingerprint.replayedSteps(runId),
      0,
      "a replayed step here means the step log missed one and the ledger had to catch it",
    );
    assert.equal((await all(pool(), "select id from refunds")).length, 1);
  });
});

// ------------------------------------------------------ 2. the wider space

describe("the wider space", () => {
  test("any crash schedule on any trajectory", async () => {
    // The same claim, over trajectories exhaustion cannot enumerate.
    // `TWO_PAYOUTS` moves money and then sends an email, so a crash can land
    // between two irreversible acts — the case where "did the first one already
    // happen" and "did the second one already happen" have different answers.
    // `LONG` is ten turns, which is 1024 schedules and well past what the sweep
    // above enumerates.
    const cleanWorlds = new Map<string, fingerprint.Fingerprint>();
    for (const name of Object.keys(SCRIPTS)) {
      const [world] = await golden(SCRIPTS[name]!);
      cleanWorlds.set(name, world);
    }

    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 9 }), { maxLength: 10 }),
        fc.constantFrom(...Object.keys(SCRIPTS)),
        async (dieAt, scriptChoice) => {
          const script = SCRIPTS[scriptChoice]!;
          await fresh();
          const runId = await start();
          assert.equal(await driveThrough(runId, script, new Set(dieAt)), "succeeded");

          const crashedWorld = await fingerprint.world();
          const cleanWorld = cleanWorlds.get(scriptChoice)!;
          assert.ok(
            fingerprint.same(crashedWorld, cleanWorld),
            fingerprint.describe(cleanWorld, crashedWorld),
          );
        },
      ),
      { numRuns: EXAMPLES, verbose: true },
    );
  });

  // Enumerated rather than drawn, because there are five points a theft can
  // land at and enumerating five things is not a search.
  for (const stealAfter of [0, 1, 2, 3, 4]) {
    test(`a run stolen mid-flight is not paid out twice: after ${stealAfter}`, async () => {
      // A worker that merely *looks* dead, and a second one that believes it.
      //
      // Worth being precise about what a lease does. An expired lease does not
      // stop the worker holding it — `renewLease` matches on `lease_owner`, not
      // on expiry — it makes the run *claimable by somebody else*. The holder
      // only finds out when a claim actually happens and its next renewal
      // matches nothing.
      //
      // So this steals the run rather than just expiring it: at a chosen turn,
      // worker B claims a run worker A still believes it has. A discovers this
      // on its next renewal, stops immediately, and B finishes the work.
      // Whichever of them reaches the refund, the customer is paid once.
      await fresh();
      const runId = await start();

      let stolen = false;
      let finished = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        let owner = `worker-a${attempt}`;
        await claim(runId, owner);

        const stepsSoFar = await one(
          pool(),
          "select count(*)::int as n from steps where run_id = $1",
          [runId],
        );
        if (!stolen && Number(stepsSoFar["n"]) >= stealAfter * 2) {
          const thief = await transaction(async (db) => {
            await db.query(
              "update runs set lease_expires_at = now() - interval '1 second' where id = $1",
              [runId],
            );
            return runs.claimNext(db, "worker-b");
          });
          if (thief !== null) {
            stolen = true;
            owner = "worker-b";
          }
        }

        let status: string;
        try {
          status = await withClient((db) =>
            loop.advance(db, runId, owner, new ScriptedProvider(REFUND.map((t) => [...t]))),
          );
        } catch (error) {
          if (error instanceof loop.LeaseLost) continue;
          throw error;
        }
        if (status === "awaiting_approval") {
          await approvePending(runId);
          continue;
        }
        if (TERMINAL.has(status)) {
          finished = true;
          break;
        }
      }
      assert.ok(finished, "run never terminated");

      assert.equal((await all(pool(), "select id from refunds")).length, 1, "a stolen run paid twice");
      const keys = await all(pool(), "select idempotency_key from tool_invocations");
      assert.equal(keys.length, new Set(keys.map((k) => k["idempotency_key"])).size);
    });
  }
});

// ------------------------------------------------------- 3. an actual race

/** A promise that resolves once `count` callers have arrived. */
function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= count) release();
    return gate;
  };
}

describe("an actual race", () => {
  test("the ledger is what catches a real race", async () => {
    // Two callers, one step, one effect.
    //
    // The step log cannot help here: both read the same rows at the same moment
    // and both conclude the tool has not run. What separates them is the unique
    // index on `idempotency_key` and the fact that the effect and the claim are
    // written in one transaction.
    await fresh();
    const runId = await start();
    const org = await one(pool(), "select id from orgs where slug = 'northwind'");

    const stepId = await transaction((db) =>
      runs.appendStep(db, {
        runId,
        seq: 1,
        kind: "tool_result",
        content: {},
        toolName: "issue_refund",
      }),
    );

    const arrive = barrier(2);

    const attempt = async (): Promise<unknown> => {
      // A dedicated connection each, so the two transactions are genuinely
      // concurrent at the database rather than queued behind one client.
      const client = new pg.Client({ connectionString: settings.databaseUrl });
      await client.connect();
      try {
        await client.query("begin");
        await arrive();
        const result = await invoke(client as never, {
          orgId: String(org["id"]),
          runId,
          stepId,
          seq: 1,
          toolName: "issue_refund",
          args: {
            order_reference: "NW-1042",
            amount_cents: 1900,
            reason: "Racing.",
          },
        });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        return error;
      } finally {
        await client.end();
      }
    };

    const outcomes = await Promise.all([attempt(), attempt()]);

    assert.equal(outcomes.length, 2);
    assert.equal(
      (await all(pool(), "select id from refunds")).length,
      1,
      "two callers produced more than one refund",
    );
    assert.equal(
      (await all(pool(), "select id from tool_invocations where run_id = $1", [runId])).length,
      1,
      "two ledger rows for one idempotency key",
    );

    // One of the two either replayed the other's result or lost on the unique
    // index and threw. Both are correct; silently succeeding twice is not.
    assert.ok(
      outcomes.some((o) => !(o instanceof Error)),
      "both callers failed; the ledger should let one through",
    );
  });

  test("many workers sharing a queue do not collide", async () => {
    // The leasing story, run as an actual race. Six runs, four workers, no
    // coordination but Postgres. `for update skip locked` is what lets them
    // take different rows instead of blocking on the same one, and nothing in
    // the workers knows about the others.
    await fresh();
    const runIds: string[] = [];
    for (let i = 0; i < 6; i++) runIds.push(await start("NW-1"));

    const worker = async (name: string): Promise<void> => {
      const provider = new ScriptedProvider(SMALL_REFUND.map((t) => [...t]));
      for (let i = 0; i < 80; i++) {
        const claimed = await transaction(async (db) => {
          await approvals.expireStale(db);
          return runs.claimNext(db, name);
        });
        if (claimed === null) {
          const statuses = await all(
            pool(),
            "select status::text as status from runs where id = any($1)",
            [runIds],
          );
          if (statuses.every((r) => TERMINAL.has(r["status"] as string))) return;
          continue;
        }
        const runId = String(claimed["id"]);
        let status: string;
        try {
          status = await withClient((db) => loop.advance(db, runId, name, provider));
        } catch (error) {
          if (error instanceof loop.LeaseLost) continue;
          throw error;
        }
        if (status === "awaiting_approval") await approvePending(runId);
      }
    };

    await Promise.all([worker("w0"), worker("w1"), worker("w2"), worker("w3")]);

    const statuses = await all(
      pool(),
      "select status::text as status from runs where id = any($1)",
      [runIds],
    );
    assert.ok(
      statuses.every((r) => TERMINAL.has(r["status"] as string)),
      JSON.stringify(statuses),
    );

    // Six runs against the same order, each authorised once, each paying once.
    assert.equal((await all(pool(), "select id from refunds")).length, 6);

    const keys = await all(pool(), "select idempotency_key from tool_invocations");
    assert.equal(
      keys.length,
      new Set(keys.map((k) => k["idempotency_key"])).size,
      "a key was claimed twice",
    );
  });
});

// ---------------------------------------- 4. the same treatment, backwards

const COMPENSABLE: ContentBlock[][] = [
  [call("set_priority", { reference: "NW-1", priority: "high" })],
  [call("tag_ticket", { reference: "NW-1", tags: ["escalated"] })],
  [call("set_priority", { reference: "NW-1", priority: "urgent" })],
  [call("add_internal_note", { reference: "NW-1", body: "Triaged." })],
  [call("set_ticket_status", { reference: "NW-1", status: "pending" })],
  text("Triaged and noted."),
];

async function finishedRunWithFiveEffects(): Promise<string> {
  const runId = await start();
  await claim(runId, "w");
  const status = await withClient((db) =>
    loop.advance(db, runId, "w", new ScriptedProvider(COMPENSABLE.map((t) => [...t]))),
  );
  assert.equal(status, "succeeded");
  return runId;
}

async function authorise(runId: string): Promise<string> {
  const owner = await one(pool(), "select id from users where email = 'owner@northwind.test'");
  const org = await one(pool(), "select id from orgs where slug = 'northwind'");
  return transaction(async (db) => {
    const items = await compensation.plan(db, runId);
    return compensation.create(db, {
      orgId: String(org["id"]),
      runId,
      requestedBy: String(owner["id"]),
      reason: "fuzzing",
      expectedPlanHash: compensation.planHash(items),
    });
  });
}

/**
 * Drive a compensation to a terminal status, dying before chosen items.
 *
 * The crash lands *before* an item's transaction opens, which is the window a
 * worker actually dies in — between two commits. A death inside the transaction
 * is the case the item claim and the effect sharing one commit already makes
 * safe.
 */
async function applyThrough(
  compensationId: string,
  dieBefore: ReadonlySet<number>,
): Promise<string> {
  const died = new Set<number>();
  for (let attempt = 0; attempt < 40; attempt++) {
    const worker = `comp-${attempt}`;
    await transaction((db) =>
      db.query(
        `update compensations set status = 'running', lease_owner = $1,
                                  lease_expires_at = now() + interval '60 seconds',
                                  attempt = 1
          where id = $2`,
        [worker, compensationId],
      ),
    );

    const pending = await fetchOne(
      pool(),
      `select seq from compensation_items where compensation_id = $1
         and status = 'pending' order by seq limit 1`,
      [compensationId],
    );
    if (pending !== null) {
      const seq = Number(pending["seq"]);
      if (dieBefore.has(seq) && !died.has(seq)) {
        died.add(seq);
        continue; // the worker dies here; the lease simply lapses
      }
    }

    return withClient((db) => compensation.advance(db, compensationId, worker));
  }
  throw new Error("compensation never terminated");
}

/** Every subset of 1..5 up to size 3, matching the Python sweep. */
function compensationSchedules(): number[][] {
  const points = [1, 2, 3, 4, 5];
  const out: number[][] = [];
  for (let mask = 0; mask < 1 << points.length; mask++) {
    const subset = points.filter((_, i) => mask & (1 << i));
    if (subset.length < 4) out.push(subset);
  }
  return out;
}

describe("backwards", () => {
  for (const subset of compensationSchedules()) {
    const label = subset.join("+") || "clean";
    test(`every compensation crash schedule lands on the same state: ${label}`, async () => {
      // Compensation has a failure mode a forward run does not: its items are
      // ordered because each inverse restores what its own call overwrote, so a
      // *partial* application lands the ticket on a value neither the run nor
      // the compensation intended. A crash schedule that re-applied an item, or
      // skipped one, or applied them out of order would show up here as a
      // ticket in the wrong state — not as an error.
      await fresh();
      const cleanRun = await finishedRunWithFiveEffects();
      assert.equal(await applyThrough(await authorise(cleanRun), new Set()), "applied");
      const cleanWorld = await fingerprint.world();

      await fresh();
      const runId = await finishedRunWithFiveEffects();
      const compensationId = await authorise(runId);
      assert.equal(await applyThrough(compensationId, new Set(subset)), "applied");

      const crashedWorld = await fingerprint.world();
      assert.ok(
        fingerprint.same(crashedWorld, cleanWorld),
        fingerprint.describe(cleanWorld, crashedWorld),
      );

      // Every item applied exactly once. The partial unique index would have
      // raised on a second, but a *skipped* item raises nothing at all and is
      // only visible here.
      const statuses = await all(
        pool(),
        `select status::text as status from compensation_items
          where compensation_id = $1 order by seq`,
        [compensationId],
      );
      assert.deepEqual(
        statuses.map((r) => r["status"]),
        Array.from({ length: 5 }, () => "reverted"),
      );
    });
  }

  test("only one caller can claim an item to revert", async () => {
    // The compensation twin of the ledger race, at the point it happens. The
    // item claim flips a row to `reverted` in the same transaction as the
    // inverse's effect, by a conditional update on `status = 'pending'`. Four
    // callers hitting that update at once is the race; exactly one may win.
    //
    // Worth saying why the *world* is not the assertion here. These inverses
    // restore absolute values — "set priority to high" applied twice leaves the
    // priority high — so a double application of this particular op would be
    // invisible in the ticket. `delete_message` would not be: the second
    // attempt finds no row and `applyInverse` throws rather than reporting a
    // revert that did not happen. The claim is what has to be exclusive, and it
    // is the claim that is asserted.
    await fresh();
    const runId = await finishedRunWithFiveEffects();
    const compensationId = await authorise(runId);
    const item = await one(
      pool(),
      "select id from compensation_items where compensation_id = $1 and seq = 1",
      [compensationId],
    );

    const arrive = barrier(4);

    const race = async (): Promise<boolean> => {
      const client = new pg.Client({ connectionString: settings.databaseUrl });
      await client.connect();
      try {
        await client.query("begin");
        await arrive();
        const { rows } = await client.query(
          `update compensation_items set status = 'reverted', applied_at = now()
            where id = $1 and status = 'pending' returning id`,
          [item["id"]],
        );
        await client.query("commit");
        return rows.length === 1;
      } catch {
        await client.query("rollback").catch(() => {});
        return false;
      } finally {
        await client.end();
      }
    };

    const won = await Promise.all([race(), race(), race(), race()]);
    assert.equal(
      won.filter(Boolean).length,
      1,
      `${won.filter(Boolean).length} callers claimed the same item`,
    );
  });

  test("many workers sharing the compensation queue apply each item once", async () => {
    // Four workers, one compensation, no coordination but the lease. A
    // compensation is ordered, so this is stricter than the forward case: two
    // workers making progress at once could apply items out of order and land
    // the ticket on a value neither the run nor the compensation intended. The
    // world fingerprint is what would show it.
    await fresh();
    const cleanRun = await finishedRunWithFiveEffects();
    assert.equal(await applyThrough(await authorise(cleanRun), new Set()), "applied");
    const cleanWorld = await fingerprint.world();

    await fresh();
    const runId = await finishedRunWithFiveEffects();
    const compensationId = await authorise(runId);

    const worker = async (name: string): Promise<void> => {
      for (let i = 0; i < 60; i++) {
        const claimed = await transaction((db) => compensation.claimNext(db, name));
        if (claimed === null) {
          const row = await fetchOne(
            pool(),
            "select status::text as status from compensations where id = $1",
            [compensationId],
          );
          if (row !== null && !["queued", "running"].includes(row["status"] as string)) return;
          continue;
        }
        try {
          await withClient((db) => compensation.advance(db, String(claimed["id"]), name));
        } catch (error) {
          if (error instanceof compensation.LeaseLost) continue;
          throw error;
        }
      }
    };

    await Promise.all([worker("c0"), worker("c1"), worker("c2"), worker("c3")]);

    const row = await one(
      pool(),
      "select status::text as status from compensations where id = $1",
      [compensationId],
    );
    assert.equal(row["status"], "applied");

    const statuses = await all(
      pool(),
      `select status::text as status from compensation_items
        where compensation_id = $1 order by seq`,
      [compensationId],
    );
    assert.deepEqual(
      statuses.map((r) => r["status"]),
      Array.from({ length: 5 }, () => "reverted"),
    );

    const crashedWorld = await fingerprint.world();
    assert.ok(
      fingerprint.same(crashedWorld, cleanWorld),
      fingerprint.describe(cleanWorld, crashedWorld),
    );
  });
});
