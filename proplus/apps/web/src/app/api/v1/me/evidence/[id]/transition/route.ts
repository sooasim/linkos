/**
 * P-053 당사자 전이 — 재제출(`submitted`)과 철회(`revoked`)만.
 *
 * 왜 목표 상태를 두 개로 좁히는가(라우트가 할 수 있는 입력 검증의 범위 안이다):
 *  - 전이표(domain `proof.ts`)에서 owner 가 갈 수 있는 곳은 `submitted` · `revoked` · `disputed` 뿐이다.
 *    `verified` 를 여기서 받아 봐야 `canTransition` 이 막는다 — 그래도 **받지 않는** 이유는,
 *    검증자가 이 경로로 승인하면 "승인은 /admin 경로에서 일어난다"는 운영 전제가 깨지기 때문이다.
 *    (모듈은 actor 를 DB 사실로 정하므로, 검증자가 이 URL 을 호출하면 reviewer 자격으로 동작한다.)
 *  - `disputed` 는 **이의제기 레코드와 함께** 만들어져야 한다. 여기서 바로 disputed 로 보내면
 *    처리할 appeal 이 없는 분쟁 상태가 남고, 재심(`resolveAppeal`)이 손댈 대상을 못 찾는다.
 *    당사자의 분쟁 경로는 `POST /me/verifications/{id}/appeal` 하나다 (P-063).
 *
 * `{id}` 는 **증거 id** 다. 검증(`verifications`) 행은 전이할 때마다 새로 생기므로
 * 전이의 대상은 언제나 증거다.
 */

import { proof } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const OWNER_TARGETS = ["submitted", "revoked"] as const;

const Body = z.object({
  to: z.enum(OWNER_TARGETS),
  /** 철회에는 사유 코드가 필수다 (데이터모델 §4 · P-061). 최종 판정은 도메인이 한다. */
  reasonCode: z.string().min(2).max(60).nullish(),
  message: z.string().max(300).nullish(),
});

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const input = parse(Body, body);
  return proof.transition(ctx, params.id, input.to, {
    reasonCode: input.reasonCode ?? null,
    message: input.message ?? null,
  });
});
