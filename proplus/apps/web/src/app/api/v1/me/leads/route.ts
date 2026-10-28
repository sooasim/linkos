// P-103: 권한 내 리드 조회 (데이터모델 §4 — `GET /me/leads`).
//
// 목록은 원문 연락처를 복호화하지 않는다 — 모듈이 마스킹 컬럼만 SELECT 한다 (P-102).
// 소유자/담당자/조직 관리자 경계도 모듈의 `scopeSql()` 이 긋는다. 라우트는 필터 입력만 검증한다.

import { lead } from "@proplus/api";
import { LEAD_STAGES } from "@proplus/domain";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/server";

/**
 * 쿼리스트링은 `strictObject` 를 쓰지 않는다. 캐시 무효화용 파라미터 같은 군더더기가 붙는 일이 흔하고,
 * 모르는 키 때문에 목록이 400 이 되는 것은 과하다. 반대로 JSON 본문은 strict 다 —
 * 거기서 모르는 키는 "클라이언트가 설정했다고 믿는데 서버는 무시한다"는 뜻이라 조용히 넘기면 안 된다.
 */
const listQuery = z.object({
  profileId: z.uuid().optional(),
  stage: z.enum(LEAD_STAGES).optional(),
  assignedTo: z.uuid().optional(),
  organizationId: z.uuid().optional(),
  // 날짜 파싱·거부는 모듈(`toDate`)이 한다. 형식을 두 곳에서 정의하면 경계값이 갈린다.
  from: z.string().min(4).max(40).optional(),
  to: z.string().min(4).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** 빈 값(`?stage=`)은 "필터 없음"이다. 그대로 넘기면 uuid·enum 검증에서 400 이 된다. */
function nonEmptyQuery(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of req.nextUrl.searchParams) {
    if (value !== "") out[key] = value;
  }
  return out;
}

export const GET = route(async ({ ctx, req }) => ({
  leads: await lead.listLeads(ctx, listQuery.parse(nonEmptyQuery(req))),
}));
