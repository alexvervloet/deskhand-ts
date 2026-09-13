/**
 * Migration runner: apply every migrations/*.sql file, once, in order.
 *
 *     npm run migrate
 *
 * Each file runs inside its own transaction and is recorded in
 * `schema_migrations` on success, so a re-run is a no-op and a failure part-way
 * through a file leaves nothing half-applied. Files are immutable once applied
 * — to change the schema, add a new one.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { settings } from "./config.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");

const BOOTSTRAP = `
create table if not exists schema_migrations (
    filename    text primary key,
    applied_at  timestamptz not null default now()
)
`;

export async function pending(client: pg.Client): Promise<string[]> {
  await client.query(BOOTSTRAP);
  const { rows } = await client.query("select filename from schema_migrations");
  const applied = new Set(rows.map((r) => r["filename"] as string));
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !applied.has(name));
}

export async function run(): Promise<number> {
  try {
    if (!statSync(MIGRATIONS_DIR).isDirectory()) throw new Error("not a directory");
  } catch {
    process.stderr.write(`no migrations directory at ${MIGRATIONS_DIR}\n`);
    return 1;
  }

  const client = new pg.Client({ connectionString: settings.databaseUrl });
  await client.connect();
  try {
    const todo = await pending(client);
    if (todo.length === 0) {
      process.stdout.write("schema up to date\n");
      return 0;
    }

    for (const name of todo) {
      process.stdout.write(`applying ${name} ... `);
      try {
        await client.query("begin");
        // The one place SQL is not a literal. These are .sql files committed to
        // this repository and applied in filename order — not input, and not
        // reachable from a request.
        await client.query(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
        await client.query("insert into schema_migrations (filename) values ($1)", [name]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        process.stdout.write("failed\n");
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        process.stderr.write(`  ${message}\n`);
        return 1;
      }
      process.stdout.write("ok\n");
    }

    process.stdout.write(`applied ${todo.length} migration(s)\n`);
    return 0;
  } finally {
    await client.end();
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exit(await run());
}
