/**
 * Structured events for whatever collects your logs.
 *
 * **The step log is the trace.** Every model call and every tool call is
 * already a row in `steps` carrying tokens, cost, latency, arguments, and
 * result, joined to a run that knows who started it and what it was allowed to
 * spend. That is a complete, queryable, permanently retained trace, and it is
 * the same data any external tracing product would hold — except it is in the
 * database the product already depends on, and it is subject to the same
 * backups and the same access control.
 *
 * What the database is bad at is being *watched*. So this module emits one
 * structured line per interesting event, for a log collector to pick up and
 * alert on. It is a companion to the step log, not a second copy of it: the
 * line carries identifiers and numbers, never the content.
 *
 * One consequence of being a log rather than a table, worth stating because it
 * looks like a bug the first time you see it: these lines are emitted inside
 * the transaction that is doing the work, and they are not rolled back with it.
 * A step that crashes after tracing leaves its line behind and its rows do not
 * survive, so a retried attempt traces twice while the audit log records once.
 * That is the right trade — a tracer that waited for a commit would miss
 * exactly the events worth alerting on, which are the ones where the commit
 * never came — but it means these lines describe *attempts*, and `audit_log` is
 * what describes outcomes. Events carry `attempt` where a repeat is expected,
 * so the two can be told apart.
 *
 * The only real engineering requirement here is negative.
 *
 * **Observability must never take the product down.** A tracer that throws
 * turns a successful refund into a failed run, which is a strictly worse
 * outcome than having no tracing at all. So `emit` cannot throw, cannot block,
 * and cannot care whether its arguments are serialisable. That property is
 * asserted in tests/tracing.test.ts rather than assumed.
 */

export type Sink = (line: string) => void;

// Written to stdout by default. A collector selects these lines by their
// `event` key; the tests swap the sink for an array.
let sink: Sink = (line) => process.stdout.write(line + "\n");

export function setSink(next: Sink): Sink {
  const previous = sink;
  sink = next;
  return previous;
}

/**
 * JSON.stringify with the things a caller should not have to think about
 * handled: BigInt, Date, Error, Map, Set, and a cycle. Python got this for free
 * from `default=str`; here it is written out, because the alternative is an
 * event that throws on a value nobody expected to be in it.
 */
function safeStringify(payload: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(payload, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value instanceof Map) return Object.fromEntries(value);
    if (value instanceof Set) return [...value];
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    if (typeof value === "function" || typeof value === "symbol") return String(value);
    return value;
  });
}

/** Emit one structured event. Never throws, under any circumstances. */
export function emit(event: string, fields: Record<string, unknown> = {}): void {
  try {
    sink(safeStringify({ event, ts: new Date().toISOString(), ...fields }));
  } catch {
    // Swallowed on purpose, and not re-logged: a logging failure inside a
    // logging call is exactly where an infinite loop comes from.
  }
}

export function runStarted(
  runId: string,
  f: { orgId: string; ticket: string; provider: string; model: string },
): void {
  emit("run.started", { run_id: runId, org_id: f.orgId, ...pick(f, ["ticket", "provider", "model"]) });
}

export function modelCall(
  runId: string,
  seq: number,
  f: {
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    latencyMs: number;
    stopReason: string;
    toolCalls: number;
  },
): void {
  emit("model.call", {
    run_id: runId,
    seq,
    input_tokens: f.inputTokens,
    output_tokens: f.outputTokens,
    cost_micros: f.costMicros,
    latency_ms: f.latencyMs,
    stop_reason: f.stopReason,
    tool_calls: f.toolCalls,
  });
}

export function toolCall(
  runId: string,
  seq: number,
  f: { tool: string; risk: string; ok: boolean; replayed: boolean; durationMs: number },
): void {
  emit("tool.call", {
    run_id: runId,
    seq,
    tool: f.tool,
    risk: f.risk,
    ok: f.ok,
    // The field worth alerting on. A replayed step means a run was resumed onto
    // work it had already done — healthy, and worth knowing the rate of.
    replayed: f.replayed,
    duration_ms: f.durationMs,
  });
}

export function approvalRequested(runId: string, f: { tool: string; argsHash: string }): void {
  emit("approval.requested", { run_id: runId, tool: f.tool, args_hash: f.argsHash });
}

export function approvalDecided(
  runId: string,
  f: { tool: string; decision: string; decidedBy: string | null; attempt?: number },
): void {
  emit("approval.decided", {
    run_id: runId,
    tool: f.tool,
    decision: f.decision,
    decided_by: f.decidedBy,
    // A run that crashed after acting on a decision retries and traces this
    // again. One human said yes once; the attempt number is what stops a reader
    // — or a counter — from believing they said it twice.
    attempt: f.attempt ?? 1,
  });
}

export function runFinished(
  runId: string,
  f: { status: string; stopReason: string; steps: number; costMicros: number },
): void {
  emit("run.finished", {
    run_id: runId,
    status: f.status,
    stop_reason: f.stopReason,
    steps: f.steps,
    cost_micros: f.costMicros,
  });
}

function pick<T extends object, K extends keyof T>(source: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = source[key];
  return out;
}
