/**
 * The tool registry and the exactly-once guarantee.
 *
 * These tests are about properties, not coverage. The three that matter most: a
 * tool's risk class cannot be moved at runtime, an approval is bound to the
 * exact arguments it saw, and invoking the same step twice touches the world
 * once.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, test } from "node:test";
import type pg from "pg";
import { one, withClient } from "../src/db.ts";
import {
  RiskClass,
  ToolError,
  allTools,
  apiSchemas,
  applyInverse,
  argsHash,
  get,
  isRegistered,
  register,
  requiresApproval,
  type ToolContext,
} from "../src/tools/index.ts";
import { idempotencyKey, invoke, type Invocation } from "../src/tools/invoke.ts";
import { closeAfter, fresh } from "./helpers.ts";

closeAfter();
beforeEach(fresh);

/**
 * A transaction that is always rolled back, so these tests can issue real
 * refunds without leaving any behind.
 */
async function inTx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (db) => {
    await db.query("begin");
    try {
      return await fn(db);
    } finally {
      await db.query("rollback").catch(() => {});
    }
  });
}

async function orgOf(db: pg.PoolClient, slug: string): Promise<string> {
  const row = await one(db, "select id from orgs where slug = $1", [slug]);
  return String(row["id"]);
}

/**
 * A minimal run row. The ledger's foreign keys are real, so a tool invocation
 * has to belong to a run and a step that actually exist — which is also how it
 * works in production.
 */
async function newRun(db: pg.PoolClient, org: string, reference?: string): Promise<string> {
  const ticket =
    reference === undefined
      ? await one(db, "select id from tickets where org_id = $1 limit 1", [org])
      : await one(db, "select id from tickets where org_id = $1 and reference = $2", [
          org,
          reference,
        ]);
  const run = await one(
    db,
    `insert into runs (org_id, ticket_id, prompt, max_steps, max_tokens,
                       max_spend_micros, max_refund_cents, deadline_at)
     values ($1, $2, 'tool test', 24, 400000, 2000000, 100000,
             now() + interval '15 minutes')
     returning id`,
    [org, ticket["id"]],
  );
  return String(run["id"]);
}

/**
 * Get or create the step row for `seq`. Re-invoking the same seq is what a
 * resumed run does, so this must not blow up on the second call.
 */
async function stepFor(db: pg.PoolClient, runId: string, seq: number): Promise<string> {
  await db.query(
    `insert into steps (run_id, seq, kind, content) values ($1, $2, 'tool_result', '{}')
     on conflict (run_id, seq) do nothing`,
    [runId, seq],
  );
  const row = await one(db, "select id from steps where run_id = $1 and seq = $2", [runId, seq]);
  return String(row["id"]);
}

async function runTool(
  db: pg.PoolClient,
  org: string,
  name: string,
  args: Record<string, unknown>,
  opts: { seq?: number; runId?: string } = {},
): Promise<Invocation> {
  const seq = opts.seq ?? 1;
  const runId = opts.runId ?? (await newRun(db, org));
  return invoke(db, {
    orgId: org,
    runId,
    stepId: await stepFor(db, runId, seq),
    seq,
    toolName: name,
    args,
  });
}

function contextFor(db: pg.PoolClient, org: string): ToolContext {
  return { orgId: org, runId: "r", stepId: "s", ticketId: "t", customerId: "c", db };
}

// ----------------------------------------------------------------- registry

