/**
 * P-027 공개(발행) — `POST /api/v1/me/profile/publish`.
 *
 * 본문이 없다. 무엇을 공개할지 고르는 인자를 두지 않는 것이 설계다 — 공개 범위는 저장된
 * `public_settings`·블록·배지 상태가 결정하고(P-029/N-4), 발행은 "지금 상태를 공개로 바꾼다"뿐이다.
 *
 * 응답의 `guidance` 는 완성도 **안내**이고 점수가 아니다(N-3). 낮아도 발행을 막지 않는다.
 */

import { profile } from "@proplus/api";
import { route } from "@/lib/server";

export const POST = route(async ({ ctx }) => profile.publish(ctx));
