import { security } from "@linkos/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

// exportMyData (04_OPENAPI: 202 Queued) — queues a portable export; the worker builds it into encrypted storage and
// GET /me/privacy/export/{id} returns its status + a short-lived signed download link.
// Clients opt into the pure job with `Prefer: respond-async` or `{ "async": true }`. Without it the deprecated inline
// form is kept for the pre-job UI: the same job is processed right away and the JSON is also returned as `data`.
export const POST = route(async ({ req, ctx, body }) => {
  const wantsJob = /\brespond-async\b/i.test(req.headers.get("prefer") ?? "") || (body as { async?: unknown } | undefined)?.async === true;
  if (wantsJob) {
    const job = await security.requestPrivacyExport(ctx);
    return NextResponse.json(job, { status: 202, headers: { location: job.statusUrl, "preference-applied": "respond-async" } });
  }
  const legacy = await security.requestPrivacyExportInline(ctx);
  return NextResponse.json(legacy, { status: 202, headers: { location: legacy.statusUrl, deprecation: "true", link: `<${legacy.statusUrl}>; rel="status"` } });
}, { status: 202 });
