/**
 * 토큰 생성·대조 — P-001(매직링크), P-002(세션 쿠키), P-081(조직 초대).
 *
 * 근거: 루트 CLAUDE.md §3 / 보안정책 §2 "계정 탈취".
 *   - 길이 ≥128bit 랜덤
 *   - **DB 에는 SHA-256 해시만** 저장 (sessions.token_hash, login_tokens.token_hash,
 *     org_invites.token_hash 가 모두 `token_hash`인 이유)
 *   - 토큰 자체에 PII 를 담지 않는다 (그래서 랜덤 바이트다 — JWT 가 아니다)
 *
 * 왜 JWT 가 아닌가: 세션 즉시 무효화(P-003)가 요구사항이다. 자체 검증형 토큰은
 * 서버가 폐기 목록을 따로 들고 있어야 하므로 "DB 조회 없는 검증"이라는 장점이 사라진다.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 128bit. CLAUDE.md §3 의 하한이고, 이 아래로는 생성 자체를 막는다. */
export const MIN_TOKEN_BYTES = 16;

/** 기본 32바이트(256bit) = base64url 43자. URL·쿠키에 그대로 담을 수 있다. */
export const DEFAULT_TOKEN_BYTES = 32;

/**
 * 추측 불가능한 토큰을 만든다. base64url 이므로 URL·쿠키·헤더에 인코딩 없이 들어간다.
 *
 * 하한을 던져서 막는 이유: "짧게 하면 링크가 예뻐진다"는 요구가 반드시 들어오고,
 * 그때 조용히 깎이면 매직링크 전수 대입이 가능해진다 (보안정책 §2).
 */
export function generateToken(bytes: number = DEFAULT_TOKEN_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < MIN_TOKEN_BYTES) {
    throw new Error(`토큰은 최소 ${MIN_TOKEN_BYTES}바이트(128bit)여야 한다 (CLAUDE.md §3)`);
  }
  return randomBytes(bytes).toString("base64url");
}

/** DB 에 저장할 값. 평문 토큰이 유출 경로(백업·덤프·로그)에 남지 않게 하는 유일한 수단이다. */
export function hashToken(t: string): string {
  return createHash("sha256").update(t, "utf8").digest("hex");
}

/**
 * 타이밍 공격에 안전한 문자열 비교.
 *
 * 길이를 먼저 비교하지 않고 **양쪽을 해시한 뒤** 비교하는 이유:
 * 길이 분기는 그 자체로 토큰 길이를 흘리고, 해시는 항상 32바이트라 입력 길이와 무관하게
 * 같은 시간이 걸린다.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
