/**
 * The tool registry.
 *
 * Importing this module registers every tool. The split by file is the risk
 * split, and it is not cosmetic: which class a tool belongs to decides whether
 * it can run without a human, and that decision is made here, once, at import
 * time.
 *
 * The three side-effecting imports below are the registration. They look
 * unused; deleting one deletes its tools.
 */

import "./read.ts";
import "./reversible.ts";
import "./irreversible.ts";

export {
  RiskClass,
  ToolError,
  allTools,
  apiSchema,
  apiSchemas,
  argsHash,
  get,
  isRegistered,
  register,
  requiresApproval,
  schema,
  validate,
  type ApiToolSchema,
  type Handler,
  type ToolArgs,
  type ToolContext,
  type ToolDef,
  type ToolOutcome,
} from "./base.ts";

export { applyInverse, type Inverse } from "./reversible.ts";
export { invoke, idempotencyKey, sanitise, type Invocation } from "./invoke.ts";
