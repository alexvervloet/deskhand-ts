/**
 * The tracer, and the one property it must have.
 *
 * Observability that can throw turns a successful refund into a failed run,
 * which is strictly worse than having no observability. So most of this file is
 * about what `emit` does when given things it has no business coping with.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as tracing from "../src/tracing.ts";

/** Collect the lines emitted while `fn` runs. */
function captured(fn: () => void): Record<string, any>[] {
  const lines: string[] = [];
  const previous = tracing.setSink((line) => lines.push(line));
  try {
    fn();
  } finally {
    tracing.setSink(previous);
  }
  return lines.map((line) => JSON.parse(line));
}

afterEach(() => {
  // Any test that swapped the sink and threw must not leak it into the next.
  tracing.setSink((line) => process.stdout.write(line + "\n"));
});

describe("emit", () => {
  test("an event is one line of JSON", () => {
    const events = captured(() => tracing.emit("thing.happened", { run_id: "abc", n: 3 }));

    assert.equal(events.length, 1);
    assert.equal(events[0]!["event"], "thing.happened");
    assert.equal(events[0]!["run_id"], "abc");
    assert.equal(events[0]!["n"], 3);
    // Parseable as a timestamp, not just present.
    assert.ok(!Number.isNaN(Date.parse(events[0]!["ts"])));
  });

  test("awkward but common types survive", () => {
    const events = captured(() =>
      tracing.emit("thing.happened", {
        run_id: crypto.randomUUID(),
        cost: 125n,
        at: new Date(),
        tags: new Set(["a", "b"]),
        seen: new Map([["k", 1]]),
        failure: new Error("boom"),
      }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!["cost"], "125");
    assert.deepEqual(events[0]!["tags"], ["a", "b"]);
    assert.deepEqual(events[0]!["seen"], { k: 1 });
    assert.equal(events[0]!["failure"], "Error: boom");
  });

  test("an unserialisable value does not throw", () => {
    // The important one. A tracer is called from inside a transaction that has
    // already moved money; it does not get to have opinions.
    const hostile = {
      toJSON() {
        throw new Error("no JSON for you");
      },
    };
    assert.doesNotThrow(() => tracing.emit("thing.happened", { value: hostile }));
  });

  test("a broken sink does not throw", () => {
    const previous = tracing.setSink(() => {
      throw new Error("log volume is full");
    });
    try {
      assert.doesNotThrow(() => tracing.emit("thing.happened", { run_id: "abc" }));
    } finally {
      tracing.setSink(previous);
    }
  });

  test("recursion in a value does not throw", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const events = captured(() => tracing.emit("thing.happened", { value: cycle }));
    assert.equal(events.length, 1);
    assert.equal(events[0]!["value"]["self"], "[circular]");
  });
});

describe("the helpers", () => {
  test("they emit the fields worth alerting on", () => {
    const [tool, finished] = captured(() => {
      tracing.toolCall("run-1", 4, {
        tool: "issue_refund",
        risk: "irreversible",
        ok: true,
        replayed: true,
        durationMs: 12,
      });
      tracing.runFinished("run-1", {
        status: "succeeded",
        stopReason: "end_turn",
        steps: 14,
        costMicros: 250,
      });
    });

    assert.equal(tool!["tool"], "issue_refund");
    assert.equal(tool!["risk"], "irreversible");
    // A replayed step means a run was resumed onto work it had already done.
    // Worth knowing the rate of, so it is a first-class field.
    assert.equal(tool!["replayed"], true);
    assert.equal(finished!["stop_reason"], "end_turn");
    assert.equal(finished!["cost_micros"], 250);
  });

  test("events carry no content", () => {
    // Identifiers and numbers only. Ticket bodies and tool results are
    // untrusted customer text and already live in the step log; copying them
    // into a log stream widens where they have to be protected.
    const [event] = captured(() =>
      tracing.toolCall("run-1", 2, {
        tool: "get_ticket",
        risk: "read",
        ok: true,
        replayed: false,
        durationMs: 3,
      }),
    );
    assert.deepEqual(
      Object.keys(event!).sort(),
      [
        "duration_ms",
        "event",
        "ok",
        "replayed",
        "risk",
        "run_id",
        "seq",
        "tool",
        "ts",
      ].sort(),
    );
  });

  test("starting a run is traced", () => {
    // `run.started` is the opening line of a run's story in the log stream. It
    // was defined and never called for a while in the original, which is the
    // quiet way an event stream develops a hole: nothing fails, and the runs
    // simply appear in the log already in progress.
    const [event] = captured(() =>
      tracing.runStarted("run-1", {
        orgId: "org-1",
        ticket: "NW-1",
        provider: "mock",
        model: "mock",
      }),
    );
    assert.equal(event!["event"], "run.started");
    assert.equal(event!["ticket"], "NW-1");
    assert.equal(event!["org_id"], "org-1");
  });

  test("an approval trace says which attempt it belongs to", () => {
    // A run that crashes after acting on a decision traces it again. The rows
    // do not duplicate — the transaction takes them with it — but the log line
    // is already gone to stdout. The attempt number is what lets a reader tell
    // one decision retraced from two decisions made.
    const [event] = captured(() =>
      tracing.approvalDecided("run-1", {
        tool: "issue_refund",
        decision: "approved",
        decidedBy: "u1",
        attempt: 2,
      }),
    );
    assert.equal(event!["attempt"], 2);
  });
});
