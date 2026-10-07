import pg from "pg";
import { tracingEnabled, withSpan } from "./tracing";

export type Db = pg.Pool | pg.PoolClient;

declare global {
  // eslint-disable-next-line no-var
  var __linkosPool: pg.Pool | undefined;
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

export function pool(): pg.Pool {
  if (!globalThis.__linkosPool) {
    const url = databaseUrl();
    globalThis.__linkosPool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      // fail fast instead of hanging when the pool is exhausted or a lock is held too long
      connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000),
      statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 15000),
      lock_timeout: Number(process.env.DB_LOCK_TIMEOUT_MS ?? 10000),
      idle_in_transaction_session_timeout: 30000,
      ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
  }
  return globalThis.__linkosPool;
}

export async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  db: Db = pool(),
): Promise<T[]> {
  if (!tracingEnabled()) return (await db.query<T>(sql, params)).rows;
  // F-180: DB span (statement text only — values are bound parameters, never logged)
  return withSpan("db.query", { "db.system": "postgresql", "db.statement": sql.replace(/\s+/g, " ").trim().slice(0, 300) }, async (span) => {
    const r = await db.query<T>(sql, params);
    span?.setAttribute("db.rows", r.rowCount ?? r.rows.length);
    return r.rows;
  }, { kind: "client" });
}

export async function one<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  db: Db = pool(),
): Promise<T | null> {
  const rows = await q<T>(sql, params, db);
  return rows[0] ?? null;
}

/** Run fn inside a transaction. Outbox writes must use the provided client (백서 아키텍처: same-transaction outbox). */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  if (tracingEnabled()) return withSpan("db.transaction", { "db.system": "postgresql" }, () => runTx(fn));
  return runTx(fn);
}

async function runTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (globalThis.__linkosPool) {
    await globalThis.__linkosPool.end();
    globalThis.__linkosPool = undefined;
  }
}
