/**
 * PROPLUS 서버 간 API 키 — `docs/05_LINKOS_INTEGRATION.md` §3 의 세 번째 겹 (ADR-012).
 *
 * LINKOS 가 `Authorization: Bearer pp_<prefix>_<secret>` 로 `ext/badges/lookup` 을 부른다.
 * 0003 의 `api_keys` 테이블은 LINKOS 의 같은 이름 테이블과 **같은 모양**이다(해시 저장·스코프·폐기·만료) —
 * 같은 설계를 두 번 발명하지 않고, 운영자가 두 제품에서 같은 방식으로 키를 다루게 하려는 것이다.
 * 그렇다고 코드를 공유하지는 않는다: `@proplus/*` 는 `@linkos/*` 를 import 하지 않는다(05 §4).
 *
 * **왜 lib 이고 modules 가 아닌가:** 이것은 인증 수단이지 업무 모듈이 아니다. `modules/*` 는
 * 기술백서 §2 의 11개 경계로 고정돼 있고(architecture.test.ts), 인증은 그 경계 밖에서
 * 여러 모듈이 쓰는 공통 관문이다 — `lib/limits.ts`·`lib/audit.ts` 와 같은 자리다.
 *
 * 계층 규칙(전략 §3): 여기서 HTTP 객체를 받지 않는다. 라우트가 헤더 **문자열**만 넘긴다.
 */

import { generateToken, hashToken } from "@proplus/domain";
import { randomBytes } from "node:crypto";
import { writeSystemAudit } from "./audit";
import { one, q } from "./db";
import { ApiError, badRequest } from "./errors";
import { consumeLimit } from "./limits";

/**
 * 이 키로 할 수 있는 일의 전부.
 *
 * 하나뿐인 것이 설계다 — 05 §4 는 오가는 것을 "HTTP 계약 3개"로 못 박았고, 그 중 PROPLUS 가
 * **받는** 것은 배지 조회 하나다. 스코프를 미리 늘려 두면 키 하나가 유출됐을 때 피해 범위가
 * "앞으로 생길 모든 기능"이 된다.
 */
export const PROPLUS_API_SCOPES = ["badges:read"] as const;
export type ProplusApiScope = (typeof PROPLUS_API_SCOPES)[number];

/**
 * 키 형식: `pp_<8자 prefix>_<32~64자 secret>`.
 *
 * 접두사가 `pp_` 인 이유는 LINKOS 의 `lk_` 와 **섞이지 않게** 하려는 것이다. 운영자가 키를
 * 잘못 붙여 넣으면 형식 단계에서 떨어져야 한다 — 해시 조회까지 내려가면 "왜 401 인지" 알 수 없다.
 * prefix 는 비밀이 아니라 로그·UI 에서 어느 키인지 가리키는 이름표다(그래서 DB 에 평문으로 있다).
 */
const KEY_RE = /^pp_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{32,64})$/;

/** 레이트리밋 기본값. 50개씩 분당 60회 = 분당 3000 해시가 상한이다 (05 §3 의 수집 속도 제한). */
const DEFAULT_RATE_PER_MIN = 60;

/**
 * `last_used_at` 갱신 간격.
 *
 * 매 요청 UPDATE 하면 키 한 개에 조회 트래픽만큼의 쓰기가 붙는다(같은 행이라 HOT 업데이트가
 * 쌓이고 autovacuum 을 태운다). 이 컬럼의 용도는 "이 키가 아직 쓰이는가"를 운영자가 보는 것뿐이므로
 * 1분 해상도로 충분하다.
 */
const LAST_USED_REFRESH_MS = 60_000;

/**
 * 인증 실패 메시지는 **한 가지**다.
 *
 * 왜: "그런 키 없음"과 "폐기된 키"를 구분해 주면 키 존재 여부를 알려 주는 오라클이 된다
 * (05 §3 이 이메일에 대해 막으려는 것과 같은 종류의 누출이다). 운영자가 원인을 알아야 하는 쪽은
 * 서버 로그·감사로그이고, 호출자는 "유효하지 않다"만 알면 된다.
 */
const INVALID_KEY_MESSAGE = "유효한 API 키가 필요합니다.";

export interface ProplusApiKeyAuth {
  keyId: string;
  scopes: string[];
}

/**
 * `Authorization` 헤더에서 키 원문을 꺼낸다. 형식이 아니면 null.
 *
 * 성공 시 **키 전체**를 돌려주는 이유: 저장된 값이 `sha256(키 전체)` 이므로 조회에 필요한 것은
 * prefix 가 아니라 전체 문자열이다. prefix 로 먼저 행을 찾아 비교하는 설계도 가능하지만,
 * 그러면 "prefix 로 행이 있는가"가 타이밍으로 드러난다.
 */
export function parseApiKey(header: string | null): string | null {
  if (typeof header !== "string") return null;
  const value = header.replace(/^Bearer\s+/i, "").trim();
  return KEY_RE.test(value) ? value : null;
}

/**
 * 서버 간 호출을 인증한다. 실패는 401(키 문제) 또는 403(스코프 부족)이다.
 *
 * 순서가 설계다:
 *   1. 형식 → 2. 해시 조회 → 3. 폐기·만료 → 4. 스코프 → 5. 레이트리밋 → 6. last_used_at
 *
 * **왜 레이트리밋이 인증 뒤인가:** 앞에 두면 `who` 로 쓸 식별자가 없다. 키 원문이나 prefix 를
 * 버킷 키로 쓰면 임의 문자열로 `rate_limits` 에 행을 무한히 만들 수 있다 — 방어 수단이 증폭
 * 수단이 된다. 인증되지 않은 호출은 DB 쓰기를 전혀 일으키지 않고 떨어지는 쪽이 안전하고,
 * 키 추측 자체는 256bit secret 이 막는다.
 *
 * TODO(05 §3): 버킷 이름 `ext.lookup` 이 `@proplus/domain` 의 `RATE_LIMITS` 에 아직 없어서
 * 보수적 기본값(30/분)으로 판정되고 매 요청 `limits.unknown_bucket` 경고가 남는다.
 * `rateLimit.ts` 담당자가 `"ext.lookup": { limit: 60, windowMs: 60_000 }` 를 등록하면 사라진다.
 */
