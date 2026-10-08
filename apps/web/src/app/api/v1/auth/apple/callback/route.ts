import { randomUUID } from "node:crypto";
import { ApiError, type Ctx, apple, log, recordRequest } from "@linkos/api";
import { type NextRequest, NextResponse } from "next/server";
import { clientIp, safeNext, setSession } from "@/lib/server";

// F-001/F-060 Sign in with Apple — callback. Apple POSTs application/x-www-form-urlencoded (code, state, user, error)
// from appleid.apple.com, so this handler deliberately does not use route() (JSON-only + same-origin CSRF guard).
// Its authenticity rests on the one-time server-side state, the code exchange with our client secret and the
// JWKS-verified id_token (iss/aud/exp/nonce) — see services/api/src/modules/apple.ts.
const KNOWN_ERRORS = new Set([
  "invalid_state",
  "apple_missing_code",
  "apple_token_failed",
  "apple_no_id_token",
  "apple_invalid_token",
  "apple_token_expired",
  "apple_nonce_mismatch",
  "apple_email_missing",
  "apple_jwks_unavailable",
  "apple_not_configured",
  "account_disabled",
  "rate_limited",
]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = performance.now();
  const origin = req.nextUrl.origin;
  // 303: the browser follows with GET (never re-POSTs the code)
  const go = (path: string) => {
    const res = NextResponse.redirect(`${origin}${path}`, 303);
    recordRequest("POST /api/v1/auth/apple/callback", 303, performance.now() - started);
    return res;
  };
  const ct = req.headers.get("content-type") ?? "";
  if (Number(req.headers.get("content-length") ?? "0") > 32_768 || !(ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data"))) {
    return go("/login?error=apple_failed");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return go("/login?error=apple_failed");
  }
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };
  if (field("error")) return go("/login?error=apple_denied"); // e.g. user_cancelled_authorize
  const ctx: Ctx = { userId: null, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent") ?? "", requestId: randomUUID() };
  try {
    const r = await apple.appleCallback(ctx, { code: field("code"), state: field("state"), user: field("user") });
    return setSession(go(safeNext(r.next)), r.sessionToken);
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.code === "consent_required") {
        const next = safeNext((e.details as { next?: string } | undefined)?.next);
        return go(`/login?consent=apple&next=${encodeURIComponent(next)}`);
      }
      log("warn", "apple.callback_failed", { code: e.code, requestId: ctx.requestId });
      return go(`/login?error=${KNOWN_ERRORS.has(e.code) ? e.code : "apple_failed"}`);
    }
    log("error", "apple.callback_error", { requestId: ctx.requestId, error: (e as Error)?.message });
    return go("/login?error=apple_failed");
  }
}
