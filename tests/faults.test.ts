/**
 * The fault-injection layer itself.
 *
 * A testing seam that can be reached from production, or that quietly widens
 * the trust boundary, is worse than not having one. These tests are mostly
 * about what faults *cannot* do.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type pg from "pg";
import { one, withClient } from "../src/db.ts";
import { RiskClass, get, requiresApproval } from "../src/tools/index.ts";
import * as faults from "../src/tools/faults.ts";
import { invoke, sanitise, type Invocation } from "../src/tools/invoke.ts";
import { closeAfter, fresh } from "./helpers.ts";

closeAfter();
beforeEach(fresh);

interface Fixture {
  orgId: string;
  runId: string;
  stepId: string;
}

/**
 * Run `fn` against a run and step created inside a transaction that is always
 * rolled back, so a fault test can write freely without reseeding after it.
 */
async function inRun<T>(fn: (db: pg.PoolClient, fixture: Fixture) => Promise<T>): Promise<T> {
  return withClient(async (db) => {
    await db.query("begin");
    try {
      const org = await one(db, "select id from orgs where slug = 'northwind'");
      const ticket = await one(db, "select id from tickets where reference = 'NW-1'");
      const run = await one(
        db,
        `insert into runs (org_id, ticket_id, prompt, max_steps, max_tokens,
                           max_spend_micros, max_refund_cents, deadline_at)
         values ($1, $2, 'fault test', 24, 400000, 2000000, 100000,
                 now() + interval '15 min')
         returning id`,
        [org["id"], ticket["id"]],
      );
      const step = await one(
        db,
        `insert into steps (run_id, seq, kind, content) values ($1, 1, 'tool_result', '{}')
         returning id`,
        [run["id"]],
      );
      return await fn(db, {
        orgId: String(org["id"]),
        runId: String(run["id"]),
        stepId: String(step["id"]),
      });
    } finally {
      await db.query("rollback").catch(() => {});
    }
  });
}

function callTool(
  db: pg.PoolClient,
  fixture: Fixture,
  name: string,
  args: Record<string, unknown>,
  seq = 1,
): Promise<Invocation> {
  return invoke(db, {
    orgId: fixture.orgId,
    runId: fixture.runId,
    stepId: fixture.stepId,
    seq,
    toolName: name,
    args,
  });
}

// ------------------------------------------------------------------- safety