export async function authenticateApiKey(
  header: string | null,
  needed: ProplusApiScope,
): Promise<ProplusApiKeyAuth> {
  const key = parseApiKey(header);
  if (!key) throw new ApiError(401, "invalid_api_key", INVALID_KEY_MESSAGE);

  const row = await one<{
    id: string;
    scopes: string[];
    revoked_at: Date | null;
    expires_at: Date | null;
    last_used_at: Date | null;
  }>(
    `SELECT id, scopes, revoked_at, expires_at, last_used_at
       FROM api_keys WHERE key_hash = $1`,
    [hashToken(key)],
  );

  const now = Date.now();
  // 없음·폐기·만료를 **한 분기로** 합친다. 분기가 갈리면 응답 시간과 메시지로 구분된다.
  if (!row || row.revoked_at || (row.expires_at && row.expires_at.getTime() <= now)) {
    throw new ApiError(401, "invalid_api_key", INVALID_KEY_MESSAGE);
  }

  const scopes = row.scopes ?? [];
  if (!scopes.includes(needed)) {
    // 403 은 "키는 유효하다"를 알려 주지만, 그건 이미 키를 가진 쪽에게만 보이는 정보다.
    throw new ApiError(403, "insufficient_scope", `이 요청에는 ${needed} scope 가 필요합니다.`);
  }

  await consumeLimit("ext.lookup", row.id);

  if (!row.last_used_at || now - row.last_used_at.getTime() > LAST_USED_REFRESH_MS) {
    await q(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]);
  }

  return { keyId: row.id, scopes };
}

export interface IssuedApiKey {
  /** 평문 키. **이 반환값이 키를 볼 수 있는 유일한 순간이다** — DB 에는 sha256 만 들어간다. */
  key: string;
  prefix: string;
  id: string;
}

/**
 * 키를 발급한다. 호출자는 운영자 CLI(`scripts/issue-api-key.mjs`)다.
 *
 * **키 원문은 저장하지 않는다** (CLAUDE.md §5 / 보안정책 §2). DB 덤프·백업·로그 어디에도
 * 재사용 가능한 값이 남지 않는다는 뜻이고, 그 대가로 "키를 다시 보여 주기"가 불가능하다 —
 * 잃어버리면 폐기하고 새로 발급한다. 그게 올바른 교환이다.
 *
 * `created_by` 를 비우는 이유: 이 경로에는 로그인한 사용자가 없다(CLI). 0003 의 컬럼은 nullable 이고,
 * "누가 발급했나"는 감사로그가 아니라 서버 접근 기록이 답한다 — 없는 사용자를 적는 것보다 비우는 쪽이 정직하다.
 */
export async function issueApiKey(
  label: string,
  scopes: ProplusApiScope[],
  expiresAt?: Date,
): Promise<IssuedApiKey> {
  const trimmed = String(label ?? "").trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    throw badRequest("label_required", "키 라벨을 1~120자로 입력하세요.");
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw badRequest("scopes_required", "scope 를 하나 이상 지정하세요.");
  }
  for (const s of scopes) {
    if (!PROPLUS_API_SCOPES.includes(s)) {
      throw badRequest("unknown_scope", `알 수 없는 scope: ${String(s)}`);
    }
  }
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw badRequest("invalid_expires_at", "만료 시각 형식이 올바르지 않습니다.");
  }

  const prefix = alnumPrefix();
  // secret 은 32바이트(256bit) base64url = 43자 — KEY_RE 의 32~64자 범위 안이다.
  const key = `pp_${prefix}_${generateToken(32)}`;

  const row = await one<{ id: string }>(
    `INSERT INTO api_keys (prefix, key_hash, label, scopes, expires_at)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [prefix, hashToken(key), trimmed, scopes, expiresAt ?? null],
  );
  if (!row) throw new ApiError(500, "api_key_create_failed", "API 키를 발급할 수 없습니다.");

  // 키 발급은 권한을 만드는 행위다 — 감사로그에 남는다 (CLAUDE.md §5).
  // payload 에 키·해시를 넣지 않는다. prefix 는 비밀이 아니고, 그것만으로 어느 키인지 특정된다.
  await writeSystemAudit({
    eventType: "integration.api_key_issued",
    aggregateType: "api_key",
    aggregateId: row.id,
    payload: { prefix, scopes, label: trimmed, expiresAt: expiresAt ? expiresAt.toISOString() : null },
  });

  return { key, prefix, id: row.id };
}

/**
 * prefix 8자. base64 에서 기호를 걷어내고 쓰는 이유는 `KEY_RE` 가 `[A-Za-z0-9]{8}` 이기 때문이다 —
 * prefix 에 `-`·`_` 가 섞이면 secret 부분과의 경계가 모호해진다(`_` 가 구분자다).
 * 24바이트를 뽑아 걸러도 8자가 모자랄 확률은 사실상 0 이지만, 그래도 패딩해서 길이를 보장한다.
 */
function alnumPrefix(): string {
  const alnum = randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "");
  return alnum.slice(0, 8).padEnd(8, "x");
}
