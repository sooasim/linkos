/**
 * P-181 마이그레이션 러너 — **DB 통합**테스트.
 *   수용기준: "advisory lock 으로 동시 실행 안전, 실패 시 롤백" (docs/01_FEATURE_REGISTRY.yaml P-181)
 *
 * 이 파일이 확인하는 것은 두 가지다:
 *   1. 러너의 계약 — 멱등성, 적용 기록, 동시 실행 안전, 실패 시 롤백.
 *   2. **스키마가 의도대로 올라갔는가** — 공개 뷰·트리거·확장이 실제로 존재하는지.
 *      전략 §2 의 비타협 원칙 중 절반(N-4·N-6·N-7·N-9)은 뷰와 트리거에 들어 있다. 그 객체가
 *      사라지거나 이름이 바뀌면 애플리케이션은 조용히 통과하고 원칙만 없어진다. 그래서 이름으로 못 박는다.
 *
 * 로컬에는 Postgres 가 없다(CI 에만 있다). DB 가 없으면 **스위트 전체를 skip** 한다.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, one, q } from "../src/lib/db";
import { MIGRATIONS_DIR, appliedMigrationCount, migrate } from "../src/migrate";

const DB = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;

interface Probe {
  dir: string;
  file: string;
  table: string;
}

const probes: Probe[] = [];

/**
 * 임시 디렉터리에 마이그레이션 한 장을 쓴다.
 *
 * 왜 `proplus/db/migrations` 를 쓰지 않는가: 거기에 파일을 추가하면 실제 스키마가 되고 저장소에 남는다.
 * `migrate(dir)` 가 디렉터리를 인자로 받으므로(러너의 유일한 인자다) 러너의 **행동**은 임시 디렉터리로
 * 전부 검사할 수 있다. 이름에 uuid 를 붙여 같은 DB 에서 반복 실행해도 충돌하지 않게 한다.
 */
async function writeProbe(sql: string): Promise<Probe> {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const table = `proplus_migrate_probe_${id}`;
  // 파일 이름 정렬이 적용 순서다. 9999 로 두면 실제 마이그레이션 뒤에 온다(여기서는 혼자 있으므로 무관).
  const file = `9999_probe_${id}.sql`;
  const dir = await mkdtemp(join(tmpdir(), "proplus-migrate-"));
  await writeFile(join(dir, file), sql.replaceAll("{{table}}", table), "utf8");
  const probe = { dir, file, table };
  probes.push(probe);
  return probe;
}

