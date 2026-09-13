/**
 * Health, and the tool registry.
 */

import type { FastifyInstance } from "fastify";
import { settings } from "../../config.ts";
import { fetchOne, pool } from "../../db.ts";
import { allTools } from "../../tools/index.ts";
import { requireCaller } from "../deps.ts";
import { HealthResponse, ToolView } from "../schemas.ts";
import { Type } from "@sinclair/typebox";

export async function metaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", { schema: { response: { 200: HealthResponse } } }, async () => {
    await fetchOne(pool(), "select 1 as ok");
    return {
      ok: true,
      // Surfaced rather than hidden: a demo running against the scripted mock
      // should say so everywhere it can.
      provider: settings.hasModelKey ? "claude" : "mock",
      model: settings.hasModelKey ? settings.modelId : "mock",
    };
  });

  /**
   * The registry, so the UI can colour a trajectory by risk.
   *
   * Exposed rather than duplicated in the frontend. A second copy of "which
   * tools are irreversible" is a copy that will eventually disagree with the
   * first, and the disagreement would be silent and in the direction of showing
   * a money-moving call as routine.
   */
  app.get(
    "/tools",
    {
      preHandler: requireCaller,
      schema: { response: { 200: Type.Array(ToolView) } },
    },
    async () =>
      allTools().map((t) => ({ name: t.name, risk: t.risk, description: t.description })),
  );
}
