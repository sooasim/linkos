/**
 * P-150 전문가 검색 · P-151 검증 상태 필터 · P-152 유료 노출 구분 · P-153 랭킹 근거 공개.
 *
 * `auth: false` 다. 검색은 비회원 경로이고, 권한에 따라 결과가 달라지지 않는다 —
 * `public_profile_view` 가 이미 경계다(ADR-005).
 *
 * ## N-15 — 응답을 재조립하지 않는다
 *
 * 모듈 응답에는 결과마다 `placement` 와 `rankingBasis[]` 가 있고, 그 밖에 `promoted`(유료 노출 자리,
 * 현재 항상 빈 배열)·`dropped`(근거를 만들 수 없어 버린 행 수)·`basis`(정렬·엔진·근거 코드 집합)가
 * 있다. **전부 그대로 싣는다.** 라우트가 `results` 만 꺼내면 "유료 노출이 일반 결과와 구분되고
 * 랭킹 근거가 공개된다"는 약속이 응답에서 사라진다. 두 배열을 하나로 합치는 것도 금지다.
 *
 * ## rate limit (P-189)
 *
 * `consumeLimit('search', ip)` — 60/1m. 모듈은 한도를 걸지 않는다(요청 주체를 모른다). 검색은
 * 공개·무인증 경로 중 가장 비싼 질의(trigram 유사도 + 배지 집계)라 라우트가 반드시 걸어야 한다.
 */

import { consumeLimit, search } from "@proplus/api";
import { route } from "@/lib/server";

/** `?verifiedOnly=1` / `=true` 만 참으로 본다. 값이 없으면 undefined — 모듈이 기본값을 정한다. */
function boolParam(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  return v === "1" || v.toLowerCase() === "true";
}

function intParam(v: string | null): number | undefined {
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  // 범위 조정(clamp)은 모듈이 한다. 여기서는 "숫자가 아니면 안 보낸다"까지만.
  return Number.isFinite(n) ? n : undefined;
}

export const GET = route(
  async ({ req, ctx }) => {
    await consumeLimit("search", ctx.ip);

    const sp = req.nextUrl.searchParams;
    // 반복 파라미터를 쓴다(`?specialty=a&specialty=b`). 콤마 분리는 값 자체에 콤마가 들어오면 깨진다.
    // 정규화·중복 제거·개수 제한은 모듈의 `normalizeList()` 가 한다.
    return search.searchProfiles({
      q: sp.get("q"),
      specialties: sp.getAll("specialty"),
      region: sp.get("region"),
      verifiedOnly: boolParam(sp.get("verifiedOnly")),
      badgeTypes: sp.getAll("badgeType"),
      limit: intParam(sp.get("limit")),
      offset: intParam(sp.get("offset")),
    });
  },
  { auth: false },
);
