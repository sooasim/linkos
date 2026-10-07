import { renderMetrics } from "@linkos/api";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// F-180 Prometheus metrics. Requires METRICS_TOKEN in production.
export async function GET(req: NextRequest) {
  const token = process.env.METRICS_TOKEN;
  if (token ? req.headers.get("authorization") !== `Bearer ${token}` : process.env.NODE_ENV === "production") return new Response("forbidden", { status: 403 });
  return new Response(renderMetrics(), { headers: { "content-type": "text/plain; version=0.0.4" } });
}
