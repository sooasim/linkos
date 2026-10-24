// P-081: 도메인 소유 검증 시작. 사용자가 DNS 에 넣어야 할 TXT 레코드를 돌려준다.
//
// 응답의 `recordValue` 는 비밀이 아니다 — 공개 DNS 에 게시할 값이고, 그 값으로는 아무 권한도 얻지 못한다
// (근거는 `modules/org.ts` 의 startDomainVerification 주석). 그래서 평문으로 내보낸다.

import { org } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const orgId = z.uuid();

// 도메인 정규화·거부 규칙은 모듈(`normalizeDomain`)이 가진다. 여기서는 길이만 막는다 —
// 규칙을 두 곳에 쓰면 "어느 도메인을 검증했는가"가 계층마다 달라진다.
const startInput = z.strictObject({ domain: z.string().min(4).max(253) });

export const POST = route<{ id: string }>(async ({ ctx, params, body }) =>
  org.startDomainVerification(ctx, orgId.parse(params.id), parse(startInput, body).domain),
);
