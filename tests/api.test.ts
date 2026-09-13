/**
 * The HTTP API.
 *
 * Driven over a real listening socket rather than through an injection helper,
 * because two of the things worth asserting — the security headers on every
 * response, and the SSE stream — are properties of what actually goes down the
 * wire.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/app.ts";
import { settings } from "../src/config.ts";
import { ScriptedProvider, call, text, type ContentBlock } from "../src/providers.ts";
import { authLimiter, runLimiter } from "../src/ratelimit.ts";
import {
  all,
  closeAfter,
  drive,
  fresh,
  one,
  pool,
  startRun,
  transaction,
  userId,
  withClient,
} from "./helpers.ts";
import * as compensationRuntime from "../src/runtime/compensation.ts";

closeAfter();

let app: FastifyInstance;
let base: string;

before(async () => {
  await fresh();
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
  await fresh();
  authLimiter.reset();
  runLimiter.reset();
});

// ------------------------------------------------------------------ helpers

interface Response<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

async function request<T = any>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Response<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  const text = await response.text();
  let body: any = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, headers: response.headers, body };
}

async function login(email: string, password = "demo-password-123"): Promise<string> {
  const response = await request("POST", "/auth/login", { body: { email, password } });
  assert.equal(response.status, 200, `login failed for ${email}: ${JSON.stringify(response.body)}`);
  return response.body.token as string;
}

const owner = () => login("owner@northwind.test");
const viewer = () => login("viewer@northwind.test");
const lumen = () => login("owner@lumen.test");

/** Drive a run to the approval gate and return its id. */
async function runToGate(reference = "NW-1"): Promise<string> {
  const runId = await startRun(reference);
  const script: ContentBlock[][] = [
    [
      call("issue_refund", {
        order_reference: "NW-1042",
        amount_cents: 1900,
        reason: "Stale beans.",
      }),
    ],
    text("Refunded."),
  ];
  assert.equal(await drive(runId, new ScriptedProvider(script)), "awaiting_approval");
  return runId;
}

/** A finished run that changed one reversible thing. */
async function finishedReversibleRun(): Promise<string> {
  const runId = await startRun("NW-2");
  const status = await drive(
    runId,
    new ScriptedProvider([
      [call("set_priority", { reference: "NW-2", priority: "high" })],
      text("Raised it."),
    ]),
  );
  assert.equal(status, "succeeded");
  return runId;
}

// --------------------------------------------------------------------- auth

describe("auth", () => {
  test("healthz says which provider is in use", async () => {
    const response = await request("GET", "/healthz");
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.provider, settings.hasModelKey ? "claude" : "mock");
  });

  test("login returns a token and the caller's permissions", async () => {
    const response = await request("POST", "/auth/login", {
      body: { email: "owner@northwind.test", password: "demo-password-123" },
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.token.length > 20);
    assert.equal(response.body.user.email, "owner@northwind.test");
    assert.equal(response.body.user.can_approve, true);
    assert.equal(response.body.user.org_slug, "northwind");
  });

  test("the token is not what is stored", async () => {
    const token = await owner();
    const rows = await all(pool(), "select token_hash from sessions");
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r["token_hash"] !== token));
  });

  test("a wrong password is rejected", async () => {
    const response = await request("POST", "/auth/login", {
      body: { email: "owner@northwind.test", password: "nope" },
    });
    assert.equal(response.status, 401);
  });

  test("an unknown account and a wrong password look identical", async () => {
    const unknown = await request("POST", "/auth/login", {
      body: { email: "nobody@nowhere.test", password: "nope" },
    });
    const wrong = await request("POST", "/auth/login", {
      body: { email: "owner@northwind.test", password: "nope" },
    });
    assert.equal(unknown.status, wrong.status);
    assert.deepEqual(unknown.body, wrong.body);
  });

  test("login is rate limited", async () => {
    let sawThrottle = false;
    for (let i = 0; i < 15; i++) {
      const response = await request("POST", "/auth/login", {
        body: { email: "owner@northwind.test", password: "nope" },
      });
      if (response.status === 429) {
        sawThrottle = true;
        break;
      }
    }
    assert.ok(sawThrottle, "an unthrottled login endpoint against bcrypt is a DoS target");
  });

  test("endpoints require a session", async () => {
    for (const path of ["/me", "/tickets", "/runs", "/approvals", "/usage", "/tools"]) {
      const response = await request("GET", path);
      assert.equal(response.status, 401, `${path} did not require a session`);
    }
  });

  test("logout invalidates the token", async () => {
    const token = await owner();
    assert.equal((await request("GET", "/me", { token })).status, 200);
    assert.equal((await request("POST", "/auth/logout", { token })).status, 204);
    assert.equal((await request("GET", "/me", { token })).status, 401);
  });
});

