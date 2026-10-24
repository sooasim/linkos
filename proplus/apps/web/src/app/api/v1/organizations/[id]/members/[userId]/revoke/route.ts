// P-084: 소속 취소 (데이터모델 §4 — `POST /organizations/{id}/members/{userId}/revoke`).
//
// 사유를 필수 본문으로 받는 이유: 이 행위는 상대방의 공개 배지를 즉시 만료시킨다. 되돌릴 수 없는 영향이
// 있는 조치는 감사로그에 "왜"가 남아야 이의제기(M11)에서 재구성할 수 있다 (보안정책 §3).

import { org } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const uuid = z.uuid();

const revokeInput = z.strictObject({ reason: z.string().min(1).max(300) });

export const POST = route<{ id: string; userId: string }>(async ({ ctx, params, body }) =>
  org.revokeMembership(ctx, uuid.parse(params.id), uuid.parse(params.userId), parse(revokeInput, body).reason),
);
