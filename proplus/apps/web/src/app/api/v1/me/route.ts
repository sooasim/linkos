/**
 * P-009 현재 로그인 주체 — `GET /api/v1/me`
 * P-011 계정 삭제 요청 — `DELETE /api/v1/me`
 *
 * 역할·소속은 `identity.principalFor()` 가 DB 에서 조립한 **사실**이고, 화면이 그걸로 권한을
 * 판정하지 않는다 (CLAUDE.md §3: UI 는 서버가 걸러 준 것만 그린다). 여기서 돌려주는 이유는
 * "운영 콘솔 메뉴를 보여줄지" 같은 **표시** 판단에 필요하기 때문이고, 실제 차단은 각 API 가 한다.
 *
 * 이메일·전화를 넣지 않는다: 워크스페이스 화면에 필요하지 않고, 응답마다 연락처를 실어 보내면
 * 로그·프록시·캐시에 PII 가 퍼진다 (N-13). 본인 데이터 전체는 `GET /me/export`(P-010) 경로다.
 */

import { identity, profile } from "@proplus/api";
import { NextResponse } from "next/server";
import { clearSession, route } from "@/lib/server";

export const GET = route(async ({ ctx }) => {
  const [principal, mine] = await Promise.all([identity.principalFor(ctx.userId), profile.getMyProfile(ctx)]);
  return {
    userId: ctx.userId,
    platformRole: principal.platformRole,
    memberships: principal.memberships,
    // null 을 그대로 돌려주면 래퍼가 `{ok:true}` 로 바꿔 버린다(`out ?? {ok:true}`). 객체로 감싼다.
    profile: mine,
  };
});

/**
 * P-011: 삭제 **요청**이다. 실제 파기는 보존기간이 확정된 뒤 워커가 한다(모듈 주석의 TODO(P-199)).
 * 모듈이 이미 전체 세션을 폐기하므로 쿠키도 함께 비운다 — 죽은 쿠키를 30일 들고 있을 이유가 없다.
 */
export const DELETE = route(async ({ ctx }) => {
  const out = await identity.requestAccountDeletion(ctx);
  return clearSession(NextResponse.json(out));
});
