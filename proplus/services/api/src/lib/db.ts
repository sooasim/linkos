// P-180/P-181 플랫폼 DB 접근. LINKOS services/api/src/lib/db.ts 와 같은 관례를 쓴다.
//
// 왜 전역 풀 변수인가: Next.js dev 의 HMR 과 vitest 의 모듈 재평가가 이 파일을 여러 번 불러오고,
// 그때마다 새 Pool 을 만들면 Postgres 연결이 누적되어 max_connections 를 먹는다.
// 변수 이름은 `__proplusPool` 이다 — LINKOS 가 `__linkosPool` 을 쓰므로 한 프로세스에 둘이 떠도 섞이지 않는다
// (전략 §1: DB·프로세스를 공유하지 않는다).
import pg from "pg";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { ApiError } from "./errors";

export type Db = Pool | PoolClient;

declare global {
  // eslint-disable-next-line no-var
  var __proplusPool: Pool | undefined;
}

export function databaseUrl(): string {
  // 전략 §1: PROPLUS 는 LINKOS 와 **다른 데이터베이스**다. 변수 이름도 분리해 실수로 linkos DB 를 가리키지 않게 한다.
  const url = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("PROPLUS_DATABASE_URL is not set");
  return url;
}

export function pool(): Pool {
  if (!globalThis.__proplusPool) {
    const url = databaseUrl();
    globalThis.__proplusPool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      // 풀이 비거나 락이 오래 잡히면 매달리는 대신 빨리 실패한다 — 공개 프로필 p95 목표(P-194)를 지키는 쪽이 중요하다.
      connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000),
      statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 15000),
      lock_timeout: Number(process.env.DB_LOCK_TIMEOUT_MS ?? 10000),
      idle_in_transaction_session_timeout: 30000,
      ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
  }
  return globalThis.__proplusPool;
}

/**
 * 경로·본문의 잘못된 uuid/날짜("/p/not-a-uuid")는 Postgres 에서 캐스팅 오류로 올라온다.
 * 그건 호출자의 잘못이므로 500 이 아니라 4xx 로 바꾼다 (P-187: 내부 오류와 입력 오류를 구분한다).
 * 22P02 invalid_text_representation · 22007 invalid_datetime_format · 22008 datetime_field_overflow
 */
export function mapInputError(e: unknown): unknown {
  const code = (e as { code?: string })?.code;
  const msg = String((e as Error)?.message ?? "");
  if (code === "22P02" && /type uuid/.test(msg)) return new ApiError(404, "not_found", "resource not found");
  if (code === "22P02" || code === "22007" || code === "22008")
    return new ApiError(400, "invalid_input", "입력값 형식이 올바르지 않습니다.");
  return e;
}

export async function q<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  db: Db = pool(),
): Promise<T[]> {
  try {
    return (await db.query<T>(sql, params)).rows;
  } catch (e) {
    throw mapInputError(e);
  }
}

export async function one<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  db: Db = pool(),
): Promise<T | null> {
  const rows = await q<T>(sql, params, db);
  return rows[0] ?? null;
}

/**
 * 트랜잭션 안에서 fn 을 돌린다. outbox 기록은 **반드시 여기서 받은 client** 로 해야 한다
 * (P-183 / 기술백서 §7: 도메인 쓰기와 이벤트 기록이 같은 트랜잭션이어야 둘이 갈라지지 않는다).
 */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw mapInputError(e);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (globalThis.__proplusPool) {
    await globalThis.__proplusPool.end();
    globalThis.__proplusPool = undefined;
  }
}
