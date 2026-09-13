/**
 * What a model call costs, in integers.
 *
 * Rates are nanodollars per token. That unit is not arbitrary: published
 * pricing is dollars per million tokens, and dollars-per-million maps to
 * *micro*dollars per token exactly — USD 5.00/MTok is 5 micros a token. Cache
 * reads are a tenth of that and cache writes are 1.25x, which is where whole
 * micros stop being enough, so everything is held one thousand times finer and
 * rounded once, at the end, when a step's cost is recorded.
 *
 * No float touches a price in arithmetic. A run's spend cap is compared against
 * integers, so "did this run exceed its budget" has exactly one answer. The
 * only float in this module is in `formatUsd`, which produces a string for a
 * human to read and is never fed back into a comparison.
 */

const NANOS_PER_MICRO = 1_000;

export interface Rate {
  /** Nanodollars per input token. */
  input: number;
  /** Nanodollars per output token. */
  output: number;
}

/** Cached input is billed at roughly a tenth of the input rate. */
export function cacheReadRate(rate: Rate): number {
  return Math.floor(rate.input / 10);
}

/** Writing to the cache carries a 1.25x premium over plain input. */
export function cacheWriteRate(rate: Rate): number {
  return Math.floor((rate.input * 125) / 100);
}

// Dollars per million tokens x 1000 == nanodollars per token.
export const RATES: Record<string, Rate> = {
  "claude-opus-5": { input: 5_000, output: 25_000 },
  "claude-opus-4-8": { input: 5_000, output: 25_000 },
  "claude-fable-5": { input: 10_000, output: 50_000 },
  "claude-fable-5-1": { input: 10_000, output: 50_000 },
  "claude-sonnet-5": { input: 2_000, output: 10_000 },
  "claude-sonnet-4-6": { input: 3_000, output: 15_000 },
  "claude-haiku-4-5": { input: 1_000, output: 5_000 },
  // OpenAI, for the live comparison in evals/live.ts. `gpt-5.4-mini` is the
  // nearest tier-mate to Haiku 4.5 by price on both axes, which is the only
  // reason it is the one being compared.
  //
  // `cacheReadRate` and `cacheWriteRate` are Anthropic's ratios — a tenth and
  // 1.25x. OpenAI discounts cached input too but does not charge to write it,
  // so the write premium is wrong for these three rows. It costs nothing today
  // because the OpenAI provider reports zero cached tokens rather than guessing
  // at a field, and a rate that is never multiplied by a non-zero count cannot
  // be wrong by any amount. Populate those counts and this comment becomes a
  // bug.
  "gpt-5.4-mini": { input: 750, output: 4_500 },
  "gpt-5-mini": { input: 250, output: 2_000 },
  "gpt-5-nano": { input: 50, output: 400 },
  // The scripted provider spends nothing. Naming it here rather than
  // special-casing at the call site keeps the accounting path identical whether
  // or not a key is set.
  mock: { input: 0, output: 0 },
};

/**
 * Thrown rather than guessing. A model whose price is unknown cannot be charged
 * against a spend cap, and silently costing zero would turn the cap into
 * decoration.
 */
export class UnknownModel extends Error {
  override readonly name = "UnknownModel";
}

export function rateFor(model: string): Rate {
  const rate = RATES[model];
  if (rate === undefined) {
    throw new UnknownModel(
      `no published rate for ${JSON.stringify(model)}; add it to src/pricing.ts before` +
        " running against it, or the per-run and per-org spend caps cannot be enforced",
    );
  }
  return rate;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Cost of one model call in microdollars, rounded half-up once.
 *
 * `inputTokens` from the API is already the *uncached* remainder, so the three
 * input figures are added rather than netted.
 */
export function costMicros(model: string, usage: Usage): number {
  const rate = rateFor(model);
  const nanos =
    usage.inputTokens * rate.input +
    usage.outputTokens * rate.output +
    (usage.cacheReadTokens ?? 0) * cacheReadRate(rate) +
    (usage.cacheWriteTokens ?? 0) * cacheWriteRate(rate);
  return Math.floor((nanos + NANOS_PER_MICRO / 2) / NANOS_PER_MICRO);
}

export function formatUsd(micros: number): string {
  const text = (micros / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
  return `$${text.replace(/0+$/, "").replace(/\.$/, "")}`;
}
