import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-103 관계강도 9신호 + 구성요소 + 근거 · N-104 휴면 신호 (S15 Relationship Intelligence)
export const GET = route<{ contactId: string }>(async ({ ctx, params }) => netintel.relationshipIntelligence(ctx, params.contactId));
// 사용자 교정("이 관계가 틀림") — audit 를 남기고 feature 를 재계산한다
export const PATCH = route<{ contactId: string }>(async ({ ctx, params, body }) => netintel.correctRelationship(ctx, params.contactId, parse(netintel.correctRelationshipInput, body)));