describe("the registry", () => {
  test("every tool declares a risk class", () => {
    const classes: string[] = Object.values(RiskClass);
    assert.ok(allTools().length > 0);
    for (const tool of allTools()) {
      assert.ok(classes.includes(tool.risk), `${tool.name} has no risk class`);
    }
  });

  test("only irreversible tools require approval", () => {
    const needs = allTools()
      .filter((t) => requiresApproval(t.name))
      .map((t) => t.name)
      .sort();
    const declared = allTools()
      .filter((t) => t.risk === RiskClass.IRREVERSIBLE)
      .map((t) => t.name)
      .sort();
    assert.deepEqual(needs, declared);
    assert.deepEqual(needs, ["cancel_order", "issue_refund", "send_customer_email"]);
  });

  test("a tool's risk class cannot be reassigned", () => {
    // The frozen object is the mechanism, so assert the mechanism. If this ever
    // starts passing, a tool result could talk its way out of the approval gate
    // by mutating the registry.
    const refund = get("issue_refund");
    assert.throws(
      () => {
        // @ts-expect-error the whole point is that this is not allowed
        refund.risk = RiskClass.READ;
      },
      // Frozen objects throw on assignment in modules, which are strict mode.
      TypeError,
    );
    assert.equal(requiresApproval("issue_refund"), true);
  });

  test("unknown tool names are rejected, not guessed", () => {
    assert.throws(() => get("issue_refund_but_bigger"), ToolError);
  });

  test("api schemas are stable and strict", () => {
    const first = apiSchemas();
    const second = apiSchemas();
    // Tools render at the front of the prompt; an unstable order would
    // invalidate the prompt cache on every single call.
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.map((s) => s.name),
      [...first.map((s) => s.name)].sort(),
    );
    for (const s of first) {
      assert.equal(s.strict, true);
      assert.equal(s.input_schema["additionalProperties"], false);
      assert.ok("required" in s.input_schema);
      assert.ok(s.description.trim().length > 0);
    }
  });

  test("an irreversible tool must say what it cannot take back", () => {
    // The registry refuses one that does not. The alternative is a compensation
    // screen falling back to "this tool did something that cannot be undone",
    // which is precisely the sentence a person cannot act on during an
    // incident.
    for (const tool of allTools()) {
      if (tool.risk === RiskClass.IRREVERSIBLE) {
        assert.ok(tool.irreversibleNote, `${tool.name} does not say what it cannot take back`);
      } else {
        assert.equal(tool.irreversibleNote, undefined, `${tool.name} has a note it cannot need`);
      }
    }

    assert.throws(
      () =>
        register({
          name: "burn_it_all",
          risk: RiskClass.IRREVERSIBLE,
          description: "x",
          parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
          handler: async () => ({ result: "done" }),
        }),
      /must say what it cannot take back/,
    );
    assert.equal(isRegistered("burn_it_all"), false, "a refused tool was registered anyway");
  });
});

// --------------------------------------------------------------- args hash

describe("argsHash", () => {
  test("it ignores key order but not values", () => {
    const a = argsHash("issue_refund", { order_reference: "NW-1042", amount_cents: 1900 });
    const b = argsHash("issue_refund", { amount_cents: 1900, order_reference: "NW-1042" });
    assert.equal(a, b);

    const bigger = argsHash("issue_refund", {
      order_reference: "NW-1042",
      amount_cents: 190000,
    });
    assert.notEqual(bigger, a, "approving $19 must not also approve $1,900");
  });

  test("it distinguishes tools", () => {
    assert.notEqual(argsHash("cancel_order", { x: 1 }), argsHash("issue_refund", { x: 1 }));
  });
});

// ------------------------------------------------------------- validation

describe("validation", () => {
  test("unexpected arguments are an error", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const out = await runTool(db, org, "search_kb", { query: "refund", limit: 99 });
      assert.equal(out.ok, false);
      assert.ok(out.result.includes("invalid arguments"));
    });
  });

  test("wrong types are an error", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const out = await runTool(db, org, "issue_refund", {
        order_reference: "NW-1042",
        amount_cents: "nineteen",
        reason: "test",
      });
      assert.equal(out.ok, false);
    });
  });
});

// ------------------------------------------------------------- read tools

