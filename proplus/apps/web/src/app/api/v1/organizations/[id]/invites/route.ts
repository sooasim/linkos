// P-082: 직원 초대 (데이터모델 §4 — `POST /organizations/{id}/invites`).
//
// 응답에 평문 초대 토큰과 수락 URL 이 들어간다. DB 에는 해시만 남고(`org_invites.token_hash`),
// SMTP 가 없는 환경(로컬·CI)에서는 "링크 복사"가 유일한 전달 경로라 한 번은 돌려줘야 한다.
// Idempotency-Key 재생 캐시에 저장될 때도 평문으로 남지 않는다 — `lib/idempotency.ts` 가 응답을 암호화한다.

import { org } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const orgId = z.uuid();

const inviteInput = z.strictObject({
  email: z.string().min(3).max(200),
  // `owner` 는 초대로 만들지 않는다(소유권 이전은 별도 절차여야 추적된다 — modules/org.ts INVITABLE_ROLES).
  // 모듈도 같은 검사를 하지만, 라우트에서 enum 으로 막아야 클라이언트가 400 과 함께 허용값을 받는다.
  role: z.enum(["member", "manager"]).optional(),
});

export const POST = route<{ id: string }>(
  async ({ ctx, params, body }) => {
    const input = parse(inviteInput, body);
    return org.invite(ctx, orgId.parse(params.id), input.email, input.role);
  },
  { status: 201 },
);
