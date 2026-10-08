import { analytics, log, rateLimit, recordRequest } from "@linkos/api";
import { type NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/server";

// 백서 §20 RUM — web-vitals beacon (navigator.sendBeacon, text/plain JSON so no preflight). Deliberately not route():
// no session lookup/rotation (no user is attached to a sample), same-origin only, tiny body, always 204.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = performance.now();
  const done = (status: number) => {
    recordRequest("POST /api/v1/vitals", status, performance.now() - started);
    return new NextResponse(null, { status });
  };
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return done(403);
  if (Number(req.headers.get("content-length") ?? "0") > 4096) return done(413);
  try {
    await rateLimit(`vitals:${clientIp(req.headers)}`, 120, 600);
    const text = (await req.text()).slice(0, 4096);
    await analytics.recordVitals(JSON.parse(text));
  } catch (e) {
    if ((e as { status?: number }).status === 429) return done(429);
    log("warn", "vitals.rejected", { error: (e as Error).message.slice(0, 120) });
  }
  return done(204);
}