// ------------------------------------------------------------------ tenancy

describe("tenancy", () => {
  test("a merchant sees only its own tickets", async () => {
    const nw = await request("GET", "/tickets", { token: await owner() });
    const lu = await request("GET", "/tickets", { token: await lumen() });

    const nwRefs = nw.body.map((t: any) => t.reference);
    const luRefs = lu.body.map((t: any) => t.reference);
    assert.ok(nwRefs.every((r: string) => r.startsWith("NW-")));
    assert.ok(luRefs.every((r: string) => r.startsWith("LU-")));
    assert.equal(nwRefs.filter((r: string) => luRefs.includes(r)).length, 0);
  });

  test("another merchant's ticket is not found rather than forbidden", async () => {
    const response = await request("GET", "/tickets/LU-1", { token: await owner() });
    assert.equal(response.status, 404);
  });

  test("another merchant's run is not reachable", async () => {
    const runId = await finishedReversibleRun();
    assert.equal((await request("GET", `/runs/${runId}`, { token: await lumen() })).status, 404);
  });

  test("another merchant's run cannot be replayed", async () => {
    const runId = await finishedReversibleRun();
    const response = await request("GET", `/runs/${runId}/replay`, { token: await lumen() });
    assert.equal(response.status, 404);
  });
});

// --------------------------------------------------------------------- runs

