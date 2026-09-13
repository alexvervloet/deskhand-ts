/**
 * Reading a run back, and replaying it against a change.
 *
 * The property that matters most here is a negative one: divergence must never
 * touch the world. It exists to be pointed at runs that already moved real
 * money, and a tool that re-ran them would be worse than useless.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import * as replay from "../src/replay.ts";
import {
  ScriptedProvider,
  call,
  text,
  type ContentBlock,
  type Message,
  type ModelReply,
} from "../src/providers.ts";
import * as approvals from "../src/runtime/approvals.ts";
import * as loop from "../src/runtime/loop.ts";
import * as runs from "../src/runtime/runs.ts";
import * as transcript from "../src/runtime/transcript.ts";
import { SYSTEM_PROMPT } from "../src/runtime/loop.ts";
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
beforeEach(fresh);

const SCRIPT: ContentBlock[][] = [
  [call("get_ticket", { reference: "NW-1" })],
  [call("get_order", { reference: "NW-1042" })],
  [
    call("issue_refund", {
      order_reference: "NW-1042",
      amount_cents: 1900,
      reason: "Stale beans inside the window.",
    }),
  ],
  [call("add_internal_note", { reference: "NW-1", body: "Refunded after approval." })],
  text("Refunded 19.00 against NW-1042."),
];

function provider(): ScriptedProvider {
  return new ScriptedProvider(SCRIPT.map((turn) => [...turn]));
}

/** Records every message list it is handed, then behaves as scripted. */
class Recording extends ScriptedProvider {
  readonly seen: Message[][] = [];

  override async complete(
    system: string,
    messages: Message[],
    tools: unknown[],
  ): Promise<ModelReply> {
    this.seen.push(messages);
    return super.complete(system, messages, tools);
  }
}

async function driveOnce(runId: string, p: ScriptedProvider): Promise<void> {
  await transaction((db) =>
    db.query(
      `update runs set status = 'running', lease_owner = 'test',
         lease_expires_at = now() + interval '60 seconds' where id = $1`,
      [runId],
    ),
  );
  await withClient((db) => loop.advance(db, runId, "test", p));
}

/** A completed run that issued a refund with a human's approval. */
async function finishedRun(): Promise<string> {
  const ticket = await one(pool(), "select id, org_id from tickets where reference = 'NW-1'");
  const runId = await transaction((db) =>
    runs.create(db, { orgId: String(ticket["org_id"]), ticketId: String(ticket["id"]) }),
  );

  await driveOnce(runId, provider());

  const approval = await one(pool(), "select id, org_id from approvals where run_id = $1", [
    runId,
  ]);
  const owner = await one(pool(), "select id from users where role = 'owner' limit 1");
  await transaction((db) =>
    approvals.decide(db, {
      approvalId: String(approval["id"]),
      orgId: String(approval["org_id"]),
      decision: "approved",
      decidedBy: String(owner["id"]),
    }),
  );

  await driveOnce(runId, provider());
  return runId;
}

// ---------------------------------------------------------- reconstruction

describe("reconstruction", () => {
  test("the conversation before a step is reconstructible", async () => {
    const runId = await finishedRun();
    const run = await one(pool(), "select prompt from runs where id = $1", [runId]);

    const [beforeFirst, beforeRefund, whole] = await withClient(async (db) => [
      await transcript.rebuild(db, runId, run["prompt"], { beforeSeq: 1 }),
      await transcript.rebuild(db, runId, run["prompt"], { beforeSeq: 5 }),
      await transcript.rebuild(db, runId, run["prompt"]),
    ]);

    // Before anything ran, the model had only the opening prompt.
    assert.equal(beforeFirst!.length, 1);
    assert.equal(beforeFirst![0]!.role, "user");

    assert.ok(beforeRefund!.length > 1 && beforeRefund!.length < whole!.length);
    // It had read the ticket and the order by then, and nothing further.
    const flat = JSON.stringify(beforeRefund);
    assert.ok(flat.includes("Beans arrived stale"));
    assert.ok(!flat.includes("Refunded 19.00"));
  });

  test("reconstruction is deterministic", async () => {
    // Same rows in, same bytes out — months later, on another machine. That is
    // the whole reason a trajectory is auditable rather than merely logged.
    const runId = await finishedRun();
    const run = await one(pool(), "select prompt from runs where id = $1", [runId]);
    const [first, second] = await withClient(async (db) => [
      await transcript.rebuild(db, runId, run["prompt"]),
      await transcript.rebuild(db, runId, run["prompt"]),
    ]);
    assert.deepEqual(first, second);
  });

  test("a run loads as its decisions", async () => {
    const runId = await finishedRun();
    const [, turns] = await replay.load(runId);
    assert.deepEqual(
      turns.filter((t) => t.calls.length > 0).map((t) => t.calls[0]!.name),
      ["get_ticket", "get_order", "issue_refund", "add_internal_note"],
    );
    // The result that followed each call is attached to it, which is what makes
    // replaying observations without re-running tools possible.
    const refundTurn = turns.find((t) => t.calls[0]?.name === "issue_refund")!;
    assert.ok(refundTurn.results[refundTurn.calls[0]!.toolUseId]!.includes("Refunded 19.00 USD"));
  });
});

