/**
 * The approval queue, and the one endpoint that commits the merchant to
 * something.
 */

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { transaction } from "../../db.ts";
import * as approvals from "../../runtime/approvals.ts";
import { HttpError, isUuid, requireApprover, requireCaller } from "../deps.ts";
import { ApprovalView, DecideRequest } from "../schemas.ts";
import { approvalView } from "../views.ts";

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/approvals",
    {
      preHandler: requireCaller,
      schema: { response: { 200: Type.Array(ApprovalView) } },
    },
    async (request) => {
      const rows = await transaction(async (db) => {
        // Sweep timed-out approvals before answering, so the queue a human sees
        // never contains a decision that can no longer be made.
        await approvals.expireStale(db);
        return approvals.pendingForOrg(db, request.caller.orgId);
      });
      return rows.map(approvalView);
    },
  );

  app.post(
    "/approvals/:approvalId/decide",
    {
      preHandler: requireApprover,
      schema: { body: DecideRequest, response: { 200: ApprovalView } },
    },
    async (request) => {
      const { approvalId } = request.params as { approvalId: string };
      const body = request.body as { decision: "approved" | "denied"; reason?: string | null };
      const caller = request.caller;

      if (!isUuid(approvalId)) {
        throw new HttpError(409, "approval is not pending, has expired, or does not exist");
      }

      let row;
      try {
        row = await transaction((db) =>
          approvals.decide(db, {
            approvalId,
            orgId: caller.orgId,
            decision: body.decision,
            decidedBy: caller.userId,
            reason: body.reason ?? null,
          }),
        );
      } catch (error) {
        if (error instanceof approvals.ApprovalNotPending) {
          throw new HttpError(409, error.message);
        }
        throw error;
      }

      return approvalView(row);
    },
  );
}
