import { netintel } from "@linkos/api";
import { route } from "@/lib/server";

// N-018 Role/Need 분해 — 결과는 **초안**이며 사용자 확정 전에는 요구사항이 아니다
export const POST = route<{ id: string }>(async ({ ctx, params }) => netintel.analyzeProject(ctx, params.id), { status: 202 });
