import pg from "pg";

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
  const r = await db.query<T>(sql, params);
  return r.rows;
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