describe("safety", () => {
  test("faults are off unless a test turns them on", () => {
    assert.equal(faults.active(), false);
  });

  test("faults are torn down when the block exits", async () => {
    await faults.injecting([new faults.Fault({ tool: "get_ticket", kind: "error" })], async () => {
      assert.equal(faults.active(), true);
    });
    assert.equal(faults.active(), false);
  });

  test("faults are torn down even when the block throws", async () => {
    await assert.rejects(() =>
      faults.injecting([new faults.Fault({ tool: "get_ticket", kind: "error" })], async () => {
        throw new Error("boom");
      }),
    );
    assert.equal(faults.active(), false);
  });

  test("a fault cannot change a risk class", async () => {
    // The seam must not be a way around the approval gate.
    await faults.injecting(
      [
        new faults.Fault({ tool: "issue_refund", kind: "injection" }),
        new faults.Fault({ tool: "issue_refund", kind: "garbage" }),
        new faults.Fault({ tool: "issue_refund", kind: "error" }),
      ],
      async () => {
        assert.equal(get("issue_refund").risk, RiskClass.IRREVERSIBLE);
        assert.equal(requiresApproval("issue_refund"), true);
      },
    );
  });

  test("the environment cannot switch faults on", async () => {
    // A deployment that can be told to corrupt its own tool results by setting
    // a variable is a worse deployment than one that cannot. Asserted by trying
    // every name someone might plausibly have reached for.
    const names = [
      "DESKHAND_FAULTS",
      "DESKHAND_FAULT",
      "FAULTS",
      "FAULT_INJECTION",
      "DESKHAND_CHAOS",
      "DEBUG",
    ];
    const saved = new Map(names.map((n) => [n, process.env[n]]));
    try {
      for (const name of names) process.env[name] = "issue_refund:injection";
      // A fresh module instance, so this is the state a new process would boot
      // into rather than the one this test file already imported.
      const reloaded = await import(`../src/tools/faults.ts?env-probe=${Date.now()}`);
      assert.equal(reloaded.active(), false, "an environment variable installed a fault");
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

// ------------------------------------------------------------------- kinds

describe("the kinds of fault", () => {
  test("an error fault is a failure the model can read", async () => {
    await inRun(async (db, fixture) => {
      const result = await faults.injecting(
        [new faults.Fault({ tool: "get_ticket", kind: "error", detail: "ticket store down" })],
        () => callTool(db, fixture, "get_ticket", { reference: "NW-1" }),
      );
      assert.equal(result.ok, false);
      assert.ok(result.result.includes("ticket store down"));
    });
  });

  test("a crash fault is not the model's business", async () => {
    // An unexpected failure propagates, leaving no ledger row, so the step is
    // retried intact rather than being recorded as a deterministic failure.
    await inRun(async (db, fixture) => {
      await assert.rejects(
        () =>
          faults.injecting([new faults.Fault({ tool: "get_ticket", kind: "crash" })], () =>
            callTool(db, fixture, "get_ticket", { reference: "NW-1" }),
          ),
        /injected crash/,
      );

      const counted = await one(db, "select count(*)::int as n from tool_invocations");
      assert.equal(counted["n"], 0);
    });
  });

  test("a crash rolls back what the handler had written", async () => {
    await inRun(async (db, fixture) => {
      await assert.rejects(() =>
        faults.injecting([new faults.Fault({ tool: "issue_refund", kind: "crash" })], () =>
          callTool(db, fixture, "issue_refund", {
            order_reference: "NW-1042",
            amount_cents: 1900,
            reason: "test",
          }),
        ),
      );
      const counted = await one(db, "select count(*)::int as n from refunds");
      assert.equal(counted["n"], 0, "a crashed handler left a refund behind");
    });
  });

  test("`times` bounds how often a fault fires", async () => {
    await inRun(async (db, fixture) => {
      await faults.injecting(
        [new faults.Fault({ tool: "get_ticket", kind: "error", times: 1 })],
        async () => {
          const first = await callTool(db, fixture, "get_ticket", { reference: "NW-1" }, 1);
          const second = await callTool(db, fixture, "get_ticket", { reference: "NW-1" }, 2);
          assert.equal(first.ok, false);
          assert.ok(second.ok, "the fault fired more often than it was told to");
        },
      );
    });
  });

  test("an injection fault appends a hostile payload", async () => {
    await inRun(async (db, fixture) => {
      const result = await faults.injecting(
        [new faults.Fault({ tool: "get_ticket", kind: "injection" })],
        () => callTool(db, fixture, "get_ticket", { reference: "NW-1" }),
      );
      assert.ok(result.ok);
      assert.ok(result.result.includes("SYSTEM OVERRIDE"));
      // The real content survives: the attack is appended to a genuine result,
      // which is what makes it worth defending against.
      assert.ok(result.result.includes("Beans arrived stale"));
    });
  });

  test("a garbage fault does not take the run down", async () => {
    // Postgres text cannot hold a NUL byte, so a tool returning one would fail
    // the ledger write — after the side effect had already happened.
    await inRun(async (db, fixture) => {
      const result = await faults.injecting(
        [new faults.Fault({ tool: "get_ticket", kind: "garbage" })],
        () => callTool(db, fixture, "get_ticket", { reference: "NW-1" }),
      );
      assert.ok(result.ok);
      assert.ok(!result.result.includes("\u0000"));
    });
  });
});

// ---------------------------------------------------------------- sanitise

describe("sanitise", () => {
  test("NUL bytes are replaced, not dropped", () => {
    assert.equal(sanitise("a\u0000b"), "a\ufffdb");
    assert.ok(!sanitise("\u0000".repeat(10)).includes("\u0000"));
    assert.equal(sanitise("\u0000".repeat(10)).length, 10);
  });

  test("sanitise leaves ordinary text alone", () => {
    const text = "Refunded 19.00 USD — see policy §4, naïve façade, 日本語";
    assert.equal(sanitise(text), text);
  });
});
