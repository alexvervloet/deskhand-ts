/**
 * A small fixed-window limiter for the login endpoint.
 *
 * In-process and therefore per-instance, which is worth stating plainly: behind
 * several replicas the effective limit multiplies by the replica count. That is
 * an acceptable trade for a portfolio deployment and would not be for a real
 * one, where this belongs in Redis or at the edge. It exists because an
 * unthrottled login endpoint against bcrypt is both a credential-stuffing
 * target and a denial-of-service one — every attempt costs a deliberate ~250ms
 * of CPU.
 *
 * No lock, unlike the Python original. Node runs this on one thread and none of
 * `allow` awaits, so the read-modify-write cannot interleave.
 */

export class FixedWindowLimiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly #hits = new Map<string, number[]>();

  constructor(limit: number, windowSeconds: number) {
    this.limit = limit;
    this.windowMs = windowSeconds * 1000;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }

  /** Used by the test suite, which logs in far faster than a human. */
  reset(): void {
    this.#hits.clear();
  }
}

export const authLimiter = new FixedWindowLimiter(10, 60);

/**
 * Starting runs. Keyed by org, because the cost lands on the merchant's budget
 * and not on the individual who clicked.
 *
 * The budget caps are the real ceiling and they are checked before every model
 * call, so this is not what stops a bill running away. It stops the cheaper
 * nuisance the budget caps handle badly: a signed-in user looping the endpoint
 * fills the queue with runs that each burn a little of a shared daily budget
 * before stopping, and every other tenant on the deployment finds the platform
 * ceiling exhausted by someone else's afternoon.
 */
export const runLimiter = new FixedWindowLimiter(30, 60);