// ---------------------------------------------------------------- divergence

describe("divergence", () => {
  test("the same agent does not diverge from itself", async () => {
    const runId = await finishedRun();
    const result = await replay.diverge(runId, provider(), SYSTEM_PROMPT);
    assert.ok(!replay.diverged(result));
    assert.equal(result.matchedTurns, 5);
  });

  test("a different decision is located exactly", async () => {
    const runId = await finishedRun();
    const cautious = new ScriptedProvider([
      [call("get_ticket", { reference: "NW-1" })],
      [call("get_order", { reference: "NW-1042" })],
      [call("set_ticket_status", { reference: "NW-1", status: "escalated" })],
      text("Outside my authority."),
    ]);
    const result = await replay.diverge(runId, cautious, SYSTEM_PROMPT);

    assert.ok(replay.diverged(result));
    assert.equal(result.matchedTurns, 2, "the first two decisions were identical");
    assert.equal(result.original[0]![0], "issue_refund");
    assert.equal(result.replayed[0]![0], "set_ticket_status");
  });

  test("a changed argument is a divergence", async () => {
    // Same tool, different amount. This is the case a diff of tool *names*
    // would miss, and it is the one that costs money.
    const runId = await finishedRun();
    const greedier = new ScriptedProvider([
      [call("get_ticket", { reference: "NW-1" })],
      [call("get_order", { reference: "NW-1042" })],
      [
        call("issue_refund", {
          order_reference: "NW-1042",
          amount_cents: 4800,
          reason: "Stale beans inside the window.",
        }),
      ],
    ]);
    const result = await replay.diverge(runId, greedier, SYSTEM_PROMPT);
    assert.ok(replay.diverged(result));
    assert.ok(result.replayed[0]![1].includes("4800"));
    assert.ok(result.original[0]![1].includes("1900"));
  });

  test("rewording is not a divergence", async () => {
    // Two runs that make the same calls have made the same decisions, however
    // differently they narrate them. A report that fired on prose would be
    // noise.
    const runId = await finishedRun();
    const chattier = new ScriptedProvider([
      [
        { type: "text", text: "Let me start by reading the ticket." },
        call("get_ticket", { reference: "NW-1" }),
      ],
      [
        { type: "text", text: "Now the order." },
        call("get_order", { reference: "NW-1042" }),
      ],
      [
        call("issue_refund", {
          order_reference: "NW-1042",
          amount_cents: 1900,
          reason: "Stale beans inside the window.",
        }),
      ],
      [call("add_internal_note", { reference: "NW-1", body: "A differently worded note." })],
      text("Done, phrased entirely differently."),
    ]);
    const result = await replay.diverge(runId, chattier, SYSTEM_PROMPT);
    // The internal note's *argument* differs, so it diverges there — at step 4,
    // not at either of the reworded turns before it.
    assert.ok(replay.diverged(result));
    assert.equal(result.matchedTurns, 3);
    assert.equal(result.original[0]![0], "add_internal_note");
  });
});

// ------------------------------------------------------------- the safety bit

