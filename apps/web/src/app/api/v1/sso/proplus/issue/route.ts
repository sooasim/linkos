import { badRequest, notFound, proplusSso } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// PROPLUS 연동 — proplus/docs/05_LINKOS_INTEGRATION.md §1
// 로그인된 LINKOS 사용자의 신원을 PROPLUS 로 한 번 넘긴다. route() 가 세션을 풀고
// 비로그인이면 401 을 준다(apps/web/src/lib/server.ts).
const input = z.object({
  redirectUri: z.string().min(1).max(2048),
  // PROPLUS 가 발급해 자기 httpOnly 쿠키에 둔 CSRF state. 우리는 **해석하지 않고 되돌려만 준다**.
  state: z.string().min(1).max(256),
});

export const POST = route(async ({ ctx, body }) => {
  // 꺼져 있을 때 503 이 아니라 404 인 이유: 설정되지 않은 연동은 이 배포에 존재하지 않는 엔드포인트처럼 보여야 한다.
  if (!proplusSso.proplusSsoEnabled()) throw notFound("endpoint");
  const { redirectUri, state } = parse(input, body);
  // 오픈 리다이렉트 차단 — assertion 은 베어러 자격증명이므로 목적지를 틀리면 신원이 남에게 넘어간다.
  if (!proplusSso.isAllowedRedirect(redirectUri)) throw badRequest("bad_redirect", "허용되지 않은 이동 주소입니다.");
  const assertion = await proplusSso.issueAssertion(ctx, ctx.userId!);
  return { redirectTo: proplusSso.redirectWithAssertion(redirectUri, assertion, state) };
});
