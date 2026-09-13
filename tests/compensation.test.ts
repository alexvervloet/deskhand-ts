/**
 * Walking a finished run back.
 *
 * The five invariants again, pointed backwards. Durability is that an inverse
 * is applied exactly once across a crash; consent is that a person authorised
 * the exact plan that ran; boundedness is that a compensation that keeps
 * failing stops; integrity is that the plan comes from the ledger and nothing
 * else; accountability is that what could not be taken back is on the record
 * rather than quietly absent.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { ScriptedProvider, call, text, type ContentBlock } from "../src/providers.ts";
import * as approvals from "../src/runtime/approvals.ts";
import * as compensation from "../src/runtime/compensation.ts";
import { ToolError, allTools, applyInverse } from "../src/tools/index.ts";
import {
  all,
  closeAfter,
  drive,
  fetchOne,
  fresh,
  one,
  orgId,
  pool,
  startRun,
  ticketId,
  transaction,
  userId,
  withClient,
  type Row,
} from "./helpers.ts";

closeAfter();
beforeEach(fresh);

// ------------------------------------------------------------------ helpers

/** Plan, then authorise that plan. What the two endpoints do. */
async function authorise(runId: string, reason = "wrong ticket"): Promise<string> {
  return transaction(async (db) => {
    const items = await compensation.plan(db, runId);
    return compensation.create(db, {
      orgId: await orgId(),
      runId,
      requestedBy: await userId("owner@northwind.test"),
      reason,
      expectedPlanHash: compensation.planHash(items),
    });
  });
}

