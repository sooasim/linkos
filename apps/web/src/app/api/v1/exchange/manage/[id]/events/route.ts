import { ApiError, handoff, identity } from "@linkos/api";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/server";

export const dynamic = "force-dynamic";

// SSE: live exchange status for the sender (백서 11: 실시간 교환 상태는 WebSocket 또는 SSE)
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await identity.resolveSession(req.cookies.get(SESSION_COOKIE)?.value, { userAgent: req.headers.get("user-agent") ?? "" }, false);
  if (!session) return new Response("unauthorized", { status: 401 });
  const ctx = { userId: session.userId, ip: "", userAgent: "", requestId: "sse" };
  const enc = new TextEncoder();
  let closed = false;
  req.signal.addEventListener("abort", () => (closed = true));
  const stream = new ReadableStream({
    async start(controller) {
      let last = "";
      const started = Date.now();
      while (!closed && Date.now() - started < 10 * 60 * 1000) {
        try {
          const s = await handoff.getSenderSessionStatus(ctx, id);
          const payload = JSON.stringify(s);
          if (payload !== last) {
            controller.enqueue(enc.encode(`event: status\ndata: ${payload}\n\n`));
            last = payload;
          } else controller.enqueue(enc.encode(`: ping\n\n`));
          if (["EXPIRED", "REVOKED", "CANCELLED", "SYNCED"].includes(s.state) || (!s.isGroup && ["CLAIMED"].includes(s.state))) break;
        } catch (e) {
          controller.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ code: e instanceof ApiError ? e.code : "error" })}\n\n`));
          break;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