describe("read tools", () => {
  test("search_kb finds the policy a ticket needs", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const out = await runTool(db, org, "search_kb", { query: "stale coffee refund window" });
      assert.ok(out.ok);
      assert.ok(out.result.includes("Refund policy"));
    });
  });

  test("search survives words the policy does not use", async () => {
    // Postgres' websearch/plainto tsquery helpers AND every term, so one
    // unmatched word turns a policy lookup into "no such policy" — which an
    // agent reads as permission to proceed without one. Policy lookups must
    // degrade, never fail open.
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const out = await runTool(db, org, "search_kb", {
        query: "refund window for stale beans zzzqqq",
      });
      assert.ok(out.ok);
      assert.ok(out.result.includes("Refund policy"));
    });
  });

  test("a run can read the customer whose ticket it is working", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const runId = await newRun(db, org, "NW-1");
      const out = await runTool(
        db,
        org,
        "get_customer",
        { email: "dana.whitfield@example.com" },
        { runId },
      );
      assert.ok(out.ok);
      assert.ok(out.result.includes("Dana Whitfield"));
    });
  });

  test("a run cannot read a different customer's history", async () => {
    // The pivot the fence cannot stop. A ticket body is untrusted text, and
    // "while you're there, check what happened with omar.reyes@example.com" is
    // a plausible-looking step. Fencing makes the request legible as something
    // a stranger asked for. Refusing it is the tool's job, because org scope
    // alone says yes: both people are customers of the same merchant.
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const runId = await newRun(db, org, "NW-1"); // Dana's ticket
      const out = await runTool(
        db,
        org,
        "get_customer",
        { email: "omar.reyes@example.com" },
        { runId },
      );

      assert.equal(out.ok, false);
      assert.ok(out.result.includes("not the customer on this ticket"));
      assert.ok(!out.result.includes("Omar"), "a refusal must not leak what it refused");
    });
  });

  test("refund history is scoped to this ticket's customer", async () => {
    // `list_refunds` answering for the whole merchant would make every refund
    // it had ever issued readable from any one customer's ticket.
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const otherOrder = await one(db, "select id from orders where reference = 'NW-1077'");
      await db.query(
        `insert into refunds (org_id, order_id, amount_cents, reason)
         values ($1, $2, 500, 'a refund on somebody else''s order')`,
        [org, otherOrder["id"]],
      );

      const runId = await newRun(db, org, "NW-1"); // Dana's ticket
      const out = await runTool(db, org, "list_refunds", { since_days: 30 }, { runId });

      assert.ok(out.ok);
      assert.ok(out.result.includes("No refunds to this customer"));
      assert.ok(!out.result.includes("somebody else"));
    });
  });

  test("read tools cannot reach another merchant", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const out = await runTool(db, org, "get_order", { reference: "LU-2201" });
      assert.equal(out.ok, false);
      assert.ok(out.result.includes("no order"));
    });
  });

  test("get_order reports what is left to refund", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const out = await runTool(db, org, "get_order", { reference: "NW-1042" });
      assert.ok(out.ok);
      assert.ok(out.result.includes("48.00 USD"));
      assert.ok(out.result.includes("No refunds have been issued"));
    });
  });
});

// -------------------------------------------------------- reversible tools

