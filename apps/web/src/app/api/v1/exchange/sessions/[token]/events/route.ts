import { ApiError, handoff } from "@linkos/api";
import type { NextRequest } from "next/server";
import { requestCtx } from "@/lib/server";

export const dynamic = "force-dynamic";

// Audit G-03 — CLAUDE.md §4: 실시간 교환 상태는 SSE(`/api/v1/exchange/sessions/{token}/events`).
// Guest-safe stream for the token holder: state / acceptsReply / expiresAt only (no sender or receiver data).
// The sender's richer stream stays at /exchange/manage/{id}/events (session-authenticated).
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = requestCtx(req);
  const enc = new TextEncoder();
  let closed = false;
  req.signal.addEventListener("abort", () => (closed = true));
  // fail fast (404/410/429) before opening a stream
  let first: Awaited<ReturnType<typeof handoff.getGuestSessionStatus>>;
  try {
    first = await handoff.getGuestSessionStatus(token, ctx);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    return Response.json({ code: e instanceof ApiError ? e.code : "internal_error" }, { status });
  }
  const once = req.nextUrl.searchParams.get("once") === "1"; // single snapshot (tests, polling fallbacks)
  const stream = new ReadableStream({
    async start(controller) {
      let last = "";
      let s = first;
      const started = Date.now();
      while (!closed) {
        const payload = JSON.stringify(s);
        if (payload !== last) {
          controller.enqueue(enc.encode(`event: status\ndata: ${payload}\n\n`));
          last = payload;
        } else controller.enqueue(enc.encode(`: ping\n\n`));
        if (once || !s.acceptsReply || Date.now() - started > 10 * 60 * 1000) break;
        await new Promise((r) => setTimeout(r, 3000));
        try {
          s = await handoff.getGuestSessionStatus(token, ctx, { rateLimited: false });
        } catch (e) {
          controller.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ code: e instanceof ApiError ? e.code : "error" })}\n\n`));
          break;
        }
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
