/**
 * Configuration, loaded from the environment with working defaults.
 *
 * Every setting has a default that runs, so a fresh clone with no .env starts
 * and its tests pass. The one thing that changes behaviour by its absence is
 * ANTHROPIC_API_KEY: without it the runtime uses the scripted mock provider,
 * and says so loudly rather than pretending to be a model.
 *
 * Money is read as integers. `MAX_SPEND_USD_PER_RUN=2.00` is parsed into
 * 2_000_000 micros here, once, so no dollar float ever reaches a comparison.
 * The Python service holds these as `Decimal`; TypeScript has no decimal type
 * and the alternative — a float that is only rounded at the point of use — is
 * how spend caps come to be off by a cent in the direction of the customer.
 */

import { readFileSync } from "node:fs";

/** Parse a KEY=value file into the environment, without overwriting real env. */
function loadDotenv(path = ".env"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // No .env is the supported case, not an error.
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotenv();

function str(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

function optional(key: string): string | null {
  const value = process.env[key];
  return value === undefined || value === "" ? null : value;
}

function int(key: string, fallback: number): number {
  const raw = optional(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${key} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = optional(key);
  if (raw === null) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/**
 * Read a dollars-and-cents string as whole microdollars.
 *
 * Done by splitting on the decimal point rather than by multiplying a float,
 * because `2.31 * 1_000_000` is 2309999.9999999995 and the ceiling that
 * results is a micro short. Parsing the digits keeps the arithmetic exact.
 */
export function usdToMicros(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error(`not a dollar amount: ${JSON.stringify(value)}`);
  const [, sign, whole, frac = ""] = match;
  const micros = Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"));
  return sign === "-" ? -micros : micros;
}

function usd(key: string, fallback: string): number {
  return usdToMicros(str(key, fallback));
}

export const settings = {
  databaseUrl: str("DATABASE_URL", "postgresql://deskhand:deskhand@localhost:5438/deskhand"),

  // --- Server ---
  port: int("PORT", 8000),
  host: str("HOST", "0.0.0.0"),
  corsOrigins: str("CORS_ORIGINS", "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  // --- Model ---
  anthropicApiKey: optional("ANTHROPIC_API_KEY"),
  // Sonnet 5 rather than an Opus tier. This is a demo doing short tool-calling
  // turns over six seeded tickets, which is not work that repays the most
  // capable model; Opus is one environment variable away if a route ever turns
  // out to need it.
  modelId: str("MODEL_ID", "claude-sonnet-5"),
  // low | medium | high | xhigh | max. `high` is the API default; agentic work
  // is the case where xhigh earns its cost, so it is worth sweeping per route.
  modelEffort: str("MODEL_EFFORT", "high"),
  // A hard ceiling on tokens per model call. Thinking is adaptive on this model
  // family and counts against this, so it is sized for thinking + answer rather
  // than for the answer alone.
  maxTokensPerCall: int("MAX_TOKENS_PER_CALL", 8192),

  // --- The comparison provider ---
  // Only `evals/live.ts` reaches for these. The service itself runs on Claude
  // or on the scripted provider and has no OpenAI code path.
  openaiApiKey: optional("OPENAI_API_KEY"),
  openaiModelId: str("OPENAI_MODEL_ID", "gpt-5.4-mini"),
  // `none`, and not by choice: gpt-5.4-mini refuses function tools alongside
  // any other reasoning effort on /v1/chat/completions and points you at
  // /v1/responses. Found by `npm run evals:live -- --smoke`.
  openaiReasoningEffort: str("OPENAI_REASONING_EFFORT", "none"),
  // The Claude side of the live comparison. Separate from `modelId` so the
  // comparison names its own model rather than inheriting whatever the service
  // happens to be configured with today.
  liveClaudeModel: str("LIVE_CLAUDE_MODEL", "claude-haiku-4-5"),

  // --- Per-run bounds ---
  maxStepsPerRun: int("MAX_STEPS_PER_RUN", 24),
  maxTokensPerRun: int("MAX_TOKENS_PER_RUN", 400_000),
  maxWallclockSecondsPerRun: int("MAX_WALLCLOCK_SECONDS_PER_RUN", 900),
  maxSpendMicrosPerRun: usd("MAX_SPEND_USD_PER_RUN", "2.00"),
  loopDetectionThreshold: int("LOOP_DETECTION_THRESHOLD", 3),

  // A compensation makes no model calls and its plan cannot grow, so steps,
  // tokens and spend have nothing to bound. The only way it can fail to
  // terminate is by crashing and being re-claimed forever, so that is the one
  // thing bounded here. Reaching it leaves the compensation `blocked`, which is
  // a state a person has to clear rather than one a retry can.
  maxCompensationAttempts: int("MAX_COMPENSATION_ATTEMPTS", 3),

  // --- Payout ceilings ---
  // What the agent may hand back to customers, as opposed to what it costs to
  // run. These are the only bounds here denominated in the merchant's money
  // rather than ours, and they are the ones that matter: a runaway run was
  // always capped at a couple of dollars of inference, while the amount it
  // could refund was capped only by a human reading approval screens.
  maxRefundCentsPerRun: int("MAX_REFUND_CENTS_PER_RUN", 100_000),
  dailyRefundCentsPerOrg: int("DAILY_REFUND_CENTS_PER_ORG", 500_000),

  // --- Spend ceilings ---
  dailyBudgetMicrosPerOrg: usd("DAILY_BUDGET_USD_PER_ORG", "10.00"),
  // Per-org caps bound one tenant, so they only bound the bill if the number of
  // tenants is bounded too. This is the number that actually caps what the
  // deployment can spend in a day, whatever the tenant count turns out to be.
  platformDailyBudgetMicros: usd("PLATFORM_DAILY_BUDGET_USD", "50.00"),

  // --- Approvals ---
  approvalTtlSeconds: int("APPROVAL_TTL_SECONDS", 86_400),

  // --- Deployment ---
  // Behind a proxy the socket peer is the proxy, so the login throttle would
  // see every visitor as one caller. Name the header the proxy sets *and
  // overwrites* (Fly-Client-IP, X-Real-IP) — never one a client can forge.
  clientIpHeader: optional("CLIENT_IP_HEADER"),
  // Run the agent inside the API process instead of as its own service. Wrong
  // for production, where they scale and fail independently; right for a demo
  // machine that should be allowed to sleep when nobody is looking at it.
  runWorkerInline: bool("RUN_WORKER_INLINE", false),

  // No observability settings, deliberately. The step log is the trace — every
  // model and tool call is a row with tokens, cost, latency, arguments and
  // result — and src/tracing.ts emits a structured line per event for whatever
  // collects your logs. Neither needs configuring.

  get hasModelKey(): boolean {
    return Boolean(this.anthropicApiKey);
  },

  get hasOpenAiKey(): boolean {
    return Boolean(this.openaiApiKey);
  },
};

export type Settings = typeof settings;
