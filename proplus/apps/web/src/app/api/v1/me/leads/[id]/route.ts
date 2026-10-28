// P-103/P-104/P-105: 리드 상세와 단계·담당자 수정 (데이터모델 §4 — `PATCH /me/leads/{id}`).
//
// GET 은 **원문 연락처가 나가는 유일한 경로**이고 모듈이 조회마다 감사로그를 남긴다 (P-165).
// 그래서 목록에서 쓰면 안 된다 — 담당자가 100건을 훑는 동작이 100번의 복호화 기록을 만들 이유가 없다.

import { badRequest, lead } from "@proplus/api";
import { LEAD_STAGES } from "@proplus/domain";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const leadId = z.uuid();

const patchInput = z.strictObject({
  stage: z.enum(LEAD_STAGES).optional(),
  assignedTo: z.uuid().optional(),
});

export const GET = route<{ id: string }>(async ({ ctx, params }) => lead.getLead(ctx, leadId.parse(params.id)));

export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => {
  const id = leadId.parse(params.id);
  const input = parse(patchInput, body);

  // 한 번에 하나만 받는다. 단계 변경과 재배정은 각각 별개의 트랜잭션·감사로그·알림이라
  // 둘을 한 요청으로 받으면 "단계는 바뀌었는데 배정은 실패"한 상태가 에러 응답 뒤에 남는다.
  // 어느 쪽이 적용됐는지 클라이언트가 알 수 없는 응답을 만들지 않는다 (P-187).
  if (input.stage !== undefined && input.assignedTo === undefined) return lead.updateStage(ctx, id, input.stage);
  if (input.assignedTo !== undefined && input.stage === undefined) return lead.assign(ctx, id, input.assignedTo);

  throw badRequest("single_field_required", "단계(stage) 또는 담당자(assignedTo) 중 하나만 지정하세요.");
});
