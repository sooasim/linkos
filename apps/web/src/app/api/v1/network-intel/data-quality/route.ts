import { netintel } from "@linkos/api";
import { route } from "@/lib/server";

// N-024 데이터 품질 큐 + projection 지연
export const GET = route(async ({ ctx }) => netintel.dataQuality(ctx));
