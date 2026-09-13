/**
 * Today's spend, for this merchant and for the deployment.
 */

import type { FastifyInstance } from "fastify";
import { settings } from "../../config.ts";
import { one, pool } from "../../db.ts";
import { formatUsd } from "../../pricing.ts";
import { requireCaller } from "../deps.ts";
import { UsageResponse } from "../schemas.ts";
import { money } from "../views.ts";

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The platform figure is deliberately not scoped to the caller's org, and
   * that is a real cross-tenant disclosure: any signed-in user can see what
   * every tenant together has spent today. It is here because the per-org cap
   * is not the cap that stops a run — the platform one is — and a visitor
   * watching a demo halt needs to see the ceiling that actually stopped it.
   *
   * It is a sound trade for two seeded merchants and a published password, and
   * an unsound one for a real tenant. A multi-tenant deployment should drop the
   * two `platform_*` fields, or reduce them to a boolean saying whether the
   * service ceiling is exhausted, which is the only part a tenant needs.
   */
  app.get(
    "/usage",
    { preHandler: requireCaller, schema: { response: { 200: UsageResponse } } },
    async (request) => {
      const orgId = request.caller.orgId;

      const org = await one(
        pool(),
        `select coalesce(sum(cost_micros), 0) as spend, count(*) as runs from runs
          where org_id = $1 and created_at >= date_trunc('day', now())`,
        [orgId],
      );
      const platform = await one(
        pool(),
        `select coalesce(sum(cost_micros), 0) as spend from runs
          where created_at >= date_trunc('day', now())`,
      );
      const refunded = await one(
        pool(),
        `select coalesce(sum(amount_cents), 0) as cents from refunds
          where org_id = $1 and created_at >= date_trunc('day', now())`,
        [orgId],
      );

      const orgSpend = Number(org["spend"]);
      const refundedCents = Number(refunded["cents"]);

      return {
        org_spend_today_micros: orgSpend,
        org_spend_today_display: formatUsd(orgSpend),
        org_daily_budget_micros: settings.dailyBudgetMicrosPerOrg,
        platform_spend_today_micros: Number(platform["spend"]),
        platform_daily_budget_micros: settings.platformDailyBudgetMicros,
        runs_today: Number(org["runs"]),
        refunds_today_cents: refundedCents,
        refunds_today_display: money(refundedCents),
        refund_budget_today_cents: settings.dailyRefundCentsPerOrg,
        refund_budget_today_display: money(settings.dailyRefundCentsPerOrg),
      };
    },
  );
}
