/**
 * 이메일 해시 디렉터리 조회 — `docs/05_LINKOS_INTEGRATION.md` §3 (ADR-012).
 *
 * LINKOS 가 "내가 아는 이메일의 PROPLUS 검증 배지"를 묻는다. 그 질문을 평문 이메일로 받으면
 * **이메일 존재 확인 오라클**이 된다 — 키를 가진 쪽이 이메일 목록을 넣어 "이 사람이 PROPLUS 에
 * 있는지"를 수집할 수 있다. 05 §3 이 세 겹을 거는 이유이고, 이 파일은 그 중 두 번째 겹
 * (**해시 입력**)의 규칙을 담는다. 나머지 두 겹은 I/O 가 필요하므로 상위 계층에 있다:
 *   소유자 opt-in        → `services/api/src/modules/directory.ts` (public_settings 조건)
 *   API 키·레이트리밋·감사 → `services/api/src/lib/apiKeys.ts`
 *
 * 왜 해시가 "이미 아는 사람"만 통과시키는가: 역상(preimage)을 구할 방법이 전수 대입뿐이고,
 * 솔트가 양쪽 env 에만 있으므로 솔트를 모르는 제3자는 사전을 만들 수도 없다. 즉 조회하려면
 * **정확한 이메일을 이미 알고 있어야** 한다(명함을 교환한 사이라면 안다).
 *
 * 계층 규칙(전략 §3): 이 파일은 I/O 를 하지 않는다. 솔트도 읽지 않고 **인자로 받는다** —
 * 그래야 "솔트가 다르면 해시가 다르다"를 단위테스트로 못 박을 수 있다.
 */

import { createHash } from "node:crypto";

/**
 * 한 번에 물어볼 수 있는 해시 개수 (05 §3 계약: 최대 50개).
 *
 * 상한이 필요한 이유는 성능이 아니라 **수집 속도 제한**이다. 한 요청에 수천 개를 넣을 수 있으면
 * 레이트리밋(분당 N회)이 사실상 무의미해진다 — 겹을 하나 뚫는 셈이다.
 */
export const MAX_LOOKUP_HASHES = 50;

/** sha256 hex 는 소문자 64자다. `createHash(...).digest("hex")` 가 돌려주는 형식 그대로. */
const LOOKUP_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * 05 §3 의 해시 공식: `sha256(lower(trim(email)) + DIRECTORY_SALT)`.
 *
 * 정규화를 여기서 하는 이유: 양쪽이 같은 이메일을 다르게 정규화하면 **아무것도 매칭되지 않고**
 * 그 실패는 조용하다(빈 결과는 "없음"과 구분되지 않는다 — §3 이 없음을 알려 주지 않기로 했으므로).
 * 그래서 공식을 한 함수에 두고 양쪽이 같은 코드 경로를 쓰게 한다.
 *
 * 빈 솔트를 던져서 막는 이유: 솔트가 없으면 해시는 공개된 sha256(email) 이 되고, 공격자가
 * 미리 만들어 둔 사전으로 즉시 역상을 얻는다. 그 순간 두 번째 겹이 사라지는데, 증상은
 * "그래도 잘 동작함"이라 아무도 모른다. 설정 누락은 조용히 약해지는 대신 **시끄럽게 실패**해야 한다.
 */
export function emailLookupHash(email: string, salt: string): string {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("emailLookupHash: 이메일이 비어 있다");
  }
  if (typeof salt !== "string" || salt.length === 0) {
    throw new Error("emailLookupHash: DIRECTORY_SALT 가 없으면 해시가 공개 사전으로 역상 가능해진다 (05 §3)");
  }
  return createHash("sha256").update(`${normalized}${salt}`, "utf8").digest("hex");
}

/** 조회 입력이 sha256 hex 형식인가. 소문자만 통과시킨다 — 대소문자 교정은 `validateLookupRequest` 가 한다. */
export function isLookupHash(v: unknown): v is string {
  return typeof v === "string" && LOOKUP_HASH_RE.test(v);
}

export interface LookupRequestOk {
  ok: true;
  /** 정규화·중복 제거된 해시. 입력 순서를 유지한다(응답을 읽는 쪽이 대조하기 쉽다). */
  hashes: string[];
}

export interface LookupRequestError {
  ok: false;
  code: string;
  message: string;
}

/**
 * `POST /api/v1/ext/badges/lookup` 본문 검증 (05 §3 계약: `{ "emailHashes": [...] }`).
 *
 * 형식에는 **엄격**하고 표기에는 **관대**하다: 공백과 대문자 hex 는 교정하고(호출부 구현 차이로
 * 전부 실패하는 쪽이 더 나쁘다), 64자 hex 가 아닌 값은 거부한다. 평문 이메일이 실수로 들어오는
 * 경우를 여기서 잡아야 한다 — 통과시키면 매칭은 안 되지만 **평문 이메일이 서버 로그에 남는다**(N-13).
 *
 * 중복을 제거하는 이유: 같은 해시 50개를 넣어 상한을 우회하려는 시도를 막고(실질 상한이 유지된다),
 * 응답에 같은 항목이 두 번 들어가지 않게 한다.
 */
export function validateLookupRequest(input: unknown): LookupRequestOk | LookupRequestError {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "invalid_body", message: "요청 본문은 객체여야 합니다." };
  }

  const raw = (input as { emailHashes?: unknown }).emailHashes;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, code: "email_hashes_required", message: "emailHashes 에 1개 이상의 해시가 필요합니다." };
  }
  // 중복 제거 **전에** 센다. 뒤에 세면 같은 해시를 반복해 넣어 요청 크기 제한을 우회할 수 있다.
  if (raw.length > MAX_LOOKUP_HASHES) {
    return {
      ok: false,
      code: "too_many_hashes",
      message: `한 번에 조회할 수 있는 해시는 ${MAX_LOOKUP_HASHES}개까지입니다.`,
    };
  }

  const seen = new Set<string>();
  const hashes: string[] = [];
  for (const item of raw) {
    const normalized = typeof item === "string" ? item.trim().toLowerCase() : null;
    if (normalized === null || !isLookupHash(normalized)) {
      // 어느 원소가 틀렸는지 알려 주지 않는다 — 값 자체가 조회 대상이므로 에러 메시지에 되비추지 않는다.
      return {
        ok: false,
        code: "invalid_email_hash",
        message: "emailHashes 의 각 항목은 sha256 hex(64자)여야 합니다.",
      };
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    hashes.push(normalized);
  }

  return { ok: true, hashes };
}
