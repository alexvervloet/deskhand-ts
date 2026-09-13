/**
 * Request and response shapes.
 *
 * TypeBox rather than zod, and the reason is one validation engine instead of
 * two. Fastify validates and serialises with Ajv natively, and the tool
 * registry already compiles tool-argument schemas with Ajv — so a TypeBox
 * schema is the same JSON Schema both halves already speak, and the TypeScript
 * types come out of it for free.
 *
 * Kept separate from the handlers so the API's surface can be read in one
 * sitting. Money crosses this boundary as integer cents and never as a float; a
 * formatted string is provided alongside for display.
 *
 * Response schemas are deliberately loose about extra keys in a few places
 * (`content`, `args`) because those carry model output and tool arguments,
 * whose shape is the model's business rather than this file's.
 */

import { Type, type Static } from "@sinclair/typebox";

/** Timestamps go out as ISO 8601 strings; `pg` hands us Date objects. */
const Timestamp = Type.Unsafe<string>({ type: "string" });
const NullableTimestamp = Type.Unsafe<string | null>({ type: ["string", "null"] });
const Json = Type.Unsafe<Record<string, unknown>>({ type: "object", additionalProperties: true });

export const LoginRequest = Type.Object(
  {
    // Plain string, not an email format: the address is looked up
    // case-insensitively against the users table, so format validation would
    // reject nothing that the lookup does not already reject.
    email: Type.String(),
    password: Type.String(),
  },
  { additionalProperties: false },
);
export type LoginRequest = Static<typeof LoginRequest>;

export const MeResponse = Type.Object({
  id: Type.String(),
  email: Type.String(),
  role: Type.String(),
  org_id: Type.String(),
  org_slug: Type.String(),
  org_name: Type.String(),
  // Whether this person may approve an irreversible action. Sent explicitly
  // rather than inferred from the role string, so the UI never has to encode
  // the permission rule a second time and get it subtly wrong.
  can_approve: Type.Boolean(),
});

export const LoginResponse = Type.Object({
  token: Type.String(),
  expires_at: Timestamp,
  user: MeResponse,
});

export const TicketSummary = Type.Object({
  id: Type.String(),
  reference: Type.String(),
  subject: Type.String(),
  status: Type.String(),
  priority: Type.String(),
  tags: Type.Array(Type.String()),
  customer_name: Type.String(),
  customer_email: Type.String(),
  created_at: Timestamp,
  open_run_id: Type.Union([Type.String(), Type.Null()]),
});

export const TicketMessage = Type.Object({
  author_kind: Type.String(),
  is_internal: Type.Boolean(),
  body: Type.String(),
  created_at: Timestamp,
});

export const RunSummary = Type.Object({
  id: Type.String(),
  ticket_id: Type.String(),
  ticket_reference: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  stop_reason: Type.Union([Type.String(), Type.Null()]),
  stop_detail: Type.Union([Type.String(), Type.Null()]),
  provider: Type.Union([Type.String(), Type.Null()]),
  model: Type.Union([Type.String(), Type.Null()]),
  input_tokens: Type.Integer(),
  output_tokens: Type.Integer(),
  cost_micros: Type.Integer(),
  cost_display: Type.String(),
  attempt: Type.Integer(),
  created_at: Timestamp,
  finished_at: NullableTimestamp,
});

export const TicketDetail = Type.Composite([
  TicketSummary,
  Type.Object({
    messages: Type.Array(TicketMessage),
    // Every run this ticket has had, newest first. `open_run_id` names only one
    // that can still act; this is how you get back to one that cannot.
    runs: Type.Array(RunSummary),
  }),
]);

export const StartRunRequest = Type.Object(
  { ticket_reference: Type.String() },
  { additionalProperties: false },
);
export type StartRunRequest = Static<typeof StartRunRequest>;

export const StepView = Type.Object({
  seq: Type.Integer(),
  kind: Type.String(),
  tool_name: Type.Union([Type.String(), Type.Null()]),
  content: Json,
  input_tokens: Type.Integer(),
  output_tokens: Type.Integer(),
  cost_micros: Type.Integer(),
  cost_display: Type.String(),
  latency_ms: Type.Integer(),
  created_at: Timestamp,
});

