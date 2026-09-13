/**
 * Compensation.
 *
 * Two endpoints and a read. The split is the consent mechanism, not REST
 * aesthetics: `plan` is side-effect free and returns a hash of what it found,
 * and the POST refuses anything whose plan no longer hashes to what the caller
 * was shown. "Undo this run" with no plan attached would authorise whatever the
 * ledger happened to say by the time the request landed.
 */

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { fetchOne, pool, transaction, type Queryable, type Row } from "../../db.ts";
import * as compensation from "../../runtime/compensation.ts";
import { HttpError, isUuid, requireApprover, requireCaller, requireRun } from "../deps.ts";
import { CompensationPlan, CompensationRequest, CompensationView } from "../schemas.ts";
import { planItemView } from "../views.ts";

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

export async function compensationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What walking this run back would do. Reads only.
   *
   * Available to every role, including `viewer`. Seeing what a system did and
   * what it could take back is not a privileged action; doing it is.
   */
  app.get(
    "/runs/:runId/compensation/plan",
    { preHandler: requireCaller, schema: { response: { 200: CompensationPlan } } },
    async (request) => {
      const { runId } = request.params as { runId: string };
      const run = await requireRun(runId, request.caller.orgId);
      const items = await compensation.plan(pool(), runId);

      const revertable = items.filter((i) => i.disposition === compensation.REVERT).length;
      const unrevertable = items.length - revertable;

      let compensable = true;
      let blocked: string | null = null;
      if (!compensation.TERMINAL_RUN_STATUSES.includes(run["status"] as string)) {
        compensable = false;
        blocked = `run is ${run["status"]}; cancel it first`;
      } else if (items.length === 0) {
        compensable = false;
        blocked = "this run changed nothing that can be walked back";
      } else if (revertable === 0) {
        // The plan still lists the irreversible acts, because "what could not
        // be taken back" is the thing worth reading. There is just nothing to
        // press, and an irreversible item never leaves a plan — so offering the
        // button here would offer it forever.
        compensable = false;
        blocked =
          `nothing left that can be reverted; ${unrevertable} irreversible ` +
          `${unrevertable === 1 ? "act" : "acts"} stay on the record`;
      }

      return {
        run_id: runId,
        run_status: run["status"],
        compensable,
        blocked_reason: blocked,
        plan_hash: compensation.planHash(items),
        items: items.map(planItemView),
        revertable,
        unrevertable,
      };
    },
  );

  /**
   * Authorise walking a run back.
   *
   * Approver-only, so the role that may not authorise a refund may not
   * authorise undoing one either. A `viewer` can watch a run spend money, can
   * not approve a penny of it, and can not reach into the aftermath.
   */
  app.post(
    "/runs/:runId/compensation",
    {
      preHandler: requireApprover,
      schema: { body: CompensationRequest, response: { 201: CompensationView } },
    },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const body = request.body as { plan_hash: string; reason: string };
      const caller = request.caller;
      await requireRun(runId, caller.orgId);

      let compensationId: string;
      try {
        compensationId = await transaction((db) =>
          compensation.create(db, {
            orgId: caller.orgId,
            runId,
            requestedBy: caller.userId,
            reason: body.reason,
            expectedPlanHash: body.plan_hash,
          }),
        );
      } catch (error) {
        if (error instanceof compensation.PlanError) throw new HttpError(409, error.message);
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: string }).code === UNIQUE_VIOLATION
        ) {
          // The partial unique index on (run_id) for active rows. Two people
          // pressing the button at once is a race the database settles.
          throw new HttpError(409, "a compensation for this run is already in flight");
        }
        throw error;
      }

      return reply.code(201).send(await compensationOrgView(compensationId, caller.orgId));
    },
  );

  app.get(
    "/compensations/:compensationId",
    { preHandler: requireCaller, schema: { response: { 200: CompensationView } } },
    async (request) => {
      const { compensationId } = request.params as { compensationId: string };
      if (!isUuid(compensationId)) throw new HttpError(404, "no such compensation");
      return compensationOrgView(compensationId, request.caller.orgId);
    },
  );

  app.get(
    "/runs/:runId/compensations",
    {
      preHandler: requireCaller,
      schema: { response: { 200: Type.Array(CompensationView) } },
    },
    async (request) => {
      const { runId } = request.params as { runId: string };
      await requireRun(runId, request.caller.orgId);
      const rows = await compensation.forRun(pool(), runId);
      return Promise.all(rows.map((row) => compensationRowView(pool(), row)));
    },
  );
}

async function compensationOrgView(
  compensationId: string,
  orgId: string,
): Promise<Record<string, unknown>> {
  let row: Row;
  try {
    row = await compensation.get(pool(), compensationId);
  } catch {
    throw new HttpError(404, "no such compensation");
  }
  if (String(row["org_id"]) !== orgId) {
    // Same reasoning as `requireRun`: whether an id exists in another
    // merchant's data is not this caller's business.
    throw new HttpError(404, "no such compensation");
  }
  return compensationRowView(pool(), row);
}

async function compensationRowView(db: Queryable, row: Row): Promise<Record<string, unknown>> {
  const rows = await compensation.itemsFor(db, String(row["id"]));

  let email: string | null = null;
  if (row["requested_by"]) {
    const found = await fetchOne(db, "select email from users where id = $1", [
      row["requested_by"],
    ]);
    email = found ? (found["email"] as string) : null;
  }

  return {
    id: String(row["id"]),
    run_id: String(row["run_id"]),
    status: row["status"],
    reason: row["reason"],
    stop_reason: row["stop_reason"],
    stop_detail: row["stop_detail"],
    requested_by_email: email,
    attempt: Number(row["attempt"]),
    max_attempts: Number(row["max_attempts"]),
    created_at: row["created_at"],
    finished_at: row["finished_at"],
    items: rows.map((i) => ({
      seq: Number(i["seq"]),
      step_seq: Number(i["step_seq"]),
      tool_name: i["tool_name"],
      risk: i["risk"],
      disposition: i["disposition"],
      // Re-derived rather than stored, so the wording of a description is a
      // presentation concern and changing it does not require a migration.
      describe: compensation.describe(i["tool_name"] as string, i["inverse"] ?? null),
      status: i["status"],
      detail: i["detail"],
      applied_at: i["applied_at"],
    })),
  };
}