describe("runs", () => {
  test("starting a run queues it against the ticket", async () => {
    const response = await request("POST", "/runs", {
      token: await owner(),
      body: { ticket_reference: "NW-1" },
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.status, "queued");
    assert.equal(response.body.ticket_reference, "NW-1");
    assert.equal(response.body.cost_micros, 0);
  });

  test("only one run at a time per ticket", async () => {
    const token = await owner();
    assert.equal(
      (await request("POST", "/runs", { token, body: { ticket_reference: "NW-1" } })).status,
      201,
    );
    const second = await request("POST", "/runs", {
      token,
      body: { ticket_reference: "NW-1" },
    });
    // Two agents working the same ticket would race on the same order and could
    // both propose a refund for it.
    assert.equal(second.status, 409);
  });

  test("a run detail carries its trajectory and its bounds", async () => {
    const runId = await finishedReversibleRun();
    const response = await request("GET", `/runs/${runId}`, { token: await owner() });
    assert.equal(response.status, 200);
    assert.ok(response.body.steps.length > 0);
    assert.equal(response.body.max_steps, settings.maxStepsPerRun);
    assert.equal(response.body.max_spend_micros, settings.maxSpendMicrosPerRun);
    assert.ok(response.body.prompt.includes("NW-2"));
    assert.ok(response.body.deadline_at);
  });

  test("cancelling a run closes its pending approvals", async () => {
    const runId = await runToGate();
    const token = await owner();

    const cancelled = await request("POST", `/runs/${runId}/cancel`, { token });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");

    const pending = await all(
      pool(),
      "select status::text from approvals where run_id = $1",
      [runId],
    );
    assert.ok(pending.every((a) => a["status"] !== "pending"));

    // A second cancel is a conflict, not a silent success.
    assert.equal((await request("POST", `/runs/${runId}/cancel`, { token })).status, 409);
  });

  test("an id that cannot be an id is a 404, not a 500", async () => {
    const token = await owner();
    for (const path of ["/runs/not-a-uuid", "/runs/not-a-uuid/replay", "/compensations/xyz"]) {
      const response = await request("GET", path, { token });
      assert.equal(response.status, 404, `${path} returned ${response.status}`);
    }
  });

  test("a negative limit is rejected rather than reaching Postgres", async () => {
    const response = await request("GET", "/runs?limit=-1", { token: await owner() });
    assert.equal(response.status, 400);
  });

  test("starting runs is throttled per merchant", async () => {
    const token = await owner();
    const references = ["NW-1", "NW-2", "NW-3", "NW-4"];
    let sawThrottle = false;
    for (let i = 0; i < 40; i++) {
      const response = await request("POST", "/runs", {
        token,
        body: { ticket_reference: references[i % references.length] },
      });
      if (response.status === 429) {
        sawThrottle = true;
        break;
      }
    }
    assert.ok(sawThrottle);
  });

  test("a finished run is reachable from its ticket", async () => {
    // `open_run_id` names only a run that can still act. A finished run has to
    // be reachable too, or everything it leads to — the replay, the cost, the
    // compensation plan — sits behind a screen you can only reach by not
    // leaving it.
    const runId = await finishedReversibleRun();
    const response = await request("GET", "/tickets/NW-2", { token: await owner() });
    assert.equal(response.status, 200);
    assert.equal(response.body.open_run_id, null);
    assert.ok(response.body.runs.some((r: any) => r.id === runId));
  });

  test("the conversation before a step is readable back", async () => {
    const runId = await finishedReversibleRun();
    const response = await request("GET", `/runs/${runId}/replay?at=2`, {
      token: await owner(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.before_seq, 2);
    assert.ok(response.body.system.includes("<<<untrusted:"));
    assert.ok(Array.isArray(response.body.messages));
    assert.equal(response.body.messages[0].role, "user");
  });
});

// ---------------------------------------------------------------- approvals

describe("approvals", () => {
  test("the approval queue shows what will actually happen", async () => {
    await runToGate();
    const response = await request("GET", "/approvals", { token: await owner() });
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 1);
    assert.equal(response.body[0].tool_name, "issue_refund");
    assert.ok(response.body[0].preview.includes("19.00"));
    assert.equal(response.body[0].ticket_reference, "NW-1");
  });

  test("an approval carries every argument it is bound to", async () => {
    await runToGate();
    const response = await request("GET", "/approvals", { token: await owner() });
    const args = response.body[0].args;
    assert.equal(args.order_reference, "NW-1042");
    assert.equal(args.amount_cents, 1900);
    assert.ok(args.reason);
  });

  test("a viewer can watch a run but not approve one", async () => {
    const runId = await runToGate();
    const token = await viewer();

    // Watching is allowed.
    assert.equal((await request("GET", `/runs/${runId}`, { token })).status, 200);
    const queue = await request("GET", "/approvals", { token });
    assert.equal(queue.status, 200);
    assert.equal(queue.body.length, 1);

    // Authorising is not.
    const decided = await request("POST", `/approvals/${queue.body[0].id}/decide`, {
      token,
      body: { decision: "approved" },
    });
    assert.equal(decided.status, 403);
    assert.ok(String(decided.body.detail).includes("viewer"));
  });

  test("approving through the API records who decided", async () => {
    const runId = await runToGate();
    const token = await owner();
    const queue = await request("GET", "/approvals", { token });

    const decided = await request("POST", `/approvals/${queue.body[0].id}/decide`, {
      token,
      body: { decision: "approved" },
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.status, "approved");

    const row = await one(pool(), "select decided_by from approvals where run_id = $1", [runId]);
    assert.equal(String(row["decided_by"]), await userId("owner@northwind.test"));
  });

  test("the same approval cannot be decided twice", async () => {
    await runToGate();
    const token = await owner();
    const queue = await request("GET", "/approvals", { token });
    const id = queue.body[0].id;

    assert.equal(
      (await request("POST", `/approvals/${id}/decide`, { token, body: { decision: "approved" } }))
        .status,
      200,
    );
    const again = await request("POST", `/approvals/${id}/decide`, {
      token,
      body: { decision: "denied" },
    });
    assert.equal(again.status, 409);
  });

  test("a decision must be approved or denied", async () => {
    await runToGate();
    const token = await owner();
    const queue = await request("GET", "/approvals", { token });
    const response = await request("POST", `/approvals/${queue.body[0].id}/decide`, {
      token,
      body: { decision: "maybe" },
    });
    assert.equal(response.status, 400);
  });
});

// -------------------------------------------------------------------- usage

describe("usage", () => {
  test("it reports both ceilings", async () => {
    const response = await request("GET", "/usage", { token: await owner() });
    assert.equal(response.status, 200);
    assert.equal(response.body.org_daily_budget_micros, settings.dailyBudgetMicrosPerOrg);
    assert.equal(
      response.body.platform_daily_budget_micros,
      settings.platformDailyBudgetMicros,
    );
    // A figure with no ceiling beside it reads as reporting; the two together
    // read as a budget, which is what it is.
    assert.equal(
      response.body.refund_budget_today_cents,
      settings.dailyRefundCentsPerOrg,
    );
    assert.ok(response.body.refunds_today_display.startsWith("$"));
  });
});

// ------------------------------------------------------------------- tools

describe("the registry endpoint", () => {
  test("the registry is exposed so the UI need not restate it", async () => {
    const response = await request("GET", "/tools", { token: await owner() });
    assert.equal(response.status, 200);
    const byName = new Map(response.body.map((t: any) => [t.name, t.risk]));
    assert.equal(byName.get("issue_refund"), "irreversible");
    assert.equal(byName.get("get_ticket"), "read");
    assert.equal(byName.get("set_priority"), "reversible");
  });
});

// ---------------------------------------------------------------- headers

describe("security headers", () => {
  test("every response carries them", async () => {
    const token = await owner();
    const responses = [
      await request("GET", "/healthz"),
      await request("GET", "/tickets", { token }),
      await request("GET", "/runs/not-a-uuid", { token }),
      await request("GET", "/me"),
    ];
    for (const response of responses) {
      assert.ok(response.headers.get("content-security-policy"));
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    }
  });

  test("the policy permits no inline or third-party script", async () => {
    const policy = (await request("GET", "/healthz")).headers.get("content-security-policy")!;
    assert.ok(policy.includes("script-src 'self'"));
    assert.ok(!policy.includes("script-src 'self' 'unsafe-inline'"));
    assert.ok(!policy.includes("unsafe-eval"));
    assert.ok(policy.includes("frame-ancestors 'none'"));
    assert.ok(policy.includes("object-src 'none'"));
  });
});

// -------------------------------------------------------------------- stream

describe("the stream", () => {
  test("it replays the trajectory and closes", async () => {
    const runId = await finishedReversibleRun();
    const token = await owner();

    const response = await fetch(`${base}/runs/${runId}/stream`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")!.includes("text/event-stream"));

    const body = await response.text();
    const events = body
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => {
        const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? "";
        const data = /^data: (.+)$/m.exec(chunk)?.[1] ?? "{}";
        return { event, data: JSON.parse(data) };
      });

    assert.ok(events.some((e) => e.event === "step"));
    assert.equal(events.at(-1)!.event, "done");
    assert.equal(events.at(-1)!.data.status, "succeeded");
  });

  test("every streamed summary carries the ticket reference", async () => {
    // The client merges each status event into the run it is displaying, so a
    // summary with a null reference would blank the header the moment the run
    // changed state.
    const runId = await finishedReversibleRun();
    const response = await fetch(`${base}/runs/${runId}/stream`, {
      headers: { authorization: `Bearer ${await owner()}` },
    });
    const body = await response.text();
    const summaries = body
      .split("\n\n")
      .filter((chunk) => /^event: (status|done)$/m.test(chunk))
      .map((chunk) => JSON.parse(/^data: (.+)$/m.exec(chunk)![1]!));

    assert.ok(summaries.length > 0);
    for (const summary of summaries) {
      assert.equal(summary.ticket_reference, "NW-2");
    }
  });
});

// -------------------------------------------------------------- compensation

describe("compensation", () => {
  async function planFor(runId: string, token: string) {
    return request("GET", `/runs/${runId}/compensation/plan`, { token });
  }

  test("the plan is readable by a viewer and actionable only by an approver", async () => {
    const runId = await finishedReversibleRun();

    // Seeing what a system did and what it could take back is not a privileged
    // action; doing it is.
    const seen = await planFor(runId, await viewer());
    assert.equal(seen.status, 200);
    assert.equal(seen.body.compensable, true);
    assert.equal(seen.body.revertable, 1);

    const refused = await request("POST", `/runs/${runId}/compensation`, {
      token: await viewer(),
      body: { plan_hash: seen.body.plan_hash, reason: "please" },
    });
    assert.equal(refused.status, 403);
  });

  test("a compensation request must carry the plan it was shown", async () => {
    const runId = await finishedReversibleRun();
    const response = await request("POST", `/runs/${runId}/compensation`, {
      token: await owner(),
      body: { plan_hash: "0".repeat(64), reason: "stale" },
    });
    assert.equal(response.status, 409);
    assert.ok(String(response.body.detail).includes("changed since it was shown"));
  });

  test("a compensation runs and reports what it did", async () => {
    const runId = await finishedReversibleRun();
    const token = await owner();
    assert.equal((await one(pool(), "select priority::text from tickets where reference='NW-2'"))["priority"], "high");

    const plan = await planFor(runId, token);
    const created = await request("POST", `/runs/${runId}/compensation`, {
      token,
      body: { plan_hash: plan.body.plan_hash, reason: "triaged wrong" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "queued");

    // The worker is what applies it.
    await transaction((db) =>
      db.query(
        `update compensations set status = 'running', lease_owner = 'test',
           lease_expires_at = now() + interval '60 seconds', attempt = 1 where id = $1`,
        [created.body.id],
      ),
    );
    const status = await withClient((db) =>
      compensationRuntime.advance(db, created.body.id, "test"),
    );
    assert.equal(status, "applied");

    const read = await request("GET", `/compensations/${created.body.id}`, { token });
    assert.equal(read.status, 200);
    assert.equal(read.body.status, "applied");
    assert.equal(read.body.requested_by_email, "owner@northwind.test");
    assert.ok(read.body.items.every((i: any) => i.status === "reverted"));

    assert.equal(
      (await one(pool(), "select priority::text from tickets where reference='NW-2'"))["priority"],
      "normal",
    );
  });

  test("a live run is not compensable", async () => {
    const runId = await runToGate();
    const plan = await planFor(runId, await owner());
    assert.equal(plan.status, 200);
    assert.equal(plan.body.compensable, false);
    assert.ok(String(plan.body.blocked_reason).includes("cancel it first"));
  });

  test("another merchant cannot see or compensate this run", async () => {
    const runId = await finishedReversibleRun();
    const token = await lumen();
    assert.equal((await planFor(runId, token)).status, 404);
    assert.equal(
      (
        await request("POST", `/runs/${runId}/compensation`, {
          token,
          body: { plan_hash: "x".repeat(64), reason: "not mine" },
        })
      ).status,
      404,
    );
  });

  test("the screen stops offering a walk-back once nothing is left", async () => {
    const runId = await finishedReversibleRun();
    const token = await owner();
    const plan = await planFor(runId, token);
    const created = await request("POST", `/runs/${runId}/compensation`, {
      token,
      body: { plan_hash: plan.body.plan_hash, reason: "done" },
    });
    await transaction((db) =>
      db.query(
        `update compensations set status = 'running', lease_owner = 'test',
           lease_expires_at = now() + interval '60 seconds', attempt = 1 where id = $1`,
        [created.body.id],
      ),
    );
    await withClient((db) => compensationRuntime.advance(db, created.body.id, "test"));

    const after = await planFor(runId, token);
    assert.equal(after.body.compensable, false);
    assert.equal(after.body.items.length, 0);
  });

  test("a run whose only mark was a refund is read but not offered", async () => {
    const runId = await runToGate();
    const token = await owner();

    const queue = await request("GET", "/approvals", { token });
    await request("POST", `/approvals/${queue.body[0].id}/decide`, {
      token,
      body: { decision: "approved" },
    });
    assert.equal(
      await drive(
        runId,
        new ScriptedProvider([
          [
            call("issue_refund", {
              order_reference: "NW-1042",
              amount_cents: 1900,
              reason: "Stale beans.",
            }),
          ],
          text("Refunded."),
        ]),
      ),
      "succeeded",
    );

    const plan = await planFor(runId, token);
    // The refund is listed, because "what could not be taken back" is the thing
    // worth reading. There is just nothing to press.
    assert.equal(plan.body.items.length, 1);
    assert.equal(plan.body.items[0].disposition, "report");
    assert.equal(plan.body.unrevertable, 1);
    assert.equal(plan.body.compensable, false);
    assert.ok(String(plan.body.blocked_reason).includes("stay on the record"));
  });
});
