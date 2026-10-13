import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-016 학습 라벨 — CTR 이 아니라 funnel 결과를 기록한다
export const POST = route(async ({ ctx, body }) => netintel.recordFeedback(ctx, parse(netintel.feedbackInput, body)), { status: 202 });
