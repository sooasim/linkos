/**
 * P-164 검증자 내부 메모.
 *
 * **여기의 `{id}` 는 검증 id 다** — approve/reject/request-info 의 `{id}`(증거 id)와 다르다.
 * 메모는 "이 판정을 왜 이렇게 했는가"의 기록이므로 판정 행(`verifications`)에 붙어야 하고,
 * 모듈도 `verification_notes.verification_id` 로 저장한다. 검증 id 는
 * `GET /admin/evidence/{id}` 응답의 `verifications[].id` 에서 얻는다.
 *
 * 이 메모는 당사자 조회 경로(`GET /me/evidence/...`)에 **절대 조인되지 않는다**(P-164).
 * 반대로 당사자에게 전할 말은 reject/request-info 의 `message` 다.
 */

import { admin } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Body = z.object({ note: z.string().min(2).max(4000) });

export const POST = route<{ id: string }>(
  async ({ ctx, params, body }) => admin.addReviewerNote(ctx, params.id, parse(Body, body).note),
  { status: 201 },
);