async function tableExists(name: string): Promise<boolean> {
  // 식별자를 문자열로 넘길 수 있는 조회다 — DDL 처럼 보간할 필요가 없다.
  const row = await one<{ exists: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${name}`]);
  return row?.exists === true;
}

describe.skipIf(!DB)("P-181 마이그레이션 러너 — DB 통합", () => {
  beforeAll(async () => {
    if (!DB) return;
    await migrate();
  }, 60_000);

  afterAll(async () => {
    if (!DB) return;
    for (const p of probes) {
      // 테이블 이름은 이 파일이 만든 `proplus_migrate_probe_<hex>` 뿐이다. DDL 은 파라미터를 받지 못하므로
      // 보간하기 전에 모양을 확인한다(요청 입력이 아니지만 규칙을 예외 없이 지킨다 — ADR-007).
      if (/^proplus_migrate_probe_[0-9a-f]{12}$/.test(p.table)) {
        await q(`DROP TABLE IF EXISTS ${p.table}`);
      }
      await q(`DELETE FROM schema_migrations WHERE name = $1`, [p.file]);
      await rm(p.dir, { recursive: true, force: true });
    }
    await closePool();
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("멱등성과 적용 기록", () => {
    it(
      "두 번 불러도 두 번째는 빈 배열을 돌려준다",
      async () => {
        // beforeAll 이 이미 적용했으므로 여기서는 두 호출 모두 적용할 것이 없다.
        expect(await migrate()).toEqual([]);
        expect(await migrate()).toEqual([]);
      },
      20_000,
    );

    it(
      "적용된 파일 이름이 schema_migrations 에 기록된다",
      async () => {
        const rows = await q<{ name: string; applied_at: Date }>(
          `SELECT name, applied_at FROM schema_migrations ORDER BY name`,
        );
        const applied = new Set(rows.map((r) => r.name));
        expect(applied.has("0001_proplus_core.sql")).toBe(true);

        // 디렉터리의 모든 .sql 이 기록돼 있어야 한다 — 기록되지 않은 파일은 다음 배포에서 다시 돌고,
        // 멱등하지 않은 문장(CREATE TYPE 등)이 있으면 그때 배포가 깨진다.
        const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) expect(applied.has(f), `${f} 가 schema_migrations 에 없다`).toBe(true);

        // P-182 헬스체크가 보고하는 값과 같은 집합을 센다.
        expect(await appliedMigrationCount()).toBe(rows.length);
        expect(rows.every((r) => r.applied_at instanceof Date)).toBe(true);
      },
      20_000,
    );

    it(
      "이미 적용된 파일은 내용이 같아도 다시 실행되지 않는다",
      async () => {
        // 한 번 적용한 뒤 같은 디렉터리로 다시 호출한다. 다시 실행되면 `CREATE TABLE`(IF NOT EXISTS 없음)이
        // 터지므로, 조용히 통과하는 것 자체가 "다시 돌지 않았다"의 증거다.
        const probe = await writeProbe(`CREATE TABLE {{table}} (id integer PRIMARY KEY);`);
        expect(await migrate(probe.dir)).toEqual([probe.file]);
        expect(await migrate(probe.dir)).toEqual([]);
        expect(await tableExists(probe.table)).toBe(true);
      },
      20_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("동시 실행 (advisory lock 727275)", () => {
    it(
      "두 러너를 동시에 호출해도 같은 마이그레이션은 한 번만 적용된다",
      async () => {
        const probe = await writeProbe(`CREATE TABLE {{table}} (id integer PRIMARY KEY);`);

        // 두 호출은 적용 목록을 **락 이전에** 읽으므로 둘 다 "적용해야 한다"고 판단한다.
        // 락을 잡은 뒤 다시 확인하는 코드가 없으면 두 번째가 같은 CREATE TABLE 을 실행해 터진다
        // (그래서 IF NOT EXISTS 를 쓰지 않았다 — 중복 적용이 조용히 지나가면 테스트가 무의미해진다).
        const [first, second] = await Promise.all([migrate(probe.dir), migrate(probe.dir)]);

        // 둘 중 하나만 ran 을 돌려준다.
        expect([...first, ...second]).toEqual([probe.file]);

        const rows = await q(`SELECT name FROM schema_migrations WHERE name = $1`, [probe.file]);
        expect(rows).toHaveLength(1);
        expect(await tableExists(probe.table)).toBe(true);
      },
      30_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("실패 시 롤백 (한 파일 = 한 트랜잭션)", () => {
    it(
      "중간에 실패하면 앞선 문장도 되돌려지고 적용 기록도 남지 않는다",
      async () => {
        const probe = await writeProbe(
          // 첫 문장은 성공하고 두 번째가 실패한다. 파일 전체가 한 트랜잭션이므로 테이블이 남으면 안 된다.
          `CREATE TABLE {{table}} (id integer PRIMARY KEY);\nSELECT 1/0;\n`,
        );

        await expect(migrate(probe.dir)).rejects.toThrow(new RegExp(`migration ${probe.file} failed`));

        expect(await tableExists(probe.table)).toBe(false);
        expect(await q(`SELECT name FROM schema_migrations WHERE name = $1`, [probe.file])).toHaveLength(0);

        // 실패가 러너를 망가뜨리지 않는다: 실제 스키마는 그대로 적용된 상태로 남아 있다.
        expect(await migrate()).toEqual([]);
      },
      20_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("스키마가 의도대로 올라갔다 (N-4 · N-6 · N-7 · N-9 의 강제 수단)", () => {
    it(
      "공개 조회 뷰 4개가 존재한다 (N-4 / ADR-002)",
      async () => {
        const views = (await q<{ viewname: string }>(`SELECT viewname FROM pg_views WHERE schemaname = 'public'`)).map(
          (r) => r.viewname,
        );
        // 공개 조회는 이 뷰만 거친다 — 뷰에 없는 컬럼은 공개될 길이 없다.
        for (const v of ["public_profile_view", "public_badge_view", "public_metric_view", "public_offer_view"]) {
          expect(views, `${v} 가 없다`).toContain(v);
        }
      },
      20_000,
    );

    it(
      "감사로그·검증·배지 트리거가 존재한다 (N-6 / N-7 / N-1)",
      async () => {
        const triggers = (
          await q<{ tgname: string; relname: string }>(
            `SELECT t.tgname, c.relname
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE NOT t.tgisinternal AND n.nspname = 'public'`,
          )
        ).map((r) => `${r.relname}.${r.tgname}`);

        // 애플리케이션이 깜빡해도 깨지지 않아야 하는 것들이다 (0001 의 "트리거" 절).
        for (const t of [
          "audit_logs.audit_logs_no_update",
          "audit_logs.audit_logs_no_delete",
          "verifications.verifications_audit_ins",
          "badges.badges_require_verified_trg",
        ]) {
          expect(triggers, `${t} 가 없다`).toContain(t);
        }
      },
      20_000,
    );

    it(
      "확장 3개가 설치돼 있다 (P-122 배타제약 · P-150 검색 폴백 · uuid 생성)",
      async () => {
        const exts = (await q<{ extname: string }>(`SELECT extname FROM pg_extension`)).map((r) => r.extname);
        for (const e of ["btree_gist", "pg_trgm", "pgcrypto"]) {
          expect(exts, `${e} 확장이 없다`).toContain(e);
        }
      },
      20_000,
    );

    it(
      "참조 데이터(정책 버전·요금제·증거 유형)가 들어 있다",
      async () => {
        // 검증·동의 레코드가 가리키는 policy_version 과 배지 라벨의 출처다. 비어 있으면
        // 애플리케이션이 FK·NOT NULL 로 실패한다 — 그 실패를 배포 시점이 아니라 여기서 본다.
        const counts = await one<{ policies: string; plans: string; types: string }>(
          `SELECT (SELECT count(*) FROM policy_versions)::text AS policies,
                  (SELECT count(*) FROM plans)::text AS plans,
                  (SELECT count(*) FROM evidence_types)::text AS types`,
        );
        expect(Number(counts!.policies)).toBeGreaterThanOrEqual(4);
        expect(Number(counts!.plans)).toBeGreaterThanOrEqual(3);
        expect(Number(counts!.types)).toBeGreaterThanOrEqual(8);

        // 소속·자격 배지는 발급기관 확인을 요구한다 (기획서 §7).
        const affiliation = await one<{ min_method: string; requires_issuer: boolean; default_ttl_days: number | null }>(
          `SELECT min_method, requires_issuer, default_ttl_days FROM evidence_types WHERE code = 'affiliation'`,
        );
        expect(affiliation).not.toBeNull();
        expect(affiliation!.min_method).toBe("issuer_confirmed");
        expect(affiliation!.requires_issuer).toBe(true);
      },
      20_000,
    );
  });
});