export const ApprovalView = Type.Object({
  id: Type.String(),
  run_id: Type.String(),
  ticket_reference: Type.Union([Type.String(), Type.Null()]),
  tool_name: Type.String(),
  // What executing this will actually do, in one line, rendered from the
  // arguments the model supplied. This is the sentence a human approves.
  preview: Type.String(),
  args: Json,
  status: Type.String(),
  reason: Type.Union([Type.String(), Type.Null()]),
  created_at: Timestamp,
  expires_at: Timestamp,
  decided_at: NullableTimestamp,
});

export const RunDetail = Type.Composite([
  RunSummary,
  Type.Object({
    prompt: Type.String(),
    max_steps: Type.Integer(),
    max_tokens: Type.Integer(),
    max_spend_micros: Type.Integer(),
    deadline_at: Timestamp,
    steps: Type.Array(StepView),
    approvals: Type.Array(ApprovalView),
  }),
]);

export const DecideRequest = Type.Object(
  {
    decision: Type.Union([Type.Literal("approved"), Type.Literal("denied")]),
    // Fed back to the agent as the tool's result on a denial, so it can adapt
    // rather than stalling. Worth insisting on in the UI.
    reason: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type DecideRequest = Static<typeof DecideRequest>;

export const UsageResponse = Type.Object({
  org_spend_today_micros: Type.Integer(),
  org_spend_today_display: Type.String(),
  org_daily_budget_micros: Type.Integer(),
  // Deployment-wide, across every tenant, and therefore visible to all of them.
  // A demo decision with a reason, explained on the endpoint.
  platform_spend_today_micros: Type.Integer(),
  platform_daily_budget_micros: Type.Integer(),
  runs_today: Type.Integer(),
  refunds_today_cents: Type.Integer(),
  refunds_today_display: Type.String(),
  // The ceiling the number above is measured against. Sent because a figure
  // with no ceiling beside it reads as reporting; the two together read as a
  // budget, which is what it is.
  refund_budget_today_cents: Type.Integer(),
  refund_budget_today_display: Type.String(),
});

export const CompensationItemView = Type.Object({
  seq: Type.Integer(),
  step_seq: Type.Integer(),
  tool_name: Type.String(),
  risk: Type.String(),
  // 'revert' or 'report'. The second is the one a person needs to read.
  disposition: Type.String(),
  describe: Type.String(),
  status: Type.String(),
  detail: Type.Union([Type.String(), Type.Null()]),
  applied_at: NullableTimestamp,
});

/**
 * What a compensation for this run would do, before anyone authorises it.
 *
 * `plan_hash` comes back so the request that follows can be bound to this exact
 * list. A client that submits a stale hash is refused, which is the same device
 * the approval's `args_hash` uses one level down.
 */
export const CompensationPlan = Type.Object({
  run_id: Type.String(),
  run_status: Type.String(),
  // False when the run can still act. A compensation would race its worker.
  compensable: Type.Boolean(),
  blocked_reason: Type.Union([Type.String(), Type.Null()]),
  plan_hash: Type.String(),
  items: Type.Array(CompensationItemView),
  revertable: Type.Integer(),
  unrevertable: Type.Integer(),
});

export const CompensationRequest = Type.Object(
  {
    // Bound to the plan that was displayed. Not optional: "revert this run"
    // without naming what "this" was is a blank cheque against whatever the
    // ledger says by the time the request lands.
    plan_hash: Type.String(),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type CompensationRequest = Static<typeof CompensationRequest>;

export const CompensationView = Type.Object({
  id: Type.String(),
  run_id: Type.String(),
  status: Type.String(),
  reason: Type.String(),
  stop_reason: Type.Union([Type.String(), Type.Null()]),
  stop_detail: Type.Union([Type.String(), Type.Null()]),
  requested_by_email: Type.Union([Type.String(), Type.Null()]),
  attempt: Type.Integer(),
  max_attempts: Type.Integer(),
  created_at: Timestamp,
  finished_at: NullableTimestamp,
  items: Type.Array(CompensationItemView),
});

export const ToolView = Type.Object({
  name: Type.String(),
  risk: Type.String(),
  description: Type.String(),
});

export const HealthResponse = Type.Object({
  ok: Type.Boolean(),
  provider: Type.String(),
  model: Type.String(),
});
