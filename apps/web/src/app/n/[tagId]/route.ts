import { randomUUID } from "node:crypto";
import { ApiError, channels } from "@linkos/api";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// F-044 NFC 액세서리: the tag's NDEF URL record points here. Each tap mints a fresh single-use exchange session for
// the tag owner and redirects to the guest landing (no login, no app install — 교환이 가입보다 먼저).
const page = (title: string, body: string, status: number) =>
  new Response(
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0E0E10;color:#F4F1EA;font:16px/1.5 system-ui,sans-serif;padding:24px}main{max-width:420px}h1{font-size:28px;margin:0 0 8px}a{color:#C8F03C}</style></head>` +
      `<body><main><h1>${title}</h1><p>${body}</p><p><a href="/">LINKOS 홈</a></p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );

export async function GET(req: NextRequest, { params }: { params: Promise<{ tagId: string }> }) {
  const { tagId } = await params;
  const h = req.headers;
  try {
    const r = await channels.tapNfcTag(tagId, {
      userId: null,
      ip: (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "0.0.0.0").trim(),
      userAgent: h.get("user-agent") ?? "",
      requestId: randomUUID(),
    });
    const res = NextResponse.redirect(r.url, 303);
    res.headers.set("cache-control", "no-store");
    res.headers.set("referrer-policy", "no-referrer");
    return res;
  } catch (e) {
    if (e instanceof ApiError && e.code === "nfc_tag_revoked") return page("비활성화된 태그", "이 NFC 카드는 소유자가 비활성화했습니다. 상대에게 다른 교환 방법을 요청하세요.", 410);
    if (e instanceof ApiError && e.status === 429) return page("잠시 후 다시", "짧은 시간에 너무 많이 태그되었습니다. 잠시 후 다시 대 주세요.", 429);
    if (e instanceof ApiError && e.status === 404) return page("알 수 없는 태그", "등록되지 않은 NFC 태그입니다.", 404);
    return page("일시적인 오류", "잠시 후 다시 시도하세요.", 500);
  }
}
