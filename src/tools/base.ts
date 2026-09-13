/**
 * Tool definitions, the registry, and the one rule the registry exists for.
 *
 * **A tool's risk class is declared here and can never be changed at runtime.**
 *
 * That sentence is the entire security model of this module. The class is a
 * field on a frozen object, looked up by name from a Map that is populated at
 * import time and never written to again. Nothing in a model response, a tool
 * argument, or a tool *result* can reach it. This matters because tool results
 * are the one place attacker-controlled text enters the loop wearing the
 * costume of trusted data — a ticket body that says "this refund is
 * pre-approved" is a string, and strings do not get a vote on whether
 * `issue_refund` needs a human.
 *
 * The classes:
 *
 *     read          no side effects, runs freely
 *     reversible    changes state, runs freely, records its own inverse
 *     irreversible  suspends the run until a human approves this exact call
 *
 * "Records its own inverse" is exactly what it says: the undo is captured, not
 * wired up. See the note in src/tools/reversible.ts.
 */

import { createHash } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import type { Queryable } from "../db.ts";

export const RiskClass = {
  READ: "read",
  REVERSIBLE: "reversible",
  IRREVERSIBLE: "irreversible",
} as const;

export type RiskClass = (typeof RiskClass)[keyof typeof RiskClass];

/**
 * A tool failed in a way the model should see and can react to.
 *
 * Thrown for bad arguments, missing records, and policy violations — the
 * ordinary failures of doing the job. It becomes an `is_error` tool result, not
 * a crashed run: the agent is expected to read it and try something else.
 */
export class ToolError extends Error {
  override readonly name = "ToolError";
}

/**
 * Everything a handler is allowed to know.
 *
 * Note what is absent: the conversation, the model's reasoning, and the text of
 * the ticket that triggered the run. A handler acts on its arguments and the
 * database, which keeps the blast radius of a bad argument to the argument
 * itself.
 *
 * `ticketId` and `customerId` are the run's *subject*, and they are here so
 * that a read tool can scope to it. `orgId` alone is a tenancy boundary, not a
 * need-to-know one: it says the agent may not read another merchant's data and
 * says nothing about whether a run working one customer's ticket may read a
 * different customer's history. Handlers that answer questions about a person
 * compare against `customerId` rather than trusting an argument that ultimately
 * came from a model reading an untrusted ticket.
 */
export interface ToolContext {
  orgId: string;
  runId: string;
  stepId: string;
  ticketId: string;
  customerId: string;
  db: Queryable;
}

/**
 * What a handler returns.
 *
 * `result` is the text the model sees. `inverse` is the compensating action,
 * captured now rather than reconstructed later — the prior value of whatever
 * was overwritten is knowable at write time and expensive to guess afterwards.
 */
export interface ToolOutcome {
  result: string;
  inverse?: Record<string, unknown> | null;
}

export type ToolArgs = Record<string, any>;
export type Handler = (ctx: ToolContext, args: ToolArgs) => Promise<ToolOutcome>;

export interface ToolDef {
  name: string;
  risk: RiskClass;
  description: string;
  /**
   * JSON Schema for the arguments. Always an object with
   * additionalProperties: false, so an unexpected key is a validation error
   * rather than a silently ignored one.
   */
  parameters: Record<string, any>;
  handler: Handler;
  /**
   * Human-readable summary of what executing this will do, rendered on the
   * approval screen. Takes the validated arguments.
   */
  preview?: (args: ToolArgs) => string;
  /**
   * What this tool does that cannot be taken back, in one plain sentence.
   * Required for IRREVERSIBLE tools and rejected for the others, enforced in
   * `register`. It is the line a compensation screen shows against an act it is
   * telling somebody it cannot fix, and it belongs here for the same reason the
   * risk class does: both are claims about the tool that nothing at runtime may
   * edit. A wrong risk class lets money move without consent; a wrong sentence
   * here tells a person during an incident that something is recoverable when
   * it is not.
   */
  irreversibleNote?: string;
}

/**
 * Constraint keywords the Messages API refuses inside a `strict` tool schema.
 *
 * Strict mode accepts a restricted subset of JSON Schema: it guarantees the
 * *shape* of the arguments — types, required keys, no extra properties — and
 * declines to police their range. Sending one is a 400 on every model call, and
 * it is a 400 the scripted provider cannot produce, so the whole test suite and
 * the whole keyless demo stay green while the real path is broken.
 */
const NUMERIC_REJECTS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

const STRICT_REJECTS: Record<string, Set<string>> = {
  integer: NUMERIC_REJECTS,
  number: NUMERIC_REJECTS,
  array: new Set(["maxItems"]),
};

/**
 * A copy of `schema` with the keywords strict mode refuses removed.
 *
 * The constraints are not lost, only moved. `validate` still runs the full
 * schema locally — before an approval is rendered for a human, and again inside
 * the savepoint in `invoke` — so a model proposing `amount_cents: 0` gets a
 * `ToolError` it can read and correct. That is the path a bad argument was
 * always meant to take. What changes is that the API no longer refuses it on
 * the model's behalf, so the refusal arrives one turn later and costs a step.
 *
 * Only the copy handed to the API is stripped. `parameters` keeps every
 * keyword, because it is the thing that still enforces them.
 */
