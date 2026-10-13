import { netintel } from "@linkos/api";
import { route } from "@/lib/server";

// N-014 1~3촌 탐색 (masked discovery)
export const GET = route(async ({ ctx, req }) =>
  netintel.neighbors(ctx, {
    hops: Number(req.nextUrl.searchParams.get("hops") ?? 2),
    limit: Number(req.nextUrl.searchParams.get("limit") ?? 100),
  }),
);
