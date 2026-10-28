/**
 * P-063 이의제기 (데이터모델 §4 `POST /me/verifications/{id}/appeal` · 보안정책 §4.6).
 *
 * `{id}` 는 **검증 id** 다 — 이의제기는 이미 내려진 판정 하나를 겨냥하므로, 증거가 아니라
 * 그 증거의 어느 검증 결과에 이의를 제기하는지가 분명해야 한다. 검증 id 는 내 증거 상세
 * (`GET /me/evidence/{id}` 의 `latest`)에서 얻는다.
 *
 * 접수되면 모듈이 상태를 `disputed` 로 돌리고, 공개 라벨은 도메인이 "확인 필요"로 고정한다(N-14).
 * 라우트는 사유 길이만 본다 — 당사자 여부·중복 접수 판정은 모듈이 DB 사실로 한다.
 */

import { proof } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Body = z.object({ reason: z.string().min(5).max(2000) });

export const POST = route<{ id: string }>(
  async ({ ctx, params, body }) => proof.submitAppeal(ctx, params.id, parse(Body, body).reason),
  { status: 201 },
);
