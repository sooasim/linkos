// P-106: 리드 비공개 메모.
//
// 이 데이터가 고객·외부로 나가는 경로는 만들지 않는다 — 공개 뷰(`public_*_view`)는 `lead_notes` 를 모르고,
// 모듈에도 메모를 공개 DTO 로 바꾸는 함수가 없다. 조회 권한은 리드 본체와 같다(모듈이 `loadLead` 로 확인한다).

import { lead } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const leadId = z.uuid();

// 상한은 모듈의 `sanitizeText(note, 2000)` 과 같게 둔다 — 초과분이 조용히 잘리지 않게.
const noteInput = z.strictObject({ note: z.string().min(1).max(2000) });

export const GET = route<{ id: string }>(async ({ ctx, params }) => ({
  notes: await lead.listNotes(ctx, leadId.parse(params.id)),
}));

export const POST = route<{ id: string }>(
  async ({ ctx, params, body }) => lead.addNote(ctx, leadId.parse(params.id), parse(noteInput, body).note),
  { status: 201 },
);
