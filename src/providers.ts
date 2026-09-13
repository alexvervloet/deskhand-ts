/**
 * Model providers: the real one, and a scripted one that needs no key.
 *
 * Both return the same `ModelReply`, and the runtime cannot tell them apart.
 * That matters more than it sounds: the durable loop, the approval gate and the
 * bounds are all exercised identically whether or not an API key is set, so the
 * machinery this project is actually about is testable in CI for free.
 *
 * The mock is **not** a small language model and makes no claim to be. It is a
 * handful of fixed trajectories chosen by keyword, whose job is to drive the
 * runtime through its interesting states — including the approval gate and a
 * crash resume. Every run it produces is tagged `provider=mock` in the API, the
 * step log, and the run viewer, so a demo can never be mistaken for a model.
 *
 * There is no OpenAI provider here, and that matches the Python service rather
 * than trimming it: the comparison harness is the only thing that ever built
 * one, and the service has no OpenAI code path.
 */

import { settings } from "./config.ts";
import { costMicros } from "./pricing.ts";

export interface ContentBlock {
  type: string;
  [key: string]: any;
}

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ModelReply {
  /**
   * Raw content blocks, stored and replayed verbatim. Thinking blocks in
   * particular must go back to the model unmodified, so nothing here is
   * normalised, summarised, or pruned on the way through.
   */
  content: ContentBlock[];
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  complete(system: string, messages: Message[], tools: unknown[]): Promise<ModelReply>;
}

export function toolUses(reply: ModelReply): ContentBlock[] {
  return reply.content.filter((b) => b["type"] === "tool_use");
}

export function replyText(reply: ModelReply): string {
  return reply.content
    .filter((b) => b["type"] === "text")
    .map((b) => (b["text"] as string) ?? "")
    .join("\n")
    .trim();
}

// --------------------------------------------------------------------- Claude

/**
 * Models that reject adaptive thinking and `output_config.effort`.
 *
 * Keyed on the exact model id rather than matched on a prefix. A prefix rule
 * would be shorter and would give the wrong answer for `claude-haiku-5` on the
 * day it ships — and the way you find out is a 400 on every call, which is the
 * most expensive kind of wrong this file can be. An unlisted model gets the
 * current-generation request shape, and adding one here is a one-line change
 * with the API's own error message pointing at it.
 */
export const NO_ADAPTIVE_THINKING = new Set(["claude-haiku-4-5"]);

/**
 * The real thing.
 *
 * Notes on the request shape, because several of these changed recently and the
 * wrong one is a 400 rather than a warning:
 *
 * * `thinking` is adaptive. Fixed `budget_tokens` is removed on this model
 *   family; depth is controlled by `effort` instead.
 * * No `temperature`/`top_p`/`top_k` — they are rejected outright.
 * * `max_tokens` bounds thinking *plus* the answer, and thinking is on by
 *   default here, so it is sized with that in mind.
 * * The system prompt carries a cache breakpoint. Tools render ahead of it and
 *   are emitted in a stable order, so the cached prefix survives between steps
 *   of a run and between runs of the same shape.
 */
export class ClaudeProvider implements Provider {
  readonly name = "claude";
  readonly model: string;
  readonly effort: string;
  #client: any = null;

  constructor(model?: string, effort?: string) {
    this.model = model ?? settings.modelId;
    this.effort = effort ?? settings.modelEffort;
  }

  // Imported lazily so a keyless process never loads the SDK, and so the test
  // suite does not pay for it on every run.
  async #anthropic(): Promise<any> {
    if (this.#client === null) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.#client = new Anthropic({ apiKey: settings.anthropicApiKey ?? undefined });
    }
    return this.#client;
  }

  async complete(system: string, messages: Message[], tools: unknown[]): Promise<ModelReply> {
    const request: Record<string, unknown> = {
      model: this.model,
      max_tokens: settings.maxTokensPerCall,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    };
    // Adaptive thinking and `output_config.effort` arrived together with the 4.6
    // family. On a model that predates them each is a 400 on every call — not a
    // warning, not a degraded response — so a model that does not take them gets
    // neither, rather than one and a crash.
    if (!NO_ADAPTIVE_THINKING.has(this.model)) {
      request["thinking"] = { type: "adaptive" };
      request["output_config"] = { effort: this.effort };
    }

    const client = await this.#anthropic();
    const started = Date.now();
    const response = await client.messages.create(request);
    const latencyMs = Date.now() - started;

    const usage = response.usage ?? {};
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;

    // `stopReason` is checked by the caller before it reads content. A safety
    // refusal returns HTTP 200 with an empty or partial content list, so
    // anything that indexes content[0] unconditionally breaks here rather than
    // at the API boundary.
    return {
      content: (response.content ?? []).map(stripNulls),
      stopReason: response.stop_reason ?? "end_turn",
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costMicros: costMicros(this.model, {
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      }),
      provider: this.name,
      model: this.model,
      latencyMs,
    };
  }
}

