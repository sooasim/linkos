/**
 * P-073 증거 원본 다운로드 링크 발급 (보안정책 §2 "증빙 파일 유출" · N-5).
 *
 * **파일 바이트를 이 라우트로 흘리지 않는다.** 여기서 하는 일은 60초 만료 서명 URL 을 발급하는 것뿐이고,
 * 발급 자체가 매번 감사로그로 남는다. 바이트는 서명이 붙은 저장소 경로에서만 나온다.
 *
 * 접근 목적(`accessPurpose`)은 **필수**다 (P-165 · 기술백서 §5 "운영자 접근은 목적·승인·시간 제한·감사로그").
 * 목적 없는 조회를 허용하면 감사로그가 "누가 열었다"만 남기고 "왜"를 잃어 정기 접근검토가 불가능해진다.
 * 당사자 본인에게도 요구한다 — 모듈이 그렇게 판정하고, 라우트는 값을 전달만 한다.
 *
 * 헤더(`x-access-purpose`)를 쿼리(`?purpose=`)보다 먼저 보는 이유: 쿼리스트링은 nginx 접근로그와
 * Referer 에 남는다. 두 경로를 모두 받지만 운영 도구는 헤더를 쓰도록 이 순서로 못 박는다.
 */

import { proof } from "@proplus/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params, req }) => {
  const purpose = req.headers.get("x-access-purpose") ?? req.nextUrl.searchParams.get("purpose") ?? "";
  const issued = await proof.downloadFile(ctx, params.id, purpose);

  // 서명 URL 은 상대 경로다(`lib/storage.ts`의 STORAGE_SIGNED_URL_PREFIX). 리다이렉트에는 절대 URL 이 필요하다.
  const absolute = new URL(issued.url, req.nextUrl.origin).toString();
  const wantsRedirect = req.nextUrl.searchParams.get("redirect") === "1";

  const res = wantsRedirect
    ? NextResponse.redirect(absolute, 302)
    : NextResponse.json({ ...issued, url: absolute });

  // TTL 이 60초인 링크가 Referer 로 새어 나가면 짧은 만료의 의미가 사라진다 (보안정책 §2).
  // next.config.ts 의 no-referrer 규칙은 `/api/v1/evidence/*` 만 덮으므로 이 경로에서 직접 붙인다.
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("cache-control", "no-store");
  return res;
});
