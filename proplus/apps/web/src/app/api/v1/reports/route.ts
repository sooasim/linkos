/**
 * P-167 신고 접수 — **사용자용 경로.**
 *
 * `/api/v1/admin/reports` 의 POST 와 같은 일을 한다. 왜 별칭을 따로 두는가:
 *   신고는 제3자(검증자가 아닌 일반 사용자)가 올리는 것이다. 그런데 그 POST 가 `/admin/**` 아래
 *   있으면, 나중에 누가 nginx·미들웨어에서 `/api/v1/admin/**` 를 운영자 IP 로 제한하는 순간
 *   **신고 접수가 조용히 끊긴다** — 404·403 이 아니라 "아무도 신고하지 않는다"로 보인다.
 *   경로 이름이 권한을 암시해야 그런 사고가 안 난다.
 *
 * `/admin/reports` 의 POST 는 호환을 위해 남겨 둔다(이미 붙은 클라이언트가 있을 수 있다).
 * 새 클라이언트는 이 경로를 쓴다.
 */

import { admin, consumeLimit } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

/** `reports.subject_type` CHECK 제약과 같은 집합이다 (0001_proplus_core.sql). */
const Body = z.object({
  subjectType: z.enum(["profile", "badge", "offer", "lead"]),
  subjectId: z.uuid(),
  reasonCode: z.string().min(2).max(60),
  detail: z.string().max(2000).nullish(),
});

export const POST = route(
  async ({ ctx, body }) => {
    // P-167: 표적 신고로 운영 큐를 막는 것을 막는다 (rateLimit.ts 의 'report.create' 참조).
    // 로그인 사용자 기준이라 IP 를 바꿔도 우회되지 않는다.
    await consumeLimit("report.create", ctx.userId ?? ctx.ip);
    return admin.createReport(ctx, parse(Body, body));
  },
  { status: 201 },
);
