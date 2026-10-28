/**
 * `POST /api/v1/ext/badges/lookup` — LINKOS → PROPLUS 배지 조회.
 * 계약: `docs/05_LINKOS_INTEGRATION.md` §3 (ADR-012).
 *
 * `/ext/*` 는 **서버 간** 경로다. 세션 쿠키가 아니라 API 키로 인증하므로 `auth: false` 로 두고
 * 핸들러가 직접 `authenticateApiKey()` 를 부른다. 브라우저에서 부를 일이 없고, Origin 이 없는
 * 서버 호출은 `route()` 의 CSRF 검사를 그대로 통과한다(`isAllowedOrigin` 주석 참조).
 *
 * 라우트가 하는 일은 셋뿐이다(전략 §3 "라우트는 얇은 어댑터"):
 *   ① 키 인증 → ② 본문 검증(도메인 순수 함수) → ③ 모듈 호출 + 감사로그.
 * 조회 규칙·opt-in 판정·배지 필터는 전부 모듈과 도메인에 있다.
 */

import { directory, authenticateApiKey, writeSystemAudit, ApiError } from "@proplus/api";
import { validateLookupRequest } from "@proplus/domain";
import { route } from "@/lib/server";

export const POST = route(
  async ({ req, ctx, body }) => {
    const auth = await authenticateApiKey(req.headers.get("authorization"), "badges:read");

    // zod 를 쓰지 않는 이유: 이 본문의 규칙(해시 형식·개수 상한·중복 제거)이 곧 05 §3 의
    // 프라이버시 겹이고, 그래서 단위테스트가 붙은 도메인 순수 함수에 두었다. 같은 규칙을
    // 스키마로 한 번 더 적으면 두 곳이 어긋날 수 있다.
    const parsed = validateLookupRequest(body);
    if (!parsed.ok) throw new ApiError(400, parsed.code, parsed.message);

    const evaluatedAt = new Date();
    const results = await directory.lookupBadgesByEmailHash(parsed.hashes, evaluatedAt);

    /**
     * 누가 얼마나 조회했는지 남긴다 (05 §3 의 세 번째 겹).
     *
     * **해시를 payload 에 넣지 않는다** (N-13). 이메일 해시는 평문이 아니지만 솔트를 아는 쪽에는
     * 사전 대조가 가능한 지문이고, 감사로그는 보존기간이 긴 사본이다. 운영자가 알아야 하는 것은
     * "이 키가 몇 건을 물었고 몇 건이 맞았나"이며, 그건 개수로 전부 답한다.
     */
    await writeSystemAudit({
      eventType: "integration.badge_lookup",
      aggregateType: "api_key",
      aggregateId: auth.keyId,
      payload: { requested: parsed.hashes.length, matched: results.length },
      correlationId: ctx.requestId,
    });

    return {
      results,
      // 05 §3: 이 배지들이 어디서 나왔는지 호출자가 알아야 한다. LINKOS 는 "출처 PROPLUS" 와
      // 확인일을 함께 그려야 하고(P-058), `evaluatedAt` 은 만료를 **읽기 시점에** 판정했다는 근거다(N-9).
      basis: { source: "public_badge_view", evaluatedAt: evaluatedAt.toISOString() },
    };
  },
  { auth: false },
);