describe("reversible tools", () => {
  test("they record a usable inverse", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const before = await runTool(db, org, "get_ticket", { reference: "NW-2" });
      assert.ok(before.result.includes("priority=normal"));

      const changed = await runTool(db, org, "set_priority", {
        reference: "NW-2",
        priority: "urgent",
      });
      assert.ok(changed.ok);
      assert.ok(changed.inverse !== null, "a reversible tool must record its inverse");
      assert.equal(changed.inverse!["op"], "set_priority");
      assert.equal(changed.inverse!["priority"], "normal");

      const after = await runTool(db, org, "get_ticket", { reference: "NW-2" }, { seq: 2 });
      assert.ok(after.result.includes("priority=urgent"));

      await applyInverse(contextFor(db, org), changed.inverse as { op: string });

      const reverted = await runTool(db, org, "get_ticket", { reference: "NW-2" }, { seq: 3 });
      assert.ok(reverted.result.includes("priority=normal"));
    });
  });

  test("a call that changes nothing records no inverse", async () => {
    // The correspondence the compensation planner depends on. `plan` skips
    // reversible ledger rows with a null inverse, and reads that as "this call
    // changed nothing" rather than "the inverse is missing". Every early return
    // in reversible.ts has to keep meaning that: a handler that ever changes
    // state and forgets its inverse would drop out of every plan silently, and
    // nothing else in the system would notice.
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");

      const already = await runTool(db, org, "set_priority", {
        reference: "NW-2",
        priority: "normal",
      });
      assert.ok(already.ok);
      assert.ok(already.result.includes("already normal"));
      assert.equal(already.inverse, null);

      const tagged = await runTool(
        db,
        org,
        "tag_ticket",
        { reference: "NW-2", tags: ["shipping"] },
        { seq: 2 },
      );
      assert.ok(tagged.inverse !== null);

      const again = await runTool(
        db,
        org,
        "tag_ticket",
        { reference: "NW-2", tags: ["shipping"] },
        { seq: 3 },
      );
      assert.ok(again.ok);
      assert.equal(again.inverse, null);
    });
  });

  test("an inverse will not cross a tenancy boundary", async () => {
    // `applyInverse` scopes every statement to the caller's org. The ids inside
    // an inverse were captured by handlers that already filtered on the org, so
    // they are in-tenant by construction. Scoping again means the guarantee
    // survives a handler that forgets, and means a hand-written row in
    // `tool_invocations.inverse` cannot reach across.
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const lumen = await orgOf(db, "lumen");
      const changed = await runTool(db, org, "set_priority", {
        reference: "NW-2",
        priority: "urgent",
      });
      assert.ok(changed.inverse !== null);

      await assert.rejects(
        () => applyInverse(contextFor(db, lumen), changed.inverse as { op: string }),
        /nothing to undo/,
      );
    });
  });

  test("tagging keeps existing tags", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const first = await runTool(db, org, "tag_ticket", {
        reference: "NW-2",
        tags: ["shipping"],
      });
      assert.ok(first.ok);
      const second = await runTool(
        db,
        org,
        "tag_ticket",
        { reference: "NW-2", tags: ["late"] },
        { seq: 2 },
      );
      assert.ok(second.result.includes("shipping") && second.result.includes("late"));
    });
  });

  test("internal notes are not customer visible", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const out = await runTool(db, org, "add_internal_note", {
        reference: "NW-2",
        body: "Checked the carrier; parcel is in transit.",
      });
      assert.ok(out.ok);

      const written = await one(
        db,
        `select is_internal, author_kind::text as author_kind from ticket_messages
          where body like 'Checked the carrier%'`,
      );
      assert.equal(written["is_internal"], true);
      // Authored as the agent, because that is what wrote it. Filing model prose
      // under 'system' would hand a colleague reading the queue the platform's
      // authority for a sentence the model composed after reading a stranger's
      // ticket.
      assert.equal(written["author_kind"], "agent");
    });
  });
});

// ------------------------------------------------------ irreversible tools

