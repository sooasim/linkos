/**
 * P-051 내 증거 상세 (데이터모델 §4 `GET /me/evidence/{id}`).
 *
 * 소유자 스코프는 모듈의 WHERE 에 박혀 있고 없으면 404 다 — 남의 증거의 **존재 여부**도 알려 주지 않는다(IDOR).
 * 당사자 응답에는 검증자 신원(`reviewer_id`)과 내부 메모가 없다(P-164). 그 둘은 검증 콘솔 전용이다.
 */

import { proof } from "@proplus/api";
import { route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => proof.getMyEvidence(ctx, params.id));
