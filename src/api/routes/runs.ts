/**
 * Runs: starting one, reading it, cancelling it, replaying it, and watching it.
 *
 * The interesting endpoint is `GET /runs/:id/stream`: a live view of a
 * trajectory as it happens, which is what makes the approval gate legible. You
 * watch the agent read the ticket, read the order, check the policy, and then
 * stop, waiting for you.
 */

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { setTimeout as sleep } from "node:timers/promises";
import { settings } from "../../config.ts";
import { all, execute, fetchOne, pool, transaction, withClient } from "../../db.ts";
import * as tracing from "../../tracing.ts";
import { runLimiter } from "../../ratelimit.ts";
import * as runs from "../../runtime/runs.ts";
import * as transcript from "../../runtime/transcript.ts";
import { SYSTEM_PROMPT } from "../../runtime/loop.ts";
import { HttpError, requireCaller, requireRun } from "../deps.ts";
import { RunDetail, RunSummary, StartRunRequest } from "../schemas.ts";
import { approvalView, runSummary, stepView } from "../views.ts";

const TERMINAL = ["succeeded", "failed", "exhausted", "cancelled"];

export async function runRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/runs",
    {
      preHandler: requireCaller,
      schema: { body: StartRunRequest, response: { 201: RunSummary } },
    },
    async (request, reply) => {
      const caller = request.caller;
      if (!runLimiter.allow(caller.orgId)) {
        throw new HttpError(
          429,
          "too many runs started in the last minute; wait before starting another",
        );
      }

      const body = request.body as { ticket_reference: string };
      const ticket = await fetchOne(
        pool(),
        "select id from tickets where org_id = $1 and reference = $2",
        [caller.orgId, body.ticket_reference],
      );
      if (ticket === null) throw new HttpError(404, "no such ticket");

      const existing = await fetchOne(
        pool(),
        `select id from runs where ticket_id = $1
           and status in ('queued','running','awaiting_approval')`,
        [ticket["id"]],
      );
      if (existing !== null) {
        // Two agents working the same ticket would race on the same order and
        // could both propose a refund for it. One at a time.
        throw new HttpError(409, `a run is already open on this ticket (${existing["id"]})`);
      }

      const runId = await transaction(async (db) => {
        const id = await runs.create(db, {
          orgId: caller.orgId,
          ticketId: String(ticket["id"]),
          startedBy: caller.userId,
        });
        await runs.audit(db, {
          orgId: caller.orgId,
          runId: id,
          actorKind: "human",
          actorId: caller.userId,
          action: "run.started",
          detail: { ticket: body.ticket_reference },
        });
        return id;
      });

      // Traced only after the commit: every other event in this system
      // describes an attempt, but there is no attempt to describe here — either
      // the run row exists or the request failed.
      tracing.runStarted(runId, {
        orgId: caller.orgId,
        ticket: body.ticket_reference,
        provider: settings.hasModelKey ? "claude" : "mock",
        model: settings.hasModelKey ? settings.modelId : "mock",
      });

      return reply.code(201).send(runSummary(await requireRun(runId, caller.orgId)));
    },
  );

  app.get(
    "/runs",
    {
      preHandler: requireCaller,
      schema: {
        // `minimum: 1` rather than a clamp at both ends: a negative limit is a
        // bad request and Postgres rejects it outright, where an over-large one
        // is a reasonable ask for "all of them" and is quietly capped.
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, default: 50 })),
        }),
        response: { 200: Type.Array(RunSummary) },
      },
    },
    async (request) => {
      const { limit = 50 } = request.query as { limit?: number };
      const rows = await all(
        pool(),
        `select r.*, t.reference as ticket_reference from runs r
           join tickets t on t.id = r.ticket_id
          where r.org_id = $1 order by r.created_at desc limit $2`,
        [request.caller.orgId, Math.min(limit, 200)],
      );
      return rows.map(runSummary);
    },
  );

  app.get(
    "/runs/:runId",
    { preHandler: requireCaller, schema: { response: { 200: RunDetail } } },
    async (request) => {
      const { runId } = request.params as { runId: string };
      const run = await requireRun(runId, request.caller.orgId);
      const steps = await all(pool(), "select * from steps where run_id = $1 order by seq", [
        runId,
      ]);
      const pending = await all(
        pool(),
        "select * from approvals where run_id = $1 order by created_at",
        [runId],
      );
      return {
        ...runSummary(run),
        prompt: run["prompt"],
        max_steps: Number(run["max_steps"]),
        max_tokens: Number(run["max_tokens"]),
        max_spend_micros: Number(run["max_spend_micros"]),
        deadline_at: run["deadline_at"],
        steps: steps.map(stepView),
        approvals: pending.map(approvalView),
      };
    },
  );

  app.post(
    "/runs/:runId/cancel",
    { preHandler: requireCaller, schema: { response: { 200: RunSummary } } },
    async (request) => {
      const { runId } = request.params as { runId: string };
      const caller = request.caller;
      const run = await requireRun(runId, caller.orgId);
      if (TERMINAL.includes(run["status"] as string)) {
        throw new HttpError(409, `run is already ${run["status"]}`);
      }

      await transaction(async (db) => {
        await runs.finish(db, runId, {
          status: "cancelled",
          stopReason: runs.STOP_CANCELLED,
          stopDetail: `cancelled by ${caller.email}`,
        });
        await execute(
          db,
          "update approvals set status = 'expired' where run_id = $1 and status = 'pending'",
          [runId],
        );
        await runs.audit(db, {
          orgId: caller.orgId,
          runId,
          actorKind: "human",
          actorId: caller.userId,
          action: "run.cancelled",
        });
      });

      return runSummary(await requireRun(runId, caller.orgId));
    },
  );

  /**
   * The conversation exactly as it stood before step `at`.
   *
   * Reconstructed from the step log, which is a pure function of rows — so this
   * answers "what did the model actually see when it decided to refund?" with
   * the same bytes today and in a year. Nothing is executed and no model is
   * called; this endpoint only reads.
   */
  app.get(
    "/runs/:runId/replay",
    {
      preHandler: requireCaller,
      schema: { querystring: Type.Object({ at: Type.Optional(Type.Integer()) }) },
    },
    async (request) => {
      const { runId } = request.params as { runId: string };
      const { at } = request.query as { at?: number };
      const run = await requireRun(runId, request.caller.orgId);
      const messages = await withClient((db) =>
        transcript.rebuild(db, runId, run["prompt"], { beforeSeq: at ?? null }),
      );
      return { run_id: runId, before_seq: at ?? null, system: SYSTEM_PROMPT, messages };
    },
  );

  /**
   * Server-sent events: every step as it lands, then the ending.
   *
   * Implemented by polling rather than LISTEN/NOTIFY. Polling holds no database
   * connection between ticks, which matters more here than latency does: a
   * stream can stay open for as long as a human takes to answer an approval,
   * and a notification-based version would pin a connection for that whole
   * time. The cost is up to half a second of lag on a step, which nobody
   * watching an agent think will notice.
   */
  app.get("/runs/:runId/stream", { preHandler: requireCaller }, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    await requireRun(runId, request.caller.orgId);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let open = true;
    request.raw.on("close", () => {
      open = false;
    });

    let sent = 0;
    let lastStatus: string | null = null;
    const deadline = Date.now() + 900_000;

    try {
      while (open && Date.now() < deadline) {
        const steps = await all(
          pool(),
          "select * from steps where run_id = $1 and seq > $2 order by seq",
          [runId, sent],
        );
        for (const step of steps) {
          sent = Number(step["seq"]);
          send("step", stepView(step));
        }

        // The ticket join matters: the client merges each status event into the
        // run it is displaying, so a summary with a null reference here would
        // blank the header the moment the run changed state.
        const run = await fetchOne(
          pool(),
          `select r.*, t.reference as ticket_reference from runs r
             join tickets t on t.id = r.ticket_id where r.id = $1`,
          [runId],
        );
        if (run === null) {
          send("error", { message: "run disappeared" });
          return reply.raw.end();
        }

        if (run["status"] !== lastStatus) {
          lastStatus = run["status"] as string;
          send("status", runSummary(run));
        }

        if (run["status"] === "awaiting_approval") {
          const waiting = await all(
            pool(),
            `select a.*, t.reference as ticket_reference from approvals a
               join runs r on r.id = a.run_id
               join tickets t on t.id = r.ticket_id
              where a.run_id = $1 and a.status = 'pending'`,
            [runId],
          );
          send("approval", waiting.map(approvalView));
        }

        if (TERMINAL.includes(run["status"] as string)) {
          send("done", runSummary(run));
          return reply.raw.end();
        }

        await sleep(500);
      }

      if (open) send("done", { note: "stream timed out; the run continues" });
    } finally {
      reply.raw.end();
    }
    return reply;
  });
}