/** Claim and advance, the way the worker would. */
async function apply(compensationId: string, worker = "test-worker"): Promise<string> {
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

async function compRow(compensationId: string): Promise<Row> {
  return one(pool(), "select * from compensations where id = $1", [compensationId]);
}

async function itemRows(compensationId: string): Promise<Row[]> {
  return all(
    pool(),
    "select * from compensation_items where compensation_id = $1 order by seq",
    [compensationId],
  );
}

async function ticket(reference: string): Promise<Row> {
  return one(pool(), "select * from tickets where reference = $1", [reference]);
}

async function approvePending(runId: string): Promise<void> {
  const pending = await all(
    pool(),
    "select id, org_id from approvals where run_id = $1 and status = 'pending'",
    [runId],
  );
  const decider = await userId("owner@northwind.test");
  await transaction(async (db) => {
    for (const row of pending) {
      await approvals.decide(db, {
        approvalId: String(row["id"]),
        orgId: String(row["org_id"]),
        decision: "approved",
        decidedBy: decider,
      });
    }
  });
}

/**
 * The trajectory the ordering rule exists for: normal -> high -> urgent, with
 * the inverses "back to normal" and "back to high" recorded in that order.
 */
const RAISE_TWICE: ContentBlock[][] = [
  [call("set_priority", { reference: "NW-2", priority: "high" })],
  [call("set_priority", { reference: "NW-2", priority: "urgent" })],
  text("Raised it twice. Done."),
];

/** A finished run that moved one ticket's priority twice, then stopped. */
async function twoPriorityChanges(): Promise<string> {
  const runId = await startRun("NW-2");
  assert.equal(await drive(runId, new ScriptedProvider(RAISE_TWICE.map((t) => [...t]))), "succeeded");
  return runId;
}

// ---------------------------------------------------- the plan, and its order

describe("the plan, and its order", () => {
  test("it walks backwards and lands on the original value", async () => {
    assert.equal((await ticket("NW-2"))["priority"], "normal");
    const runId = await twoPriorityChanges();
    assert.equal((await ticket("NW-2"))["priority"], "urgent");

    assert.equal(await apply(await authorise(runId)), "applied");

    // Applied forward, the two inverses would land on `high`: a value the
    // ticket genuinely held for one step and was never meant to keep. Each
    // inverse restores what its own call overwrote, so it is only correct once
    // every later call is already gone.
    assert.equal((await ticket("NW-2"))["priority"], "normal");
  });

  test("the plan is ordered newest first", async () => {
    const runId = await twoPriorityChanges();
    const items = await compensation.plan(pool(), runId);

    assert.deepEqual(items.map((i) => i.seq), [1, 2]);
    // Item 1 undoes the later step.
    assert.ok(items[0]!.stepSeq > items[1]!.stepSeq);
    assert.equal(items[0]!.inverse!["priority"], "high");
    assert.equal(items[1]!.inverse!["priority"], "normal");
  });

  test("a read-only run has nothing to compensate", async () => {
    const runId = await startRun("NW-2");
    const provider = new ScriptedProvider([
      [call("get_ticket", { reference: "NW-2" })],
      text("Looked, did nothing."),
    ]);
    assert.equal(await drive(runId, provider), "succeeded");

    assert.deepEqual(await compensation.plan(pool(), runId), []);
    await assert.rejects(
      () =>
        transaction(async (db) =>
          compensation.create(db, {
            orgId: await orgId(),
            runId,
            requestedBy: await userId("owner@northwind.test"),
            reason: "why not",
            expectedPlanHash: compensation.planHash([]),
          }),
        ),
      /changed nothing that can be walked back/,
    );
  });

  test("a call that changed nothing is not in the plan", async () => {
    // A reversible tool records no inverse when it is a no-op, and the plan
    // reads that as "nothing happened here" rather than "unknown".
    const runId = await startRun("NW-2");
    const provider = new ScriptedProvider([
      // NW-2 is already `normal`, so this handler returns early.
      [call("set_priority", { reference: "NW-2", priority: "normal" })],
      text("Nothing to do."),
    ]);
    assert.equal(await drive(runId, provider), "succeeded");

    const recorded = await one(
      pool(),
      "select inverse from tool_invocations where run_id = $1",
      [runId],
    );
    assert.equal(recorded["inverse"], null);
    assert.deepEqual(await compensation.plan(pool(), runId), []);
  });

  test("a plan with nothing left to revert is not offered", async () => {
    // An irreversible act never leaves a plan. It is never marked `reverted`,
    // so it is in every future plan for this run forever. Without this refusal
    // the screen would keep offering to walk the run back, with a count of
    // zero, and every press would write a compensation that changed nothing and
    // finished `partial`.
    const runId = await startRun("NW-1");
    const script: ContentBlock[][] = [
      [
        call("issue_refund", {
          order_reference: "NW-1042",
          amount_cents: 1900,
          reason: "damaged",
        }),
      ],
      text("Refunded."),
    ];
    assert.equal(
      await drive(runId, new ScriptedProvider(script.map((t) => [...t]))),
      "awaiting_approval",
    );
    await approvePending(runId);
    assert.equal(await drive(runId, new ScriptedProvider(script.map((t) => [...t]))), "succeeded");

    const items = await compensation.plan(pool(), runId);
    // The refund is still in the plan, because "what could not be taken back"
    // is the thing worth reading.
    assert.deepEqual(items.map((i) => i.disposition), ["report"]);
    await assert.rejects(
      () =>
        transaction(async (db) =>
          compensation.create(db, {
            orgId: await orgId(),
            runId,
            requestedBy: await userId("owner@northwind.test"),
            reason: "try anyway",
            expectedPlanHash: compensation.planHash(items),
          }),
        ),
      /nothing left that can be reverted/,
    );
  });

  test("a second compensation is not offered once everything revertable is gone", async () => {
    const runId = await twoPriorityChanges();
    assert.equal(await apply(await authorise(runId)), "applied");
    await assert.rejects(
      () =>
        transaction(async (db) =>
          compensation.create(db, {
            orgId: await orgId(),
            runId,
            requestedBy: await userId("owner@northwind.test"),
            reason: "again",
            expectedPlanHash: compensation.planHash([]),
          }),
        ),
      /changed nothing that can be walked back/,
    );
  });
});

// --------------------------------------------------------------- consent

describe("consent", () => {
  test("a plan that changed since it was shown is refused", async () => {
    // The `argsHash` device, one level up. A human authorises a list of items.
    // If the ledger says something different by the time the request lands, the
    // request is refused rather than executed against a plan nobody looked at.
    const runId = await twoPriorityChanges();
    const shown = compensation.planHash(await compensation.plan(pool(), runId));

    // Someone re-queues the run and it does one more reversible thing before
    // the request arrives. The script carries the turns already taken, because
    // a resumed run rebuilds its history from the step log and the provider
    // derives which turn to serve from that history rather than from a counter.
    await transaction((db) =>
      db.query("update runs set status = 'queued', finished_at = null where id = $1", [runId]),
    );
    const resumed = new ScriptedProvider([
      ...RAISE_TWICE.map((t) => [...t]),
      [call("tag_ticket", { reference: "NW-2", tags: ["late-addition"] })],
      text("And one more thing."),
    ]);
    assert.equal(await drive(runId, resumed), "succeeded");

    await assert.rejects(
      () =>
        transaction(async (db) =>
          compensation.create(db, {
            orgId: await orgId(),
            runId,
            requestedBy: await userId("owner@northwind.test"),
            reason: "stale plan",
            expectedPlanHash: shown,
          }),
        ),
      /changed since it was shown/,
    );
  });

  test("a run that can still act is refused", async () => {
    // A compensation against a live run races its worker for the same rows.
    const runId = await twoPriorityChanges();
    const items = await compensation.plan(pool(), runId);
    await transaction((db) =>
      db.query("update runs set status = 'running' where id = $1", [runId]),
    );
    await assert.rejects(
      () =>
        transaction(async (db) =>
          compensation.create(db, {
            orgId: await orgId(),
            runId,
            requestedBy: await userId("owner@northwind.test"),
            reason: "too soon",
            expectedPlanHash: compensation.planHash(items),
          }),
        ),
      /cancel it before compensating/,
    );
  });

  test("another merchant's run is not compensable", async () => {
    const runId = await twoPriorityChanges();
    const items = await compensation.plan(pool(), runId);
    await assert.rejects(
      () =>
        transaction(async (db) =>
          compensation.create(db, {
            orgId: await orgId("lumen"),
            runId,
            requestedBy: await userId("owner@northwind.test"),
            reason: "not mine",
            expectedPlanHash: compensation.planHash(items),
          }),
        ),
      /no such run/,
    );
  });

  test("only one compensation per run is in flight", async () => {
    const runId = await twoPriorityChanges();
    await authorise(runId);
    await assert.rejects(
      () => authorise(runId, "again"),
      (error: unknown) => (error as { code?: string }).code === "23505",
    );
  });
});

// -------------------------------------------------------------- durability

describe("durability", () => {
  test("a crash mid compensation does not revert twice", async () => {
    // The crash-resume story, pointed backwards. A worker dies after applying
    // one inverse. Another claims the compensation, reads the item statuses,
    // and continues from the first that is still pending — never re-applying
    // the one that already landed.
    const runId = await twoPriorityChanges();
    const compensationId = await authorise(runId);

    // Worker A applies exactly one item, then stops renewing its lease. The
    // claim and the inverse go in one transaction, exactly as `advance` does
    // them, so this is the real half-finished state rather than an approximation.
    await transaction((db) =>
      db.query(
        `update compensations set status = 'running', lease_owner = 'worker-a',
                                  lease_expires_at = now() + interval '60 seconds',
                                  attempt = 1
          where id = $1`,
        [compensationId],
      ),
    );

    await transaction(async (db) => {
      const item = await one(
        db,
        "select * from compensation_items where compensation_id = $1 and seq = 1",
        [compensationId],
      );
      const claimed = await fetchOne(
        db,
        `update compensation_items set status = 'reverted', applied_at = now()
          where id = $1 and status = 'pending' returning id`,
        [item["id"]],
      );
      assert.ok(claimed !== null);
      await applyInverse(
        {
          orgId: await orgId(),
          runId,
          stepId: String(item["invocation_id"]),
          ticketId: await ticketId("NW-2"),
          customerId: "00000000-0000-0000-0000-000000000000",
          db,
        },
        item["inverse"] as { op: string },
      );
    });

    assert.equal((await ticket("NW-2"))["priority"], "high");

    await transaction((db) =>
      db.query(
        "update compensations set lease_expires_at = now() - interval '1 second' where id = $1",
        [compensationId],
      ),
    );
    const claimed = await transaction((db) => compensation.claimNext(db, "worker-b"));
    assert.ok(claimed !== null && String(claimed["id"]) === compensationId);

    const status = await withClient((db) =>
      compensation.advance(db, compensationId, "worker-b"),
    );
    assert.equal(status, "applied");

    // If item 1 had been applied a second time the ticket would read `high`,
    // because the inverse restores an absolute value rather than stepping down.
    assert.equal((await ticket("NW-2"))["priority"], "normal");
    assert.deepEqual(
      (await itemRows(compensationId)).map((i) => i["status"]),
      ["reverted", "reverted"],
    );
  });

  test("the database refuses a second revert of the same invocation", async () => {
    // Belt and braces under the runtime's own guarantee. The conditional update
    // already makes a second attempt a no-op. The partial unique index is what
    // turns a leasing bug, or a compensation built from a stale plan, into a
    // constraint violation rather than a ticket that quietly gets un-tagged
    // twice.
    const runId = await twoPriorityChanges();
    const compensationId = await authorise(runId);
    assert.equal(await apply(compensationId), "applied");

    const invocation = await one(
      pool(),
      "select invocation_id from compensation_items where compensation_id = $1 and seq = 1",
      [compensationId],
    );
    await assert.rejects(
      () =>
        transaction((db) =>
          db.query(
            `insert into compensation_items
               (compensation_id, seq, invocation_id, step_seq, tool_name, risk,
                disposition, status)
             values ($1, 99, $2, 1, 'set_priority', 'reversible', 'revert', 'reverted')`,
            [compensationId, invocation["invocation_id"]],
          ),
        ),
      (error: unknown) => (error as { code?: string }).code === "23505",
    );
  });

  test("a second compensation plans around what the first reverted", async () => {
    const runId = await twoPriorityChanges();
    assert.equal(await apply(await authorise(runId)), "applied");
    assert.deepEqual(await compensation.plan(pool(), runId), []);
  });
});

// ------------------------------------------------------------ accountability

describe("accountability", () => {
  test("an irreversible act is reported and never touched", async () => {
    // The honest half. Money that left is gone. The compensation says so, on
    // the record, and finishes `partial` rather than claiming a clean revert.
    const runId = await startRun("NW-1");
    const script: ContentBlock[][] = [
      [
        call("issue_refund", {
          order_reference: "NW-1042",
          amount_cents: 1900,
          reason: "damaged",
        }),
      ],
      [call("set_ticket_status", { reference: "NW-1", status: "resolved" })],
      text("Refunded and closed."),
    ];
    assert.equal(
      await drive(runId, new ScriptedProvider(script.map((t) => [...t]))),
      "awaiting_approval",
    );
    await approvePending(runId);
    assert.equal(await drive(runId, new ScriptedProvider(script.map((t) => [...t]))), "succeeded");

    const refundsBefore = await all(pool(), "select * from refunds where run_id = $1", [runId]);
    assert.equal(refundsBefore.length, 1);

    const compensationId = await authorise(runId, "agent misread the ticket");
    assert.equal(await apply(compensationId), "partial");

    const comp = await compRow(compensationId);
    assert.equal(comp["status"], "partial");
    assert.ok(String(comp["stop_detail"]).includes("could not be taken back"));

    const items = await itemRows(compensationId);
    const byTool = new Map(items.map((i) => [i["tool_name"] as string, i]));
    assert.equal(byTool.get("set_ticket_status")!["status"], "reverted");
    assert.equal(byTool.get("issue_refund")!["status"], "unrevertable");
    assert.equal(byTool.get("issue_refund")!["disposition"], "report");

    // The status went back. The money did not move in either direction.
    assert.equal((await ticket("NW-1"))["status"], "open");
    assert.deepEqual(
      await all(pool(), "select * from refunds where run_id = $1", [runId]),
      refundsBefore,
    );
  });

  test("who asked and why is on the record", async () => {
    const runId = await twoPriorityChanges();
    const compensationId = await authorise(runId, "ticket was triaged wrong");
    assert.equal(await apply(compensationId), "applied");

    const actions = (
      await all(pool(), "select action from audit_log where run_id = $1 order by created_at", [
        runId,
      ])
    ).map((r) => r["action"]);
    assert.ok(actions.includes("compensation.requested"));
    assert.ok(actions.includes("compensation.applied"));

    const requested = await one(
      pool(),
      `select actor_kind, actor_id, detail from audit_log
        where run_id = $1 and action = 'compensation.requested'`,
      [runId],
    );
    assert.equal(requested["actor_kind"], "human");
    assert.equal(String(requested["actor_id"]), await userId("owner@northwind.test"));
    assert.equal(requested["detail"]["reason"], "ticket was triaged wrong");
  });
});

// --------------------------------------------------------------- integrity

describe("integrity", () => {
  test("the plan ignores everything the ticket says", async () => {
    // The plan is a pure function of ledger rows. NW-4's body carries a forged
    // instruction. A run over it produces exactly the plan a run over a clean
    // ticket does, because nothing in a tool result or a ticket body is read on
    // this path at all.
    const hostile = await startRun("NW-4");
    const clean = await startRun("NW-2");
    for (const [runId, reference] of [
      [hostile, "NW-4"],
      [clean, "NW-2"],
    ] as const) {
      const status = await drive(
        runId,
        new ScriptedProvider([
          [call("get_ticket", { reference })],
          [call("set_priority", { reference, priority: "high" })],
          text("Done."),
        ]),
      );
      assert.equal(status, "succeeded");
    }

    const hostilePlan = await compensation.plan(pool(), hostile);
    const cleanPlan = await compensation.plan(pool(), clean);

    const shape = (plan: typeof hostilePlan) =>
      plan.map((i) => [i.seq, i.toolName, i.disposition]);
    assert.deepEqual(shape(hostilePlan), shape(cleanPlan));
    // The `get_ticket` call that read the attack is not in either plan.
    assert.ok(hostilePlan.every((i) => i.toolName === "set_priority"));
  });

  test("no tool can ask for a compensation", () => {
    // Undoing is not a tool, so the model cannot request one. Stated as a test
    // rather than a comment because the registry is the thing that decides what
    // the model may reach, and a future tool named `revert_run` would be a very
    // reasonable-looking mistake.
    const names = allTools().map((t) => t.name);
    assert.ok(
      !names.some((n) => n.includes("revert") || n.includes("undo") || n.includes("compensat")),
    );
  });
});

// ------------------------------------------------------------ failure, bounds

describe("failure and bounds", () => {
  test("a failed inverse blocks and leaves the rest untouched", async () => {
    // A compensation does not walk past a failure. The plan is ordered because
    // items can depend on each other, and nothing here knows which are
    // independent. Continuing would apply an inverse whose precondition — that
    // every later effect is already gone — is no longer true.
    const runId = await twoPriorityChanges();
    const compensationId = await authorise(runId);

    // Make the first inverse impossible: it names a ticket id, and the id it
    // names is about to stop matching anything in this org.
    await transaction((db) =>
      db.query(
        `update compensation_items
            set inverse = jsonb_set(inverse, '{ticket_id}',
                to_jsonb('00000000-0000-0000-0000-000000000000'::text))
          where compensation_id = $1 and seq = 1`,
        [compensationId],
      ),
    );

    assert.equal(await apply(compensationId), "blocked");

    const comp = await compRow(compensationId);
    assert.equal(comp["stop_reason"], compensation.STOP_INVERSE_FAILED);
    assert.ok(String(comp["stop_detail"]).includes("could not revert set_priority"));

    assert.deepEqual(
      (await itemRows(compensationId)).map((i) => i["status"]),
      ["failed", "skipped"],
    );

    // Nothing moved. The second inverse would have set `normal`, and applying
    // it without the first would have skipped a value the ticket really held.
    assert.equal((await ticket("NW-2"))["priority"], "urgent");
  });

  test("an inverse whose row is gone throws rather than lying", async () => {
    // A statement that changes no rows is not a successful undo. Letting it
    // pass would write `reverted` against something that was not reverted, and
    // an audit trail that overstates what it walked back is worse than one that
    // stops and says so.
    await withClient(async (db) => {
      const ctx = {
        orgId: await orgId(),
        runId: "00000000-0000-0000-0000-000000000000",
        stepId: "00000000-0000-0000-0000-000000000000",
        ticketId: await ticketId("NW-2"),
        customerId: "00000000-0000-0000-0000-000000000000",
        db,
      };
      await assert.rejects(
        () =>
          applyInverse(ctx, {
            op: "set_priority",
            ticket_id: "00000000-0000-0000-0000-000000000000",
            priority: "low",
          }),
        ToolError,
      );
    });
  });

  test("an inverse cannot reach into another merchant", async () => {
    const runId = await twoPriorityChanges();
    const compensationId = await authorise(runId);
    await transaction(async (db) =>
      db.query("update compensations set org_id = $1 where id = $2", [
        await orgId("lumen"),
        compensationId,
      ]),
    );

    assert.equal(await apply(compensationId), "blocked");
    assert.equal((await ticket("NW-2"))["priority"], "urgent");
  });

  test("a compensation that keeps failing gives up", async () => {
    // Boundedness. No model calls to cap, so the bound is on attempts.
    const runId = await twoPriorityChanges();
    const compensationId = await authorise(runId);

    await transaction((db) =>
      db.query("update compensations set attempt = max_attempts + 1 where id = $1", [
        compensationId,
      ]),
    );

    assert.equal(await apply(compensationId), "blocked");
    const comp = await compRow(compensationId);
    assert.equal(comp["stop_reason"], compensation.STOP_ATTEMPTS);
    assert.deepEqual(
      (await itemRows(compensationId)).map((i) => i["status"]),
      ["pending", "pending"],
    );
  });

  test("a live worker cannot be stolen from", async () => {
    const runId = await twoPriorityChanges();
    const compensationId = await authorise(runId);
    await transaction((db) =>
      db.query(
        `update compensations set status = 'running', lease_owner = 'worker-a',
                                  lease_expires_at = now() + interval '60 seconds'
          where id = $1`,
        [compensationId],
      ),
    );

    await assert.rejects(
      () => withClient((db) => compensation.advance(db, compensationId, "worker-b")),
      (error: unknown) => error instanceof compensation.LeaseLost,
    );
  });
});
