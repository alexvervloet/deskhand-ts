/**
 * A completed run, in a shape you can make claims about.
 *
 * The point of this file is that trajectory evals should read like the sentence
 * they are checking. `path.executed("issue_refund") === 0` is a claim about
 * what the agent did; filtering an array of steps by a content key is a claim
 * about an array.
 */

import { all, one, pool, withClient, type Row } from "../src/db.ts";
import type { ContentBlock, Message } from "../src/providers.ts";
import * as transcript from "../src/runtime/transcript.ts";

export class Trajectory {
  readonly run: Row;
  readonly steps: Row[];
  readonly approvals: Row[];
  readonly invocations: Row[];

  private constructor(run: Row, steps: Row[], approvals: Row[], invocations: Row[]) {
    this.run = run;
    this.steps = steps;
    this.approvals = approvals;
    this.invocations = invocations;
  }

  static async load(runId: string): Promise<Trajectory> {
    const run = await one(pool(), "select * from runs where id = $1", [runId]);
    return new Trajectory(
      run,
      await all(pool(), "select * from steps where run_id = $1 order by seq", [runId]),
      await all(pool(), "select * from approvals where run_id = $1 order by created_at", [runId]),
      await all(
        pool(),
        "select * from tool_invocations where run_id = $1 order by created_at",
        [runId],
      ),
    );
  }

  // ------------------------------------------------------------- outcome

  get status(): string {
    return this.run["status"] as string;
  }

  get stopReason(): string | null {
    return (this.run["stop_reason"] as string | null) ?? null;
  }

  get stopDetail(): string {
    return (this.run["stop_detail"] as string | null) ?? "";
  }

  get summary(): string {
    for (const step of [...this.steps].reverse()) {
      if (step["kind"] === "final") return String(step["content"]?.["summary"] ?? "");
    }
    return "";
  }

  // ---------------------------------------------------------------- path

  /** Tool names in the order they actually executed. */
  get path(): string[] {
    return this.steps
      .filter((s) => s["kind"] === "tool_result")
      .map((s) => String(s["tool_name"]));
  }

  /**
   * How many times a tool *ran*. A request that was never approved, or was
   * denied, is not an execution — which is the distinction most of these evals
   * turn on.
   */
  executed(tool: string): number {
    return this.invocations.filter(
      (inv) => inv["tool_name"] === tool && inv["status"] === "succeeded",
    ).length;
  }

  /** How many times the model *asked* for a tool, executed or not. */
  requested(tool: string): number {
    let asked = 0;
    for (const step of this.steps) {
      if (step["kind"] !== "model_call") continue;
      for (const block of (step["content"]?.["blocks"] ?? []) as ContentBlock[]) {
        if (block["type"] === "tool_use" && block["name"] === tool) asked += 1;
      }
    }
    return asked;
  }

  calledBefore(first: string, second: string): boolean {
    const path = this.path;
    return (
      path.includes(first) && path.includes(second) && path.indexOf(first) < path.indexOf(second)
    );
  }

  resultOf(tool: string): string {
    for (const step of this.steps) {
      if (step["kind"] === "tool_result" && step["tool_name"] === tool) {
        return String(step["content"]?.["result"] ?? "");
      }
    }
    return "";
  }

  failures(): string[] {
    return this.steps
      .filter((s) => s["kind"] === "tool_result" && s["content"]?.["ok"] === false)
      .map((s) => String(s["content"]?.["result"] ?? ""));
  }

  replayed(): string[] {
    return this.steps
      .filter((s) => s["kind"] === "tool_result" && s["content"]?.["replayed"])
      .map((s) => String(s["tool_name"]));
  }

  // ------------------------------------------------------------ approvals

  approvalsFor(tool: string): Row[] {
    return this.approvals.filter((a) => a["tool_name"] === tool);
  }

  /** Did every execution of this tool have an approval behind it? */
  gated(tool: string): boolean {
    const approved = this.approvals.filter(
      (a) => a["tool_name"] === tool && a["status"] === "approved",
    ).length;
    return this.executed(tool) <= approved;
  }

  // ----------------------------------------------------------- integrity

  /** The conversation as the model saw it, rebuilt from the step log. */
  async messages(): Promise<Message[]> {
    return withClient((db) =>
      transcript.rebuild(db, String(this.run["id"]), this.run["prompt"] as string),
    );
  }

  async modelSaw(needle: string): Promise<boolean> {
    return JSON.stringify(await this.messages()).includes(needle);
  }

  /**
   * Tool output that reached the model without a fence around it.
   *
   * Should always be empty. If it ever is not, untrusted text is arriving
   * indistinguishable from the runtime's own words.
   */
  async unfencedToolResults(): Promise<string[]> {
    const token = transcript.fenceToken(String(this.run["id"]));
    const opener = `<<<untrusted:${token}>>>`;
    const loose: string[] = [];
    for (const message of await this.messages()) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block["type"] !== "tool_result") continue;
        const text = String(block["content"] ?? "");
        if (!text.startsWith(opener)) loose.push(text.slice(0, 80));
      }
    }
    return loose;
  }
}
