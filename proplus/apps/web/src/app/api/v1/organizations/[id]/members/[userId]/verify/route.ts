// P-083: 소속 승인 (데이터모델 §4 — `POST /organizations/{id}/members/{userId}/verify`).
//
// 승인은 **소속 사실만** 확정한다. 배지 발급이 여기에 없는 것이 설계다 — 조직이 자기 직원의 검증자가 되는
// 구조를 막기 위해 affiliation 배지는 M04 의 `evidence → verifications` 사슬을 지난다
// (보안정책 §4.4, `modules/org.ts` verifyMembership 주석).

import { org } from "@proplus/api";
import { z } from "zod";
import { route } from "@/lib/server";

const uuid = z.uuid();

export const POST = route<{ id: string; userId: string }>(async ({ ctx, params }) =>
  org.verifyMembership(ctx, uuid.parse(params.id), uuid.parse(params.userId)),
);
