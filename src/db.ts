/**
 * Database access: a small connection pool, transactions, and savepoints.
 *
 * Deliberately thin. The interesting persistence rules — append-only steps,
 * lease-then-work, idempotent tool execution — live in the modules that own
 * them, not here.
 *
 * One thing this file does that the Python original does not have to: it hands
 * the caller an explicit client. `psycopg` gives every cursor an implicit
 * transaction that commits when its block exits, so the Python loop can say
 * `conn.commit()` between iterations and move on. Here the loop holds a client,
 * opens a transaction per iteration and commits it itself. The boundary is the
 * same; it is just written down rather than implied.
 */

import pg from "pg";
import { settings } from "./config.ts";

const { Pool } = pg;

// Money arrives as `bigint`/`numeric` from Postgres and node-postgres hands
// those back as strings to avoid a silent precision loss. Everything monetary
// here is integer cents or integer microdollars and comfortably inside
// Number.MAX_SAFE_INTEGER, so parse them — deliberately, in one place, rather
// than letting `"4800" > 1000` be a string comparison somewhere further down.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));

export type Row = Record<string, any>;

/**
 * Anything a query can be sent to: the pool, or one client inside a
 * transaction. Modules below the API take this rather than reaching for the
 * pool, so a caller cannot accidentally run half a unit of work on a second
 * connection outside the transaction it thought it was in.
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<pg.QueryResult<Row>>;
}

let _pool: pg.Pool | null = null;

export function pool(): pg.Pool {
  if (_pool === null) {
    _pool = new Pool({ connectionString: settings.databaseUrl, max: 10 });
    // A pool with no error handler takes the process down when an idle backend
    // is terminated — a database restart, or `pg_terminate_backend` from the
    // crash tests. The pool discards the client and carries on; this is only
    // here to stop the unhandled 'error' event being fatal.
    _pool.on("error", () => {});
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool !== null) {
    const p = _pool;
    _pool = null;
    await p.end();
  }
}

/** Run `fn` on a dedicated client that manages its own transactions. */
export async function withClient<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool().connect();
  try {
    return await fn(db);
  } finally {
    db.release();
  }
}

/**
 * Run `fn` inside one transaction, on one connection.
 *
 * The transaction boundary is the whole reason `tools/invoke.ts` can be as
 * short as it is: the tool's effect and the ledger row that remembers it are
 * written in the same transaction, so there is no window in which one exists
 * without the other.
 */
export async function transaction<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (db) => {
    await db.query("begin");
    try {
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error;
    }
  });
}

let savepointCounter = 0;

/**
 * Run `fn` inside a savepoint, rolling back only `fn`'s writes if it throws.
 *
 * This is `psycopg`'s `with cur.connection.transaction()` when a transaction is
 * already open. `invoke` needs it for a reason worth stating: a handler that
 * fails part-way through must leave no partial write behind AND must leave the
 * surrounding transaction usable, because that transaction is what records the
 * failure. Without the savepoint, one bad statement poisons the transaction the
 * ledger write still needs.
 */
export async function savepoint<T>(db: Queryable, fn: () => Promise<T>): Promise<T> {
  const name = `sp_${++savepointCounter}`;
  await db.query(`savepoint ${name}`);
  try {
    const result = await fn();
    await db.query(`release savepoint ${name}`);
    return result;
  } catch (error) {
    await db.query(`rollback to savepoint ${name}`).catch(() => {});
    await db.query(`release savepoint ${name}`).catch(() => {});
    throw error;
  }
}

export async function fetchOne(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<Row | null> {
  const { rows } = await db.query(sql, params);
  return rows[0] ?? null;
}

/**
 * Fetch exactly one row, or throw.
 *
 * The overwhelmingly common case: a lookup by primary key or unique reference
 * where a missing row is a bug, not a branch. Without this every caller either
 * asserts non-null or subscripts an optional and gets a `TypeError` somewhere
 * less informative than here.
 */
export async function one(db: Queryable, sql: string, params: unknown[] = []): Promise<Row> {
  const row = await fetchOne(db, sql, params);
  if (row === null) {
    throw new Error(`expected one row, got none: ${sql.split("\n")[0]!.slice(0, 80)}`);
  }
  return row;
}

export async function all(db: Queryable, sql: string, params: unknown[] = []): Promise<Row[]> {
  const { rows } = await db.query(sql, params);
  return rows;
}

/** Run a statement and return the number of rows it affected. */
export async function execute(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const result = await db.query(sql, params);
  return result.rowCount ?? 0;
}
