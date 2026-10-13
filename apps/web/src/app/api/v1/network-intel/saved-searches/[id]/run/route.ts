import { netintel } from "@linkos/api";
import { route } from "@/lib/server";

// N-106 재실행 — 지난 실행에 없던 후보만 "새로 생긴 결과"로 표시한다
export const POST = route<{ id: string }>(async ({ ctx, params }) => netintel.runSavedSearch(ctx, params.id));