describe("irreversible tools", () => {
  test("a refund cannot exceed what remains", async () => {
    // The approval gate stops the agent acting alone. It does not stop a human
    // approving arithmetic that does not work, so the constraint lives here too.
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const out = await runTool(db, org, "issue_refund", {
        order_reference: "NW-1042",
        amount_cents: 999_999,
        reason: "test",
      });
      assert.equal(out.ok, false);
      assert.ok(out.result.includes("already refunded") || out.result.includes("leaving"));
    });
  });

  test("refunds accumulate against the order", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const first = await runTool(db, org, "issue_refund", {
        order_reference: "NW-1042",
        amount_cents: 1900,
        reason: "one stale bag",
      });
      assert.ok(first.ok);

      const view = await runTool(db, org, "get_order", { reference: "NW-1042" }, { seq: 2 });
      assert.ok(view.result.includes("Already refunded: 19.00 USD"));
      assert.ok(view.result.includes("Refundable remaining: 29.00 USD"));

      const tooMuch = await runTool(
        db,
        org,
        "issue_refund",
        { order_reference: "NW-1042", amount_cents: 3000, reason: "the rest" },
        { seq: 3 },
      );
      assert.equal(tooMuch.ok, false);
    });
  });

  test("a run with no ceiling on its row refunds nothing", async () => {
    // `max_refund_cents` defaults to 0, and 0 is no payout authority. A run row
    // inserted by a code path that has never heard of the column gets a ceiling
    // of zero rather than an assumed one. This is the direction a forgotten
    // field should fail in when the field is a limit on money.
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const runId = await newRun(db, org);
      await db.query("update runs set max_refund_cents = 0 where id = $1", [runId]);

      const out = await runTool(
        db,
        org,
        "issue_refund",
        { order_reference: "NW-1042", amount_cents: 100, reason: "a token amount" },
        { runId },
      );

      assert.equal(out.ok, false);
      assert.ok(out.result.includes("may refund"));
      const counted = await one(db, "select count(*)::int as n from refunds");
      assert.equal(counted["n"], 0);
    });
  });

  test("a shipped order cannot be cancelled", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const out = await runTool(db, org, "cancel_order", {
        order_reference: "NW-1042",
        reason: "customer changed their mind",
      });
      assert.equal(out.ok, false);
      assert.ok(out.result.includes("delivered"));
    });
  });

  test("email lands on the thread as well as the outbox", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const out = await runTool(db, org, "send_customer_email", {
        reference: "NW-2",
        subject: "Your order is on its way",
        body: "Thanks for waiting — NW-1077 shipped and should arrive shortly.",
      });
      assert.ok(out.ok);

      const emails = await one(db, "select count(*)::int as n from customer_emails");
      assert.equal(emails["n"], 1);
      const messages = await one(
        db,
        `select count(*)::int as n from ticket_messages
          where author_kind = 'agent' and is_internal = false`,
      );
      assert.equal(messages["n"], 1);
    });
  });
});

// ------------------------------------------------------------ exactly once

describe("exactly once", () => {
  test("the same step executes once, however often it is replayed", async () => {
    // This is invariant 1. A worker that dies after refunding but before
    // recording progress resumes onto the same step number, and must not pay
    // the customer twice.
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const runId = await newRun(db, org);
      const args = { order_reference: "NW-1042", amount_cents: 1900, reason: "stale beans" };

      const first = await runTool(db, org, "issue_refund", args, { seq: 4, runId });
      assert.ok(first.ok && !first.replayed);

      for (let i = 0; i < 3; i++) {
        const again = await runTool(db, org, "issue_refund", args, { seq: 4, runId });
        assert.ok(again.replayed, "a replayed step must not re-execute");
        assert.equal(again.result, first.result);
      }

      const counted = await one(db, "select count(*)::int as n from refunds");
      assert.equal(counted["n"], 1, "the customer was refunded more than once");
    });
  });

  test("a different step of the same run is a different key", () => {
    const runId = randomUUID();
    assert.notEqual(idempotencyKey(runId, 4), idempotencyKey(runId, 5));
  });

  test("a failed call is remembered as failed", async () => {
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const runId = await newRun(db, org);
      const args = { order_reference: "NOPE-1", amount_cents: 100, reason: "test" };

      const first = await runTool(db, org, "issue_refund", args, { seq: 1, runId });
      assert.ok(!first.ok && !first.replayed);

      const again = await runTool(db, org, "issue_refund", args, { seq: 1, runId });
      assert.ok(again.replayed && !again.ok);
      assert.equal(again.result, first.result);
    });
  });

  test("a failing tool leaves the transaction usable", async () => {
    // Without a savepoint around the handler, one bad statement would poison
    // the transaction we still need in order to record the failure — and the
    // run would die instead of the model getting a chance to recover.
    await inTx(async (db) => {
      const org = await orgOf(db, "northwind");
      const failed = await runTool(db, org, "issue_refund", {
        order_reference: "NW-1042",
        amount_cents: 999_999,
        reason: "too much",
      });
      assert.equal(failed.ok, false);

      const recovered = await runTool(db, org, "get_order", { reference: "NW-1042" }, { seq: 2 });
      assert.ok(recovered.ok, "the transaction should still be usable after a tool failure");
    });
  });
});