/** The SDK returns nulls for absent optional fields; the step log keeps them out. */
function stripNulls(block: Record<string, unknown>): ContentBlock {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out as ContentBlock;
}

// -------------------------------------------------------------------- Scripted

/**
 * Replays a fixed list of turns. The workhorse of the test suite.
 *
 * Statelessness is the requirement, not a simplification. A resumed run
 * rebuilds its message history from the step log and asks the provider for the
 * next turn; if the provider held a private counter, resuming would return the
 * wrong turn and the crash-resume tests would pass for the wrong reason. So the
 * turn index is *derived* from the history it is given.
 *
 * Which makes a script *positional*, and that catches people out. Driving one
 * run twice with two different scripts does not start the second script at its
 * own first entry: the run already has assistant turns on it, and the index
 * lands wherever that history says. A second drive has to carry the turns
 * already taken —
 *
 *     new ScriptedProvider([...FIRST_SCRIPT, [call("...")], text("...")])
 *
 * — or it silently serves the wrong turn and the test fails somewhere else.
 */
export class ScriptedProvider implements Provider {
  readonly name: string;
  readonly model: string;
  script: ContentBlock[][];

  constructor(script: ContentBlock[][] = [], name = "mock", model = "mock") {
    this.script = script;
    this.name = name;
    this.model = model;
  }

  static turnIndex(messages: Message[]): number {
    return messages.filter((m) => m.role === "assistant").length;
  }

  async complete(_system: string, messages: Message[], _tools: unknown[]): Promise<ModelReply> {
    const index = ScriptedProvider.turnIndex(messages);
    const entry = this.script[index];
    const blocks: ContentBlock[] =
      entry !== undefined
        ? entry.map((b) => ({ ...b }))
        : [{ type: "text", text: "Nothing further to do." }];

    // Deterministic ids. A uuid here would break replay: the tool_use id is what
    // an approval is tied to, and a resumed run must produce the same one or the
    // human's decision would no longer match anything.
    blocks.forEach((block, position) => {
      if (block["type"] === "tool_use" && block["id"] === undefined) {
        block["id"] = `toolu_mock_${index}_${position}`;
      }
    });

    const hasTools = blocks.some((b) => b["type"] === "tool_use");
    return {
      content: blocks,
      stopReason: hasTools ? "tool_use" : "end_turn",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: 0,
      provider: this.name,
      model: this.model,
      latencyMs: 0,
    };
  }
}

export function text(body: string): ContentBlock[] {
  return [{ type: "text", text: body }];
}

export function call(name: string, args: Record<string, unknown> = {}): ContentBlock {
  return { type: "tool_use", name, input: args };
}

// ------------------------------------------------------- the keyless default

// Order references are four digits (NW-1042); ticket references are one or two
// (NW-1). Crude, and adequate for a fixture-driven demo — the mock's job is to
// reach the interesting states, not to parse English.
const ORDER_REF = /\b([A-Z]{2}-\d{3,})\b/;
const TICKET_REF = /\b([A-Z]{2}-\d{1,2})\b/;
// One line of `get_order`'s item list:
// "  2x Ethiopia Guji, ... (BEAN-ETH-12) @ 19.00 USD".
const ORDER_ITEM = /^\s*(\d+)x .*?\(([A-Z][\w-]*)\) @ ([\d,]+)\.(\d{2}) USD/gm;

/**
 * The opening prompt plus the first tool result, and nothing after it.
 *
 * Deliberately *not* the whole conversation. The plan below is recomputed from
 * scratch on every turn — it has to be, because the provider is stateless so
 * that a resumed run reaches the same decision — and reading the growing
 * transcript made that recomputation unstable: the agent would set off down the
 * "where is my order" path, a knowledge-base search would return an article
 * that happens to contain the word *refund*, and the next turn would decide it
 * had been working a refund all along.
 *
 * That is not a hypothetical. It happened, and produced a demo in which the
 * agent asked to refund a customer who only wanted a tracking number. The
 * ticket is what the plan is about, so the plan reads the ticket and stops.
 */
export function brief(messages: Message[]): string {
  const parts: string[] = [];
  let seenResult = false;
  for (const message of messages) {
    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }
    for (const block of message.content) {
      if (block["type"] === "text") {
        parts.push((block["text"] as string) ?? "");
      } else if (block["type"] === "tool_result" && !seenResult) {
        const inner = block["content"];
        parts.push(typeof inner === "string" ? inner : String(inner));
        seenResult = true;
      }
    }
    if (seenResult) break;
  }
  return parts.join("\n");
}