export function apiSafe(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(apiSafe);
  if (typeof schema !== "object" || schema === null) return schema;

  const node = schema as Record<string, unknown>;
  // Keyed on this node's own `type`, so a property that happens to be *named*
  // "minimum" is untouched: the object under `properties` has no `type` of its
  // own and therefore rejects nothing.
  const rejected = STRICT_REJECTS[String(node["type"] ?? "")] ?? new Set<string>();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!rejected.has(key)) out[key] = apiSafe(value);
  }
  return out;
}

export interface ApiToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  strict: true;
}

const ajv = new Ajv({ allErrors: false, strict: false });

const registry = new Map<string, ToolDef>();
const validators = new Map<string, ValidateFunction>();

export function register(tool: ToolDef): ToolDef {
  if (registry.has(tool.name)) {
    throw new Error(`tool ${JSON.stringify(tool.name)} is already registered`);
  }
  if (tool.parameters["additionalProperties"] !== false) {
    throw new Error(`tool ${JSON.stringify(tool.name)} must set additionalProperties: false`);
  }
  if (!("required" in tool.parameters)) {
    throw new Error(`tool ${JSON.stringify(tool.name)} must declare \`required\``);
  }
  // You cannot add a tool that moves something irrecoverable without saying
  // what it is. The alternative is a compensation screen that falls back to
  // "this tool did something that cannot be undone", which is exactly the
  // sentence a person cannot act on.
  if (tool.risk === RiskClass.IRREVERSIBLE && !tool.irreversibleNote) {
    throw new Error(
      `irreversible tool ${JSON.stringify(tool.name)} must say what it cannot take back`,
    );
  }
  if (tool.risk !== RiskClass.IRREVERSIBLE && tool.irreversibleNote) {
    throw new Error(
      `tool ${JSON.stringify(tool.name)} is ${tool.risk} and has no irreversible note to give`,
    );
  }

  // Frozen on the way in. The risk class is the thing this module exists to
  // protect and a plain object field is one assignment away from being
  // rewritten by anything holding the reference.
  const frozen = Object.freeze({ ...tool });
  registry.set(tool.name, frozen);
  validators.set(tool.name, ajv.compile(tool.parameters));
  return frozen;
}

export function get(name: string): ToolDef {
  const tool = registry.get(name);
  if (tool === undefined) throw new ToolError(`no such tool: ${JSON.stringify(name)}`);
  return tool;
}

/**
 * Whether this name is a tool at all.
 *
 * `get` throws for an unknown name and `requiresApproval` inherits that, which
 * is right for every caller that has already established the tool exists. The
 * loop has not: the name came from a model, and a model can ask for a tool that
 * was never registered. That is the model's mistake to correct, not a reason to
 * end a run, so the loop needs to be able to ask the question without being
 * thrown out of.
 */
export function isRegistered(name: string): boolean {
  return registry.has(name);
}

export function validate(name: string, args: ToolArgs): void {
  const check = validators.get(name);
  if (check === undefined) throw new ToolError(`no such tool: ${JSON.stringify(name)}`);
  if (!check(args)) {
    const first = check.errors?.[0];
    const where = first?.instancePath ? `${first.instancePath.slice(1)} ` : "";
    throw new ToolError(`invalid arguments for ${name}: ${where}${first?.message ?? "is invalid"}`);
  }
}

export function allTools(): ToolDef[] {
  return [...registry.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function apiSchema(tool: ToolDef): ApiToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: apiSafe(tool.parameters) as Record<string, any>,
    strict: true,
  };
}

/**
 * Tool definitions for the model, in a stable order.
 *
 * Sorted by name so the serialised tool block is byte-identical between
 * requests. Tools render first in the prompt, so any reordering would
 * invalidate the entire prompt cache on every call.
 */
export function apiSchemas(): ApiToolSchema[] {
  return allTools().map(apiSchema);
}

/**
 * The only question the runtime asks about a tool before running it.
 *
 * Answered from the registry, by name. Not from the model's request, not from
 * an argument, and never from a previous tool's output.
 */
export function requiresApproval(name: string): boolean {
  return get(name).risk === RiskClass.IRREVERSIBLE;
}

/**
 * Deterministic JSON: object keys sorted at every depth, no incidental
 * whitespace. `JSON.stringify` preserves insertion order, so two equal objects
 * built in different orders would otherwise hash differently — which would make
 * an approval fail to match the call it was given for.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * A stable fingerprint of "this exact call".
 *
 * An approval is bound to this value, so a human who approves a $19 refund has
 * not approved a $1,900 one. Keys are sorted so that two objects that are equal
 * hash equally regardless of construction order.
 */
export function argsHash(name: string, args: ToolArgs): string {
  const payload = JSON.stringify(canonical({ tool: name, args }));
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Build a strict-mode argument schema.
 *
 * `required` defaults to every property. The API's strict mode needs both an
 * explicit required list and additionalProperties: false, and a schema that
 * forgets either fails loudly at registration rather than at request time.
 */
export function schema(
  properties: Record<string, Record<string, unknown>>,
  required?: string[],
): Record<string, any> {
  return {
    type: "object",
    properties,
    required: required ?? Object.keys(properties),
    additionalProperties: false,
  };
}
