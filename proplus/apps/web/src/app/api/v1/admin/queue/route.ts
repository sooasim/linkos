/**
 * P-160 검증 검토 큐 (모듈명세 M12 · 06_개발로드맵 §3).
 *
 * 응답에 이름·연락처가 없는 것은 모듈의 설계다: 큐는 "무엇을 처리해야 하는가"를 보여 주는 화면이고,
 * 누구인지가 필요한 순간은 `GET /admin/evidence/{id}` 이며 그 호출은 목적과 함께 감사로그에 남는다(P-165).
 *
 * `?status=` 는 쉼표 목록이다. 생략하면 모듈이 대기 집합(submitted·under_review·needs_more_info)을 쓴다 —
 * 라우트가 기본값을 따로 정하면 `evidence_queue_idx` 부분 인덱스와 두 벌이 된다.
 */

import { admin } from "@proplus/api";
import { PROOF_STATUSES } from "@proplus/domain";
import { z } from "zod";
import { route } from "@/lib/server";

const Query = z.object({
  status: z.array(z.enum(PROOF_STATUSES)).min(1).optional(),
  evidenceType: z.string().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const GET = route(async ({ ctx, req }) => {
  const sp = req.nextUrl.searchParams;
  const raw = sp.get("status");
  const filter = Query.parse({
    // 알 수 없는 상태를 조용히 버리지 않는다 — 오타는 "빈 큐"가 아니라 400 으로 드러나야 한다.
    status: raw ? raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : undefined,
    evidenceType: sp.get("type") ?? undefined,
    limit: sp.get("limit") ?? undefined,
    offset: sp.get("offset") ?? undefined,
  });
  return admin.reviewQueue(ctx, filter);
});
