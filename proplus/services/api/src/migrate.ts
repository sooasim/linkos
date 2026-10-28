// P-181 마이그레이션 러너 (수용기준: advisory lock 으로 동시 실행 안전, 실패 시 롤백).
//
// 왜 러너를 직접 쓰는가: 스키마를 생SQL 로 운영하기로 했고(전략 §6 — 공개/비공개 경계를 뷰·트리거로 강제한다)
// 그 결정에 맞는 러너는 "파일 이름 정렬 + 한 파일 = 한 트랜잭션 + 적용 기록" 세 가지뿐이다.
//
// advisory lock 키는 **727275** 다. LINKOS 가 727274 를 쓰므로 두 제품의 배포가 겹쳐도 서로를 기다리지 않는다
// — 다만 PROPLUS 는 별도 데이터베이스이므로(전략 §1) 실제 경합은 PROPLUS 인스턴스끼리만 일어난다.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, pool } from "./lib/db";

const here = dirname(fileURLToPath(import.meta.url));
/** `proplus/db/migrations` — 루트 `db/migrations`(LINKOS) 가 아니다. 섞이면 다른 제품의 스키마를 적용한다. */
export const MIGRATIONS_DIR = resolve(here, "../../../db/migrations");

export const MIGRATION_LOCK = 727275;

export async function migrate(dir = MIGRATIONS_DIR): Promise<string[]> {
  const db = pool();
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(join(dir, f), "utf8");
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      // 트랜잭션 스코프 락: 동시에 뜬 두 인스턴스 중 하나만 적용하고, 롤백되면 락도 함께 풀린다.
      await c.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      // 락을 기다리는 동안 상대가 적용했을 수 있으므로 **락을 잡은 뒤 다시** 확인한다.
      const again = await c.query("SELECT 1 FROM schema_migrations WHERE name=$1", [f]);
      if (again.rowCount === 0) {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
        ran.push(f);
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    } finally {
      c.release();
    }
  }
  return ran;
}

/** P-182 헬스체크가 보고하는 적용 개수. */
export async function appliedMigrationCount(): Promise<number> {
  const r = await pool().query<{ n: string }>("SELECT count(*)::text AS n FROM schema_migrations");
  return Number(r.rows[0]?.n ?? 0);
}

// CLI 실행 감지. import 되었을 때는 아무것도 하지 않는다(테스트가 migrate() 를 직접 호출한다).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .then((ran) => {
      console.log(ran.length ? `applied: ${ran.join(", ")}` : "database up to date");
      return closePool();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
