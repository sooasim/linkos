/**
 * P-161 / P-165 증거 상세 (검증 콘솔 전용).
 *
 * **접근 목적이 없으면 400 이다.** 이 응답에는 당사자 이름·지역·증거 주장·내부 메모가 들어 있고,
 * 기술백서 §5 는 운영자 접근에 "목적·승인·시간 제한·감사로그"를 요구한다. 목적은 모듈이 감사로그에
 * `access_purpose` 로 남긴다 — 그래서 라우트는 목적을 **전달**만 하고 판정하지 않는다.
 *
 * 헤더(`x-access-purpose`)를 쿼리(`?purpose=`)보다 먼저 본다: 쿼리스트링은 nginx 접근로그와
 * Referer 에 남으므로, 목적 문구(사건번호·담당자 메모가 섞일 수 있다)를 거기 두는 것을 권하지 않는다.
 *
 * 응답에 `object_key` 는 없다. 증거 원본을 여는 경로는 `GET /api/v1/files/{fileId}` 하나다(N-5).
 */

import { admin } from "@proplus/api";
import { route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params, req }) => {
  const purpose = req.headers.get("x-access-purpose") ?? req.nextUrl.searchParams.get("purpose") ?? "";
  return admin.evidenceDetail(ctx, params.id, purpose);
});
