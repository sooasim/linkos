import { netintel } from "@linkos/api";
import { route } from "@/lib/server";

// N-019 covered/partial/gap 매트릭스 + Network Gap 제안
export const GET = route<{ id: string }>(async ({ ctx, params }) => netintel.projectCoverage(ctx, params.id));
