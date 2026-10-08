import { ApiError, handoff } from "@linkos/api";
import type { NextRequest } from "next/server";
import { requestCtx } from "@/lib/server";

export const dynamic = "force-dynamic";

// Audit G-03 — CLAUDE.md §4: 실시간 교환 상태는 SSE(`/api/v1/exchange/sessions/{token}/events`).
// Guest-safe stream for the token holder: state / acceptsReply / expiresAt only (no sender or receiver data).
// The sender's richer stream stays at /exchange/manage/{id}/events (session-authenticated).
// 백서 §20 propagation p95 < 1s: the token is resolved once, then each poll is a primary-key read every
// handoff.GUEST_SSE_POLL_MS (800ms, same as the sender stream).
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = requestCtx(req);
  const enc = new TextEncoder();
  let closed = false;
  req.signal.addEventListener("abort", () => (closed = true));
  // fail fast (404/410/429) before opening a stream
  let opened: Awaited<ReturnType<typeof handoff.openGuestStatusStream>>;
  try {
    opened = await handoff.openGuestStatusStream(token, ctx);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    return Response.json({ code: e instanceof ApiError ? e.code : "internal_error" }, { status });
  }
  const once = req.nextUrl.searchParams.get("once") === "1"; // single snapshot (tests, polling fallbacks)
  const stream = new ReadableStream({
    async start(controller) {
      let last = "";
      let s = opened.first;
      const started = Date.now();
      let lastSent = 0;
      while (!closed) {
        const payload = JSON.stringify(s);
        if (payload !== last) {
          controller.enqueue(enc.encode(`event: status\ndata: ${payload}\n\n`));
          last = payload;
          lastSent = Date.now();
        } else if (Date.now() - lastSent >= 15_000) {
          controller.enqueue(enc.encode(`: ping\n\n`)); // keep-alive only every 15s (polls are faster than pings)
          lastSent = Date.now();
        }
        if (once || !s.acceptsReply || Date.now() - started > 10 * 60 * 1000) break;
        await new Promise((r) => setTimeout(r, handoff.GUEST_SSE_POLL_MS));
        if (closed) break;
        try {
          s = await opened.poll();
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
