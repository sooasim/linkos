import { handoff } from "@linkos/api";
import { route } from "@/lib/server";

// 백서 §3.1 CONSENT_PENDING — the guest reached "보낼 필드 미리보기" (review + consent). No login wall, no body:
// only the session state moves; the draft reply stays on the device until it is sent (POST …/reply).
export const POST = route<{ token: string }>(async ({ ctx, params }) => handoff.reviewExchange(params.token, ctx), { auth: false });
