/**
 * The HTTP API.
 *
 * Every handler that touches tenant data filters on `caller.orgId`, inside the
 * query rather than after it. The endpoints that commit the merchant to
 * something — deciding an approval, authorising a compensation — additionally
 * require a role that may do so.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { settings } from "../config.ts";
import { HttpError } from "./deps.ts";
import { approvalRoutes } from "./routes/approvals.ts";
import { authRoutes } from "./routes/auth.ts";
import { compensationRoutes } from "./routes/compensation.ts";
import { metaRoutes } from "./routes/meta.ts";
import { runRoutes } from "./routes/runs.ts";
import { ticketRoutes } from "./routes/tickets.ts";
import { usageRoutes } from "./routes/usage.ts";
import "../tools/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(here, "..", "..", "frontend", "dist");

/**
 * `script-src 'self'` is the line that matters. This process serves the built
 * SPA as well as the API, and the session token lives in localStorage, so any
 * script that executes in this origin can read it and act as the signed-in user
 * for the week the token is good for. React escaping is what stops that today
 * and it is a single layer, on screens that render customer ticket bodies and
 * raw model output on every view.
 *
 * `style-src` has to allow inline: the UI sets style props on elements, which
 * the browser treats as inline styles. That is a real weakening and it is worth
 * being clear about which half of the policy is load-bearing — a stolen token
 * needs script execution, and script execution is what stays locked down.
 *
 * `connect-src 'self'` covers the SSE stream, which is same-origin in the
 * deployed app. In development Vite serves the UI on another port and these
 * headers never reach that page, so the split origin is unaffected.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  // An approval screen inside somebody else's iframe is a clickjacked approval.
  // frame-ancestors above is the modern spelling; this is the one older
  // browsers honour, and they disagree about nothing here.
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  // Run ids appear in the path. They are not secrets, but there is no reason to
  // hand them to whatever a user clicks through to next.
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // Run ids and ticket references come in on the path; nothing here needs a
    // body larger than a long internal note.
    bodyLimit: 1_000_000,
  });

  await app.register(cors, {
    origin: settings.corsOrigins,
    credentials: false,
  });

  /**
   * Set the headers on every response, including errors and the SPA.
   *
   * A hook rather than a per-route concern, for the boring reason: a route that
   * forgets is a route with no policy, and the static files served at the
   * bottom of this function are not routes anyone could remember to decorate.
   */
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(header)) reply.header(header, value);
    }
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ detail: error.message });
    }
    // Fastify's own validation failures carry a statusCode; anything else is a
    // bug here and must not leak its message to a client.
    const failure = error as Error & { statusCode?: number };
    if (typeof failure.statusCode === "number" && failure.statusCode < 500) {
      return reply.code(failure.statusCode).send({ detail: failure.message });
    }
    process.stderr.write(`unhandled error: ${failure.stack ?? failure.message}\n`);
    return reply.code(500).send({ detail: "internal server error" });
  });

  await app.register(authRoutes);
  await app.register(metaRoutes);
  await app.register(ticketRoutes);
  await app.register(runRoutes);
  await app.register(approvalRoutes);
  await app.register(compensationRoutes);
  await app.register(usageRoutes);

  // Registered last so it never shadows an API route. Absent in development,
  // where Vite serves the UI on its own port.
  if (existsSync(FRONTEND)) {
    const { default: fastifyStatic } = await import("@fastify/static");
    await app.register(fastifyStatic, { root: FRONTEND, wildcard: false });
    // A single-page app owns its own routing, so anything that is not a file
    // and not an API route is the app's entry point rather than a 404.
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET") return reply.code(404).send({ detail: "not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
