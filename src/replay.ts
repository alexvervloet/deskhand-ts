/**
 * Reading a run back, and asking what a change would have done to it.
 *
 *     npm run replay -- <run_id>              # the trajectory
 *     npm run replay -- <run_id> --at 7       # what the model saw at step 7
 *     npm run replay -- <run_id> --diverge    # replay against the current config
 *
 * Two capabilities, and they answer different questions.
 *
 * **Replay** answers *what happened*. Because `transcript.rebuild` is a pure
 * function of the step rows, the conversation as it stood before any step can
 * be reconstructed exactly, months later, byte for byte. Nothing is executed
 * and nothing is called: this is reading, not running.
 *
 * **Divergence** answers *what would a change have done*. You edit the system
 * prompt, or point at a different model, and replay a recorded run against it:
 * the new model is asked to make each decision again, with the observations the
 * original run actually got, and the first place its choice differs is
 * reported.
 *
 * Divergence never executes a tool. When the replayed model asks for a call,
 * the *recorded* result of that call is handed back instead. That is what makes
 * it safe to run against a run that moved real money — and it is also the
 * source of its one hard limitation, below.
 */

import { readFileSync } from "node:fs";
import { all, closePool, fetchOne, pool, withClient, type Row } from "./db.ts";
import { getProvider, type ContentBlock, type Provider } from "./providers.ts";
import { SYSTEM_PROMPT } from "./runtime/loop.ts";
import * as transcript from "./runtime/transcript.ts";
import { apiSchemas } from "./tools/index.ts";

