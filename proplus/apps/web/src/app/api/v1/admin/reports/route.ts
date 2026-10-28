/**
 * P-167 신고 접수 · P-170 신고 큐.
 *
 * ⚠ **POST 는 일반 사용자 경로다.** 경로가 `/admin` 아래인데 관리자 전용이 아닌 이유:
 * 모듈 `admin.createReport()` 가 M12(Trust & Safety)의 함수이고, 이 영역에 배정된 경로가 여기뿐이다.
 * `report.handle` 능력을 요구하면 **신고 큐에 아무것도 들어오지 못한다** — 신고는 당사자가 아닌
 * 제3자가 올리는 것이고, 그 사람은 검증자가 아니다(P-167). 남용은 로그인 + rate limit 으로 막는다.
 *
 * 그래서 두 가지를 기억해야 한다:
 *  1) 나중에 `/api/v1/admin/**` 를 미들웨어·nginx 로 일괄 차단하면 **신고 접수가 조용히 끊긴다.**
 *     그때는 사용자용 별칭(`POST /api/v1/reports`)을 먼저 만들고 이 POST 를 옮겨야 한다.
 *  2) GET(큐)은 `report.handle` 을 요구한다 — 같은 경로의 두 메서드가 서로 다른 자격을 쓴다.
 */

import { admin } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

/** `reports.subject_type` CHECK 제약과 같은 집합이다 (0001_proplus_core.sql). */
const Body = z.object({
  subjectType: z.enum(["profile", "badge", "offer", "lead"]),
  subjectId: z.uuid(),
  reasonCode: z.string().min(2).max(60),
  detail: z.string().max(2000).nullish(),
});

export const GET = route(async ({ ctx, req }) => ({
  items: await admin.reportQueue(ctx, req.nextUrl.searchParams.get("status") ?? "open"),
}));

export const POST = route(async ({ ctx, body }) => admin.createReport(ctx, parse(Body, body)), { status: 201 });
