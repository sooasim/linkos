// PROPLUS API 키 발급 CLI — docs/05_LINKOS_INTEGRATION.md §3 / 0003 마이그레이션 ②
//
//   사용: node proplus/scripts/issue-api-key.mjs "LINKOS 연동" badges:read [--days 365]
//
// 왜 화면(관리자 UI)이 아니라 CLI 인가:
//   이 키는 **PROPLUS 전체의 opt-in 프로필 배지를 조회할 수 있는 서버 간 자격**이고,
//   발급 대상은 사용자가 아니라 운영자가 운영하는 다른 서비스다. 웹에 발급 버튼을 두면
//   그 버튼에 도달할 수 있는 모든 역할·세션 탈취 경로가 키 발급 경로가 된다.
//   서버 접근(ssh)과 DATABASE_URL 을 가진 사람으로 한정하는 쪽이 공격 표면이 작다.
//
// 왜 tsx 가 아니라 순수 node 인가:
//   운영 서버에서 돌리는 일회성 도구라 devDependency(tsx)가 없는 환경에서도 떠야 한다.
//   그래서 `@proplus/api` 를 쓰지 않고 pg 를 직접 쓴다 — 대가는 **키 형식과 해시 규칙이
//   두 곳에 존재한다는 것**이고, 그 둘이 어긋나면 발급한 키가 인증되지 않는다.
//   아래 상수는 `services/api/src/lib/apiKeys.ts` 와 같아야 한다(바꿀 때 함께 바꾼다).

import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

/** apiKeys.ts 의 PROPLUS_API_SCOPES 와 같아야 한다. */
const SCOPES = ["badges:read"];

function usage(message) {
  if (message) console.error(`\n오류: ${message}`);
  console.error(`
사용: node proplus/scripts/issue-api-key.mjs "<라벨>" <scope...> [--days N]

  <라벨>   어디에 쓰는 키인지 (예: "LINKOS 연동"). 감사로그와 키 목록에 남는다.
  <scope>  ${SCOPES.join(" | ")}
  --days N 만료일. 생략하면 만료 없음(폐기로만 끝낸다).

환경: DATABASE_URL 또는 PROPLUS_DATABASE_URL (PROPLUS 데이터베이스 — linkos 가 아니다)
`);
  process.exit(message ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) usage();

let days = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--days") {
    const raw = argv[++i];
    days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 3650) usage("--days 는 1~3650 정수여야 한다");
  } else {
    positional.push(a);
  }
}

const label = (positional.shift() ?? "").trim();
if (label.length === 0 || label.length > 120) usage("라벨을 1~120자로 입력하세요");

const scopes = positional.length > 0 ? positional : ["badges:read"];
for (const s of scopes) {
  if (!SCOPES.includes(s)) usage(`알 수 없는 scope: ${s} (가능: ${SCOPES.join(", ")})`);
}

// 전략 §1: PROPLUS 는 LINKOS 와 **다른 데이터베이스**다. 변수 이름을 먼저 확인한다.
const connectionString = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) usage("DATABASE_URL(또는 PROPLUS_DATABASE_URL)이 설정되지 않았다");

// apiKeys.ts 의 KEY_RE: pp_<8자 영숫자>_<32~64자 base64url>
const prefix = randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).padEnd(8, "x");
const key = `pp_${prefix}_${randomBytes(32).toString("base64url")}`;
// CLAUDE.md §5: DB 에는 SHA-256 해시만 들어간다. 평문은 아래 출력이 유일한 사본이다.
const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
const expiresAt = days === null ? null : new Date(Date.now() + days * 86_400_000);

const client = new pg.Client({
  connectionString,
  ssl: /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
});

try {
  await client.connect();
  const { rows } = await client.query(
    `INSERT INTO api_keys (prefix, key_hash, label, scopes, expires_at)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, created_at`,
    [prefix, keyHash, label, scopes, expiresAt],
  );
  const row = rows[0];

  // 키 발급은 권한을 만드는 행위다 — audit_logs 에 남는다 (CLAUDE.md §5).
  // payload 에 키·해시를 넣지 않는다. prefix 만으로 어느 키인지 특정된다.
  await client.query(
    `INSERT INTO audit_logs (event_type, aggregate_type, aggregate_id, payload_minimized)
     VALUES ($1,$2,$3,$4)`,
    [
      "integration.api_key_issued",
      "api_key",
      row.id,
      JSON.stringify({ prefix, scopes, label, via: "cli", expiresAt: expiresAt?.toISOString() ?? null }),
    ],
  );

  console.log(`
발급 완료
  id        ${row.id}
  prefix    ${prefix}
  label     ${label}
  scopes    ${scopes.join(", ")}
  만료      ${expiresAt ? expiresAt.toISOString() : "없음 (폐기로만 끝낸다)"}

  키:  ${key}

  이 값은 **지금 한 번만** 표시된다. DB 에는 sha256 해시만 저장되므로 다시 볼 수 없다
  (잃어버리면 폐기하고 새로 발급한다 — 그게 해시만 저장하는 대가다).

  받는 쪽(LINKOS) 설정:  PROPLUS_API_KEY=${key}
  폐기:  UPDATE api_keys SET revoked_at = now() WHERE id = '${row.id}';
`);
} catch (e) {
  console.error(`\n발급 실패: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