const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";
const AMBER = "\u001b[33m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const BLUE = "\u001b[34m";

// ------------------------------------------------------------------- loading

/** One tool call a turn asked for. */
export interface RecordedCall {
  toolUseId: string;
  name: string;
  args: Record<string, unknown>;
}

/** What a turn *decided*, in a comparable form: tool name and canonical args. */
export type Signature = [string, string][];

/** One model decision from a persisted run, with what followed it. */
export interface RecordedTurn {
  seq: number;
  blocks: ContentBlock[];
  stopReason: string;
  calls: RecordedCall[];
  /** tool_use_id -> the result that was recorded for it. */
  results: Record<string, string>;
}

/**
 * Deliberately not the prose: two runs that call `issue_refund` for the same
 * amount have made the same decision even if they narrate it differently, and a
 * divergence report that fired on rewording would be useless.
 */
export function signature(calls: RecordedCall[]): Signature {
  return calls.map((c) => [c.name, canonicalJson(c.args)]);
}

function canonicalJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") {
      if (input instanceof Date) return input.toISOString();
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        out[key] = canonical((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}

export async function load(runId: string): Promise<[Row, RecordedTurn[]]> {
  const run = await fetchOne(
    pool(),
    `select r.*, t.reference as ticket_reference from runs r
       join tickets t on t.id = r.ticket_id where r.id = $1`,
    [runId],
  );
  if (run === null) throw new Error(`no run ${runId}`);

  const steps = await all(
    pool(),
    `select seq, kind::text, content, tool_name, cost_micros, latency_ms,
            input_tokens, output_tokens
       from steps where run_id = $1 order by seq`,
    [runId],
  );

  // Results are keyed by tool_use_id so a turn can find what followed it even
  // when several calls were made at once.
  const results: Record<string, string> = {};
  for (const step of steps) {
    if (step["kind"] !== "tool_result") continue;
    const id = step["content"]?.["tool_use_id"];
    if (id) results[id] = step["content"]?.["result"] ?? "";
  }

  const turns: RecordedTurn[] = [];
  for (const step of steps) {
    if (step["kind"] !== "model_call") continue;
    const blocks = (step["content"]?.["blocks"] ?? []) as ContentBlock[];
    const calls: RecordedCall[] = blocks
      .filter((b) => b["type"] === "tool_use")
      .map((b) => ({
        toolUseId: b["id"] as string,
        name: b["name"] as string,
        args: (b["input"] ?? {}) as Record<string, unknown>,
      }));
    turns.push({
      seq: Number(step["seq"]),
      blocks,
      stopReason: step["content"]?.["stop_reason"] ?? "",
      calls,
      results: Object.fromEntries(calls.map((c) => [c.toolUseId, results[c.toolUseId] ?? ""])),
    });
  }
  return [run, turns];
}

// -------------------------------------------------------------------- replay

/** Print the trajectory as it was recorded. */
export async function show(runId: string): Promise<number> {
  const [run] = await load(runId);
  const steps = await all(
    pool(),
    `select seq, kind::text, content, tool_name, cost_micros, latency_ms
       from steps where run_id = $1 order by seq`,
    [runId],
  );

  const out = process.stdout;
  out.write("\n");
  out.write(`${BOLD}run ${runId}${RESET}  ticket ${run["ticket_reference"]}\n`);
  out.write(
    `${DIM}${run["status"]} (${run["stop_reason"]})` +
      ` · ${run["provider"]}/${run["model"]} · attempt ${run["attempt"]}${RESET}\n\n`,
  );

  // Approvals live in their own table, and a *granted* one writes no step — only
  // denials do. So a run that stopped, waited for a person, and was allowed to
  // continue would otherwise replay with no sign that the most consequential
  // thing in it ever happened. They are interleaved by the step they gated.
  const decisions = new Map<number, Row[]>();
  for (const row of await all(
    pool(),
    `select a.step_seq, a.tool_name, a.status::text as status, a.preview,
            a.reason, a.decided_at, u.email as decided_by
       from approvals a left join users u on u.id = a.decided_by
      where a.run_id = $1 order by a.created_at`,
    [runId],
  )) {
    const key = Number(row["step_seq"]);
    decisions.set(key, [...(decisions.get(key) ?? []), row]);
  }

  for (const step of steps) {
    const kind = step["kind"] as string;
    const content = step["content"] as Record<string, any>;
    const head = `  ${String(step["seq"]).padStart(3)}  `;

    for (const decision of decisions.get(Number(step["seq"])) ?? []) {
      const colour =
        decision["status"] === "approved" ? GREEN : decision["status"] === "denied" ? RED : AMBER;
      const who = decision["decided_by"] ?? "nobody";
      out.write(
        `       ${colour}⏸ ${decision["status"]}${RESET} by ${who}` +
          `  ${DIM}${decision["preview"]}${RESET}\n`,
      );
      if (decision["reason"]) out.write(`         ${DIM}reason: ${decision["reason"]}${RESET}\n`);
    }

    if (kind === "model_call") {
      const blocks = (content["blocks"] ?? []) as ContentBlock[];
      const calls = blocks.filter((b) => b["type"] === "tool_use");
      const text = blocks
        .filter((b) => b["type"] === "text")
        .map((b) => (b["text"] as string) ?? "")
        .join(" ")
        .trim();
      out.write(`${head}${DIM}model${RESET}  ${content["stop_reason"] ?? ""}\n`);
      for (const c of calls) {
        out.write(`       ${BLUE}${c["name"]}${RESET}(${renderArgs(c["input"] ?? {})})\n`);
      }
      if (text) out.write(`       ${text.slice(0, 160)}\n`);
    } else if (kind === "tool_result") {
      const ok = content["ok"] ?? true;
      const mark = ok ? `${GREEN}ok${RESET}` : `${RED}failed${RESET}`;
      const replayed = content["replayed"] ? ` ${AMBER}replayed${RESET}` : "";
      out.write(`${head}${content["name"] ?? step["tool_name"]}  ${mark}${replayed}\n`);
      out.write(`       ${DIM}${oneline(content["result"] ?? "")}${RESET}\n`);
    } else if (kind === "approval") {
      const colour = content["decision"] === "approved" ? GREEN : RED;
      out.write(
        `${head}${colour}approval ${content["decision"]}${RESET}` +
          `  ${content["tool_name"]}` +
          (content["reason"] ? ` — ${content["reason"]}` : "") +
          "\n",
      );
    } else if (kind === "final") {
      out.write(`${head}${GREEN}final${RESET}\n`);
      out.write(`       ${oneline(content["summary"] ?? "")}\n`);
    } else {
      out.write(`${head}${kind}  ${oneline(JSON.stringify(content))}\n`);
    }
  }

  out.write(`\n  ${DIM}--at N to see the exact conversation before step N${RESET}\n\n`);
  return 0;
}

/** Print the conversation exactly as it stood before step `seq`. */
export async function at(runId: string, seq: number): Promise<number> {
  const [run] = await load(runId);
  const messages = await withClient((db) =>
    transcript.rebuild(db, runId, run["prompt"], { beforeSeq: seq }),
  );

  const out = process.stdout;
  out.write("\n");
  out.write(`${BOLD}what the model saw before step ${seq} of run ${runId}${RESET}\n`);
  out.write(`${DIM}reconstructed from the step log — no model was called${RESET}\n\n`);
  for (const message of messages) {
    const role = message.role;
    const colour = role === "user" ? AMBER : BLUE;
    out.write(`${colour}── ${role} ${"─".repeat(Math.max(0, 66 - role.length))}${RESET}\n`);
    if (typeof message.content === "string") {
      out.write(message.content + "\n");
    } else {
      for (const block of message.content) {
        const kind = block["type"];
        if (kind === "text") {
          out.write(`${block["text"]}\n`);
        } else if (kind === "thinking") {
          out.write(`${DIM}[thinking]${RESET}\n`);
        } else if (kind === "tool_use") {
          out.write(`${BLUE}${block["name"]}${RESET}(${renderArgs(block["input"] ?? {})})\n`);
        } else if (kind === "tool_result") {
          const flag = block["is_error"] ? ` ${RED}(error)${RESET}` : "";
          out.write(`${DIM}tool_result${RESET}${flag}\n`);
          out.write(`${String(block["content"] ?? "")}\n`);
        }
      }
    }
    out.write("\n");
  }
  return 0;
}

// ---------------------------------------------------------------- divergence

export interface Divergence {
  step: number | null;
  original: Signature;
  replayed: Signature;
  matchedTurns: number;
  totalTurns: number;
  note?: string;
}

export function diverged(result: Divergence): boolean {
  return result.step !== null;
}

/**
 * Replay a recorded run against a changed configuration.
 *
 * The new model is asked to make each decision again, given exactly the
 * observations the original run got, and the first turn where its choice
 * differs is reported.
 *
 * **The limitation, stated plainly:** once the replayed model asks for
 * something the original run never asked for, there is no recorded result to
 * hand back, and the replay stops. Divergence tells you *where* behaviour
 * changed and not what would have happened afterwards — for that you have to
 * let a real run go, with real tools and a real approval gate.
 */
export async function diverge(
  runId: string,
  provider: Provider,
  system: string,
): Promise<Divergence> {
  const [run, turns] = await load(runId);
  if (turns.length === 0) {
    return {
      step: null,
      original: [],
      replayed: [],
      matchedTurns: 0,
      totalTurns: 0,
      note: "the run has no model calls to replay",
    };
  }

  const tools = apiSchemas();

  return withClient(async (db) => {
    for (const [index, turn] of turns.entries()) {
      // The conversation as it stood before this turn, built by the same
      // function the live loop uses. Up to the first divergence the replayed
      // decisions are identical to the recorded ones, so the recorded history
      // *is* the replayed history — which means this can be read back rather
      // than accumulated here.
      //
      // Reusing `rebuild` is the point. A second implementation of "what the
      // model saw" drifts from the first: a copy that dropped `is_error` from
      // tool results and skipped denial steps would mean a prompt tested
      // against a run containing a failure or a human "no" was tested against a
      // run that never had one.
      const messages = await transcript.rebuild(db, runId, run["prompt"], {
        beforeSeq: turn.seq,
      });
      const reply = await provider.complete(system, messages, tools);

      const replayedSignature: Signature = reply.content
        .filter((b) => b["type"] === "tool_use")
        .map((b) => [b["name"] as string, canonicalJson(b["input"] ?? {})]);

      const originalSignature = signature(turn.calls);
      if (JSON.stringify(replayedSignature) !== JSON.stringify(originalSignature)) {
        return {
          step: turn.seq,
          original: originalSignature,
          replayed: replayedSignature,
          matchedTurns: index,
          totalTurns: turns.length,
        };
      }

      if (turn.calls.length === 0) {
        // Both finished here, and agreed on finishing. Prose is not compared:
        // two runs that both stop are not diverging because they worded the
        // summary differently.
        return {
          step: null,
          original: [],
          replayed: [],
          matchedTurns: index + 1,
          totalTurns: turns.length,
        };
      }
    }

    return {
      step: null,
      original: [],
      replayed: [],
      matchedTurns: turns.length,
      totalTurns: turns.length,
    };
  });
}

export function report(runId: string, result: Divergence): number {
  const out = process.stdout;
  out.write("\n");
  if (result.note) {
    out.write(`  ${DIM}${result.note}${RESET}\n\n`);
    return 0;
  }

  if (!diverged(result)) {
    out.write(`  ${GREEN}no divergence${RESET} — all ${result.matchedTurns} decision(s) matched\n`);
    out.write(`  ${DIM}run ${runId}${RESET}\n\n`);
    return 0;
  }

  out.write(`  ${AMBER}diverged at step ${result.step}${RESET}\n`);
  out.write(
    `  ${DIM}${result.matchedTurns} of ${result.totalTurns} decisions matched first${RESET}\n\n`,
  );
  out.write(`  ${DIM}originally:${RESET}\n`);
  for (const [name, args] of result.original.length > 0
    ? result.original
    : ([["(finished)", ""]] as Signature)) {
    out.write(`    ${RED}${name}${RESET}(${short(args)})\n`);
  }
  out.write(`  ${DIM}now:${RESET}\n`);
  for (const [name, args] of result.replayed.length > 0
    ? result.replayed
    : ([["(finished)", ""]] as Signature)) {
    out.write(`    ${GREEN}${name}${RESET}(${short(args)})\n`);
  }
  out.write(
    `\n  ${DIM}the replay stops here: there is no recorded observation for a call${RESET}\n`,
  );
  out.write(`  ${DIM}the original run never made.${RESET}\n\n`);
  return 1;
}

// ------------------------------------------------------------------- helpers

function renderArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${short(JSON.stringify(v) ?? String(v))}`)
    .join(", ");
}

function short(text: string, limit = 60): string {
  const trimmed = text.trim().replace(/^"|"$/g, "");
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit - 1) + "…";
}

function oneline(text: unknown, limit = 120): string {
  const flat = String(text).split(/\s+/).filter(Boolean).join(" ");
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + "…";
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const runId = positional[0];
  if (runId === undefined) {
    process.stderr.write(
      "usage: npm run replay -- <run_id> [--at N] [--diverge] [--system-prompt FILE]\n",
    );
    return 2;
  }

  const flag = (name: string): string | null => {
    const index = argv.indexOf(name);
    if (index === -1) return null;
    return argv[index + 1] ?? null;
  };

  try {
    const atValue = flag("--at");
    if (atValue !== null) return await at(runId, Number(atValue));

    const promptFile = flag("--system-prompt");
    if (argv.includes("--diverge") || promptFile !== null) {
      const system = promptFile !== null ? readFileSync(promptFile, "utf8") : SYSTEM_PROMPT;
      return report(runId, await diverge(runId, getProvider(), system));
    }

    return await show(runId);
  } finally {
    await closePool();
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exit(await main());
}
