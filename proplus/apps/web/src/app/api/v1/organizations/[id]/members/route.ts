// P-086: 조직 멤버 목록. 같은 조직 관리자만 조회하고, 응답에는 프로필 본문·원문 연락처가 없다
// (N-12: 조직은 개인 프로필을 소유하지 않는다 / N-13: 이메일은 마스킹).
//
// 멤버 추가는 이 경로에 없다 — 소속은 초대 수락(P-082)이나 관리자 승인(P-083)으로만 활성이 된다.

import { org } from "@proplus/api";
import { z } from "zod";
import { route } from "@/lib/server";

const orgId = z.uuid();

export const GET = route<{ id: string }>(async ({ ctx, params }) => ({
  members: await org.listMembers(ctx, orgId.parse(params.id)),
}));
