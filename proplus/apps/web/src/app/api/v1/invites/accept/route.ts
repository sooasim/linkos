// P-082: 초대 수락. 로그인한 계정의 이메일이 초대 이메일과 같아야 통과한다(모듈이 대조한다) —
// 초대 토큰은 bearer 라서 링크가 전달·유출되면 누구나 소속을 주장할 수 있고, 소속은 공개 배지의 근거다
// (보안정책 §2, `modules/org.ts` acceptInvite 주석).
//
// 토큰을 경로 조각이 아니라 **본문**으로 받는 이유: URL 은 서버 액세스 로그·Referer·브라우저 이력에 남는다.
// 1회성 토큰이라도 사본이 그런 곳에 남지 않게 한다 (CLAUDE.md §5 "토큰에 PII 금지"와 같은 취지).

import { org } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// 길이 판정은 모듈이 한 번 더 한다(20~200). 여기 상한은 거대한 본문을 해시 계산 전에 끊기 위한 것이다.
const acceptInput = z.strictObject({ token: z.string().min(20).max(200) });

export const POST = route(async ({ ctx, body }) => org.acceptInvite(ctx, parse(acceptInput, body).token));