/**
 * What the goods on this order came to, in cents, shipping excluded.
 *
 * Read from `get_order`'s item lines rather than from its `total:`, because a
 * customer asking for a refund on what they bought is not asking for their
 * postage back. Shipping is identified by SKU prefix, a convention of the seed
 * data and fine for a fake.
 *
 * **Which results to read is decided structurally, not textually.** Every tool
 * result reaching the model is fenced, `get_ticket`'s included — so the
 * customer's own words are in this transcript, and any rule of the form "read
 * the results that look like an order" is a rule a ticket body can satisfy. The
 * first attempt at this required the text to begin with `Order `, which a fence
 * makes impossible and which cost a demo that never reached the approval gate
 * at all. So the tool_use blocks are walked first to learn which id belongs to
 * which tool, and only results whose call was `get_order` are read. A ticket
 * body cannot forge a tool_use id.
 *
 * Zero item lines means zero, which `issue_refund` rejects as an invalid
 * argument — visibly, in the trajectory, rather than by quietly substituting a
 * number nobody chose. That is the failure mode the constant this replaced did
 * not have, and having it is the point.
 */
export function refundable(messages: Message[]): number {
  const fromOrder = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block["name"] === "get_order" && typeof block["id"] === "string") {
        fromOrder.add(block["id"]);
      }
    }
  }

  let total = 0;
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block["type"] !== "tool_result") continue;
      if (!fromOrder.has(block["tool_use_id"])) continue;
      const inner = block["content"];
      const body = typeof inner === "string" ? inner : String(inner);
      for (const match of body.matchAll(ORDER_ITEM)) {
        const [, quantity, sku, dollars, cents] = match;
        if (sku!.startsWith("SHIP")) continue;
        total +=
          Number(quantity) * (Number(dollars!.replaceAll(",", "")) * 100 + Number(cents));
      }
    }
  }
  return total;
}

/**
 * The trajectory used when there is no API key and no explicit script.
 *
 * It picks one of three shapes from the ticket text and fills in references and
 * amounts by reading them back out of earlier tool results. That is enough to
 * walk the runtime through a full run — including suspending on an irreversible
 * call and resuming after a human decides — with no key and no network.
 *
 * **Two different reads, on purpose.** Which shape to take is decided from
 * `brief`, which stops at the first tool result — see its comment for the demo
 * that decision exists because of. The *amount* is read from the whole
 * transcript instead, because the order it comes from is fetched two turns
 * after the branch is chosen. Reading a detail late cannot destabilise a branch
 * that was already decided; reading the branch late could, and did.
 */
export class DefaultMockProvider extends ScriptedProvider {
  constructor() {
    super([]);
  }

  override async complete(
    system: string,
    messages: Message[],
    tools: unknown[],
  ): Promise<ModelReply> {
    this.script = this.#plan(messages);
    return super.complete(system, messages, tools);
  }

  #plan(messages: Message[]): ContentBlock[][] {
    const seen = brief(messages);
    const ticketRef = TICKET_REF.exec(seen)?.[1] ?? "NW-1";

    const wantsRefund = ["refund", "charged twice", "money back"].some((word) =>
      seen.toLowerCase().includes(word),
    );

    const plan: ContentBlock[][] = [[call("get_ticket", { reference: ticketRef })]];

    if (!wantsRefund) {
      plan.push(
        [call("search_kb", { query: "shipping times tracking delay" })],
        [
          call("add_internal_note", {
            reference: ticketRef,
            body:
              "Checked the knowledge base: this is inside the published " +
              "turnaround, so no action is due yet.",
          }),
        ],
        [call("set_ticket_status", { reference: ticketRef, status: "pending" })],
        text(
          `${ticketRef} is within the published turnaround. I left an internal ` +
            "note and moved it to pending.",
        ),
      );
      return plan;
    }

    const orderRef = ORDER_REF.exec(seen)?.[1] ?? null;
    if (orderRef === null) {
      plan.push(
        [call("search_kb", { query: "refund policy window" })],
        text("I could not find an order reference on this ticket."),
      );
      return plan;
    }

    const amount = refundable(messages);

    plan.push(
      [call("get_order", { reference: orderRef })],
      [call("search_kb", { query: "refund policy window delivered" })],
      [
        call("issue_refund", {
          order_reference: orderRef,
          amount_cents: amount,
          reason: "Quality complaint inside the published refund window.",
        }),
      ],
      [
        call("add_internal_note", {
          reference: ticketRef,
          body: `Refund processed against ${orderRef} after human approval.`,
        }),
      ],
      [call("set_ticket_status", { reference: ticketRef, status: "resolved" })],
      text(`Refunded ${orderRef} and resolved ${ticketRef}.`),
    );
    return plan;
  }
}

/**
 * The provider this process will use.
 *
 * Falls back to the mock rather than failing, because running keyless is a
 * supported mode — but the choice is logged and surfaced on every run, so it is
 * never a silent substitution.
 */
export function getProvider(): Provider {
  if (settings.hasModelKey) return new ClaudeProvider();
  process.stderr.write("no ANTHROPIC_API_KEY — using the scripted mock provider\n");
  return new DefaultMockProvider();
}
