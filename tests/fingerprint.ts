/**
 * What a run left behind, in a form two runs can be compared by.
 *
 * The exactly-once claim is usually stated as "the customer is not refunded
 * twice", and counting refunds is how it gets tested. That is the weakest true
 * version of it. The claim worth defending is a refinement property:
 *
 *     for any crash schedule, the world after the run finishes is identical to
 *     the world after an uncrashed run of the same trajectory
 *
 * "Identical" needs saying precisely, because two runs of the same trajectory
 * differ in ways that are correct and expected — different run ids, different
 * timestamps, a higher `attempt`, and a `replayed` flag that is *supposed* to
 * be true on the second pass over a step. So there are two fingerprints and
 * each one names exactly what it excludes.
 *
 * Neither hashes anything. They return sorted structures, so a mismatch shows
 * what differed rather than that two hex strings are not equal — which is the
 * whole value of the fingerprint when a property test hands you a failing
 * schedule.
 */

import { all, pool, type Row } from "../src/db.ts";

export type Section = [string, unknown];
export type Fingerprint = Section[];

/**
 * Step content keys that legitimately differ between two runs of the same
 * trajectory. `replayed` is the interesting one: it is the flag the idempotency
 * ledger sets when it recognises a step it has already executed, so it is
 * *true* on a resumed run and false on a clean one. Including it would make
 * every crash schedule fail, and excluding it silently would hide the
 * mechanism, so `replayedSteps` below asserts on it separately.
 */
const VOLATILE = new Set(["replayed"]);

/**
 * Two runs of the same trajectory mint different identifiers and run at
 * different moments, and both leak into values the fingerprint would otherwise
 * compare. `idempotency_key` is literally "{run_id}:{seq}"; an inverse for
 * `add_internal_note` names the row it created; and a tool result quotes the
 * ticket body, which carries the timestamp the seeder wrote a minute ago.
 *
 * Masking uuids wholesale rather than naming the fields is the deliberate
 * choice: a field-by-field list would have to be revisited every time a handler
 * starts recording another id, and the failure mode of forgetting is a test
 * that goes red for the wrong reason. What it costs is that this fingerprint
 * cannot tell one uuid from another — which the world fingerprint can, because
 * it joins through to references and emails instead.
 */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const STAMP = /\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/g;

/**
 * Everything a customer or a merchant could observe.
 *
 * This is the fingerprint that matters. If it differs, somebody was refunded
 * twice, or emailed twice, or a ticket ended up in a state no correct run would
 * have left it in.
 */
export async function world(): Promise<Fingerprint> {
  const refunds = await all(
    pool(),
    `select o.reference as order_reference, r.amount_cents, r.currency, r.reason
       from refunds r join orders o on o.id = r.order_id
      order by o.reference, r.amount_cents, r.reason`,
  );
  const emails = await all(
    pool(),
    `select c.email, e.subject, e.body from customer_emails e
       join customers c on c.id = e.customer_id
      order by c.email, e.subject, e.body`,
  );
  const tickets = await all(
    pool(),
    `select reference, status::text as status, priority::text as priority, tags,
            assignee_id is not null as assigned
       from tickets order by reference`,
  );
  const messages = await all(
    pool(),
    `select t.reference, m.author_kind::text as author_kind, m.is_internal, m.body
       from ticket_messages m join tickets t on t.id = m.ticket_id
      order by t.reference, m.author_kind, m.body`,
  );

  return [
    ["refunds", refunds.map(sortedEntries)],
    ["emails", emails.map(sortedEntries)],
    ["tickets", tickets.map(sortedEntries)],
    ["messages", messages.map(sortedEntries)],
  ];
}

/**
 * The step log and the ledger, minus what is allowed to differ.
 *
 * A stronger claim than the world fingerprint and a more surprising one: a
 * crash should leave *no trace in the trajectory at all*. The scripted provider
 * derives its turn from the history it is handed, and a resumed worker rebuilds
 * that history from these rows — so the resumed run asks for the same turn,
 * gets the same reply, and writes the same step. A crash schedule that changes
 * this means a worker wrote something a clean run would not have.
 *
 * Excluded: ids, timestamps, latency, cost, and `replayed`.
 */
export async function trajectory(runId: string): Promise<Fingerprint> {
  const steps = await all(
    pool(),
    `select seq, kind::text as kind, tool_name, content from steps
      where run_id = $1 order by seq`,
    [runId],
  );
  const invocations = await all(
    pool(),
    `select tool_name, risk, idempotency_key, args_hash, args, status::text as status,
            result, inverse
       from tool_invocations where run_id = $1 order by idempotency_key`,
    [runId],
  );

  return [
    [
      "steps",
      steps.map((s) => [Number(s["seq"]), s["kind"], s["tool_name"], stable(s["content"])]),
    ],
    ["invocations", invocations.map((i) => sortedEntries(stable(i) as Row))],
  ];
}

/**
 * A comparable form of a jsonb column or a row.
 *
 * Drops the volatile keys, and masks the identifiers and timestamps that differ
 * between two runs of the same trajectory by construction.
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE.has(key)) continue;
      out[key] = stable((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.replace(UUID, "<id>").replace(STAMP, "<when>");
  }
  return value;
}

function sortedEntries(row: Row): [string, unknown][] {
  return Object.keys(row)
    .sort()
    .map((key) => [key, stable(row[key])]);
}

/**
 * How many steps the ledger recognised as already executed.
 *
 * The mechanism's own signal, asserted separately because `trajectory`
 * excludes it. A crash schedule that crossed a completed tool call should
 * produce at least one; a schedule that never did should produce none. If this
 * is always zero the resume path is not being exercised and the property is
 * passing for the wrong reason.
 */
export async function replayedSteps(runId: string): Promise<number> {
  const rows = await all(
    pool(),
    "select content from steps where run_id = $1 and kind = 'tool_result'",
    [runId],
  );
  return rows.filter((r) => r["content"]?.["replayed"]).length;
}

/**
 * The first section that differs, named. Turns an opaque failure into one that
 * says which table disagreed.
 */
export function describe(left: Fingerprint, right: Fingerprint): string {
  for (const [index, [name, a]] of left.entries()) {
    const b = right[index]?.[1];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      return `${name} differs:\n  clean:   ${JSON.stringify(a)}\n  crashed: ${JSON.stringify(b)}`;
    }
  }
  return "identical";
}

/** Deep equality by the same rule `describe` reports on. */
export function same(left: Fingerprint, right: Fingerprint): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