describe("the safety bit", () => {
  test("divergence never executes a tool", async () => {
    // The property that makes this safe to point at production runs.
    const runId = await finishedRun();
    const beforeRefunds = await all(pool(), "select id from refunds order by id");
    const beforeNotes = await all(pool(), "select id from ticket_messages order by id");
    const beforeSteps = await all(
      pool(),
      "select id from steps where run_id = $1 order by seq",
      [runId],
    );

    await replay.diverge(runId, provider(), SYSTEM_PROMPT);
    await replay.diverge(
      runId,
      new ScriptedProvider([
        [
          call("issue_refund", {
            order_reference: "NW-1042",
            amount_cents: 2900,
            reason: "a refund the original run never made",
          }),
        ],
      ]),
      SYSTEM_PROMPT,
    );

    assert.deepEqual(
      await all(pool(), "select id from refunds order by id"),
      beforeRefunds,
      "a replay moved money",
    );
    assert.deepEqual(await all(pool(), "select id from ticket_messages order by id"), beforeNotes);
    assert.deepEqual(
      await all(pool(), "select id from steps where run_id = $1 order by seq", [runId]),
      beforeSteps,
    );
  });

  test("divergence writes nothing to the run", async () => {
    const runId = await finishedRun();
    const before = await fetchOne(pool(), "select * from runs where id = $1", [runId]);
    await replay.diverge(runId, provider(), SYSTEM_PROMPT);
    const after = await fetchOne(pool(), "select * from runs where id = $1", [runId]);
    assert.deepEqual(before, after);
  });

  test("replayed observations are still fenced", async () => {
    // A replay hands the model recorded tool output. It is the same untrusted
    // text it was the first time, so it arrives inside the same fence.
    const runId = await finishedRun();
    const recording = new Recording(SCRIPT.map((t) => [...t]));
    await replay.diverge(runId, recording, SYSTEM_PROMPT);

    const token = transcript.fenceToken(runId);
    const results = recording.seen
      .flat()
      .filter((m) => Array.isArray(m.content))
      .flatMap((m) => m.content as ContentBlock[])
      .filter((b) => b["type"] === "tool_result");

    assert.ok(results.length > 0);
    assert.ok(results.every((b) => String(b["content"]).startsWith(`<<<untrusted:${token}>>>`)));
  });

  test("a replay sees the failures and denials the original saw", async () => {
    // Divergence must show the replayed model the same history, not a tidied
    // one. A run that hit a failing tool and a human "no" is exactly the run
    // worth testing a prompt change against, and both of those reach the model
    // as tool results — one flagged `is_error`, one carrying the denial text. A
    // version of `diverge` that built its own message list would have neither,
    // so a prompt would be scored against a run that had gone smoothly and
    // never did.
    const ticket = await one(pool(), "select id, org_id from tickets where reference = 'NW-1'");
    const runId = await transaction((db) =>
      runs.create(db, { orgId: String(ticket["org_id"]), ticketId: String(ticket["id"]) }),
    );

    const script: ContentBlock[][] = [
      [call("get_order", { reference: "NO-SUCH-ORDER" })], // fails: no such order
      [
        call("issue_refund", {
          order_reference: "NW-1042",
          amount_cents: 1900,
          reason: "Goodwill.",
        }),
      ], // denied by a human
      text("Understood — I will not refund."),
    ];

    await driveOnce(runId, new ScriptedProvider(script.map((t) => [...t])));

    const approval = await one(pool(), "select id, org_id from approvals where run_id = $1", [
      runId,
    ]);
    const owner = await one(pool(), "select id from users where role = 'owner' limit 1");
    await transaction((db) =>
      approvals.decide(db, {
        approvalId: String(approval["id"]),
        orgId: String(approval["org_id"]),
        decision: "denied",
        decidedBy: String(owner["id"]),
        reason: "Not inside the window.",
      }),
    );
    await driveOnce(runId, new ScriptedProvider(script.map((t) => [...t])));

    const recording = new Recording(script.map((t) => [...t]));
    await replay.diverge(runId, recording, SYSTEM_PROMPT);

    const blocks = recording.seen
      .flat()
      .filter((m) => Array.isArray(m.content))
      .flatMap((m) => m.content as ContentBlock[])
      .filter((b) => b["type"] === "tool_result");
    const flat = JSON.stringify(blocks);

    assert.ok(flat.includes("no order \\\"NO-SUCH-ORDER\\\""), "the replay hid a tool failure");
    assert.ok(flat.includes("Not inside the window."), "the replay hid the human's denial");
    assert.ok(blocks.some((b) => b["is_error"]), "nothing was marked as an error");
  });
});
