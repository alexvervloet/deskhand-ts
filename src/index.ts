/**
 * The service entrypoint.
 *
 * Starts the API, and optionally the agent inside the same process.
 */

import { settings } from "./config.ts";
import { closePool } from "./db.ts";
import { getProvider } from "./providers.ts";
import { buildApp } from "./api/app.ts";
import { LEASE_SECONDS, workOnce, workerId } from "./worker.ts";

/**
 * Optionally run the agent inside this process.
 *
 * In production the worker is its own service: it scales separately, and a
 * crash in one must not take the other down. The demo deployment sets
 * `RUN_WORKER_INLINE=1` so a single machine can be allowed to sleep when nobody
 * is looking at it and wake on the next request — which a permanently running
 * worker process would prevent.
 *
 * Returns a function that stops it.
 */
function startInlineWorker(): () => void {
  const me = workerId();
  const provider = getProvider();
  process.stdout.write(`inline worker ${me} up (provider=${provider.name})\n`);

  let stopped = false;
  void (async () => {
    while (!stopped) {
      try {
        // `workOnce` returns false when the queue was empty, which is the only
        // time it is worth pausing. A busy queue is drained without waiting.
        if (!(await workOnce(me, provider))) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`inline worker error; continuing: ${message}\n`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  })();

  return () => {
    stopped = true;
  };
}

export async function main(): Promise<void> {
  const app = await buildApp();
  const stopWorker = settings.runWorkerInline ? startInlineWorker() : null;

  await app.listen({ port: settings.port, host: settings.host });
  process.stdout.write(
    `deskhand listening on http://${settings.host}:${settings.port}` +
      ` (provider=${settings.hasModelKey ? "claude" : "mock"}, lease=${LEASE_SECONDS}s)\n`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\n${signal} received; shutting down\n`);
    stopWorker?.();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
