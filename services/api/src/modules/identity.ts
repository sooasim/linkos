// identity module — F-001 회원가입/로그인(OTP, Google), F-002 게스트, F-003 Claim, F-007 세션 보안, F-009 동의 분리
import { type KeyObject, createPublicKey, randomInt, verify as cryptoVerify } from "node:crypto";
import { CONSENT_TYPES, type ConsentType, POLICY_VERSIONS, generateToken, missingRequiredConsents, normalizeEmail } from "@linkos/domain";
import type pg from "pg";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, unauthorized } from "../lib/errors";
import { type Ctx, audit, hmac, log, rateLimit, sha256 } from "../lib/platform";
import { sendMail } from "../lib/mail";
import { track } from "../lib/metering";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ROTATE_AFTER_MS = 60 * 60 * 1000; // refresh rotation (F-007)
const OTP_TTL_MS = 10 * 60 * 1000;

export interface UserRow {
  id: string;
  email: string | null;
  display_name: string | null;
  locale: string;
  status: string;
  created_at: Date;
}

export const consentInput = z.array(z.object({ type: z.enum(CONSENT_TYPES), granted: z.boolean() })).default([]);

export async function recordConsents(db: Db, userId: string, decisions: { type: ConsentType; granted: boolean }[], context: Record<string, unknown> = {}) {
  for (const d of decisions) {
    await db.query(
      "INSERT INTO consent_records (subject_user_id, consent_type, policy_version, granted, context) VALUES ($1,$2,$3,$4,$5)",
      [userId, d.type, POLICY_VERSIONS[d.type], d.granted, JSON.stringify(context)],
    );
  }
}

export async function currentConsents(userId: string, db: Db = pool()) {
  return q<{ consent_type: ConsentType; granted: boolean; policy_version: string; created_at: Date }>(
    `SELECT DISTINCT ON (consent_type) consent_type, granted, policy_version, created_at
     FROM consent_records WHERE subject_user_id=$1 ORDER BY consent_type, created_at DESC`,
    [userId],
    db,
  );
}

// ---------- Email OTP ----------
export async function requestOtp(ctx: Ctx, rawEmail: string): Promise<{ sent: true; devCode?: string }> {
  const email = normalizeEmail(rawEmail);
  if (!email) throw badRequest("invalid_email", "올바른 이메일을 입력하세요.");
  await rateLimit(`otp:email:${sha256(email)}`, 5, 600);
  await rateLimit(`otp:ip:${ctx.ip}`, 20, 600);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await q("INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ($1,$2,$3)", [email, hmac(`${email}:${code}`), new Date(Date.now() + OTP_TTL_MS)]);
  const delivered = await sendMail(email, "LINKOS 로그인 코드", `LINKOS 로그인 코드: ${code}\n10분 안에 입력하세요. 요청하지 않았다면 무시하세요.`);
  if (!delivered) {
    if (process.env.NODE_ENV === "production" && process.env.OTP_DEV_ECHO !== "1") {
      throw new ApiError(503, "mail_not_configured", "메일 발송이 설정되지 않았습니다.");
    }
    log("warn", "otp.dev_delivery", { hint: "SMTP_URL not set; returning code for development" });
    return { sent: true, devCode: code };
  }
  return { sent: true, ...(process.env.OTP_DEV_ECHO === "1" ? { devCode: code } : {}) };
}

export async function verifyOtp(
  ctx: Ctx,
  rawEmail: string,
  code: string,
  consents: { type: ConsentType; granted: boolean }[],
  displayName?: string,
  clientKind: ClientKind = "web",
): Promise<{ user: UserRow; sessionToken: string; isNew: boolean }> {
  const email = normalizeEmail(rawEmail);
  if (!email || !/^\d{6}$/.test(code)) throw badRequest("invalid_code", "코드가 올바르지 않습니다.");
  await rateLimit(`otpv:${sha256(email)}`, 10, 600);
  const row = await one<{ id: string; code_hash: string; attempts: number }>(
    "SELECT id, code_hash, attempts FROM otp_codes WHERE email=$1 AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
    [email],
  );
  if (!row || row.attempts >= 5) throw badRequest("invalid_code", "코드가 만료되었거나 올바르지 않습니다.");
  if (row.code_hash !== hmac(`${email}:${code}`)) {
    await q("UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1", [row.id]);
    throw badRequest("invalid_code", "코드가 올바르지 않습니다.");
  }
  return tx(async (c) => {
    await c.query("UPDATE otp_codes SET consumed_at = now() WHERE id=$1", [row.id]);
    const { user, isNew } = await upsertUserByEmail(c, email, consents, displayName, "email_otp", email);
    const sessionToken = await createSession(c, user.id, ctx, null, clientKind);
    await audit(c, { userId: user.id }, isNew ? "auth.signup" : "auth.login", "user", user.id, { method: "email_otp", client: clientKind });
    if (isNew) await track(c, "signup_completed", { userId: user.id }, { method: "email_otp" }); // F-188
    return { user, sessionToken, isNew };
  });
}

export async function upsertUserByEmail(
  c: pg.PoolClient,
  email: string,
  consents: { type: ConsentType; granted: boolean }[],
  displayName: string | undefined,
  provider: string,
  providerSubject: string,
): Promise<{ user: UserRow; isNew: boolean }> {
  const ident = await one<{ user_id: string }>("SELECT user_id FROM identities WHERE provider=$1 AND provider_subject=$2", [provider, providerSubject], c);
  let user = ident
    ? await one<UserRow>("SELECT * FROM users WHERE id=$1", [ident.user_id], c)
    : await one<UserRow>("SELECT * FROM users WHERE email=$1", [email], c);
  let isNew = false;
  if (user && user.status !== "active") throw new ApiError(403, "account_disabled", "비활성화된 계정입니다.");
  if (user && !isNew) {
    // F-008: accounts provisioned by an org's SCIM never accepted terms themselves → require consent at first sign-in
    const provisioned = await one("SELECT 1 FROM identities WHERE user_id=$1 AND provider LIKE 'scim:%' LIMIT 1", [user.id], c);
    if (provisioned && !(await one("SELECT 1 FROM consent_records WHERE subject_user_id=$1 AND consent_type='terms' AND granted LIMIT 1", [user.id], c))) {
      const missing = missingRequiredConsents(consents);
      if (missing.length) throw new ApiError(422, "consent_required", "필수 약관 동의가 필요합니다.", { missing });
      await recordConsents(c, user.id, consents, { at: "first_login_after_provisioning" });
    }
  }
  if (!user) {
    const missing = missingRequiredConsents(consents);
    if (missing.length) throw new ApiError(422, "consent_required", "필수 약관 동의가 필요합니다.", { missing });
    user = await one<UserRow>("INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING *", [email, displayName ?? null], c);
    isNew = true;
    await recordConsents(c, user!.id, consents, { at: "signup" });
  }
  await c.query(
    "INSERT INTO identities (user_id, provider, provider_subject) VALUES ($1,$2,$3) ON CONFLICT (provider, provider_subject) DO NOTHING",
    [user!.id, provider, providerSubject],
  );
  return { user: user!, isNew };
}

// ---------- Sessions (F-007) ----------
/** "web" = httpOnly cookie, "native" = bearer token kept in the app's secure storage (apps/mobile, App Clip). */
export type ClientKind = "web" | "native";

export async function createSession(db: Db, userId: string, ctx: Pick<Ctx, "userAgent">, rotatedFrom: string | null = null, kind: ClientKind = "web"): Promise<string> {
  const token = generateToken(32);
  await db.query(
    "INSERT INTO auth_sessions (user_id, refresh_hash, user_agent, device_label, expires_at, rotated_from, client_kind) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [userId, sha256(token), ctx.userAgent.slice(0, 300), deviceLabel(ctx.userAgent) + (kind === "native" ? " · 앱" : ""), new Date(Date.now() + SESSION_TTL_MS), rotatedFrom, kind],
  );
  return token;
}

export function deviceLabel(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : "기기";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "브라우저";
  return `${os} · ${br}`;
}

export interface ResolvedSession {
  userId: string;
  sessionId: string;
  /** set when the session token was rotated; caller must set the new cookie */
  rotatedToken?: string;
}

/**
 * `rotate=false` for read-only contexts (server components) that cannot set a replacement cookie.
 * `kind` binds a token to its transport: a cookie token is never accepted as a bearer token and vice versa.
 * Native (bearer) sessions rotate only through the explicit refreshNativeSession() call.
 */
export async function resolveSession(token: string | undefined, ctx: Pick<Ctx, "userAgent">, rotate = true, kind: ClientKind = "web"): Promise<ResolvedSession | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const s = await one<{ id: string; user_id: string; expires_at: Date; revoked_at: Date | null; last_used_at: Date; status: string; client_kind: string }>(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, s.last_used_at, s.client_kind, u.status
     FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_hash=$1`,
    [sha256(token)],
  );
  if (!s) return null;
  if (s.client_kind !== kind) return null;
  if (kind === "native") rotate = false;
  if (s.revoked_at) {
    // Reuse of a rotated/revoked token → possible theft: revoke the whole family.
    const rotated = await one("SELECT 1 FROM auth_sessions WHERE rotated_from=$1", [s.id]);
    if (rotated) {
      await q("UPDATE auth_sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL", [s.user_id]);
      log("warn", "auth.refresh_reuse_detected", { user: s.user_id });
    }
    return null;
  }
  if (s.expires_at.getTime() < Date.now() || s.status !== "active") return null;
  if (kind === "native" && Date.now() - s.last_used_at.getTime() > 60_000) {
    await q("UPDATE auth_sessions SET last_used_at = now() WHERE id=$1", [s.id]);
  }
  if (rotate && Date.now() - s.last_used_at.getTime() > ROTATE_AFTER_MS) {
    return tx(async (c) => {
      const upd = await c.query("UPDATE auth_sessions SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL", [s.id]);
      if (upd.rowCount === 0) return null; // concurrent rotation
      const newToken = await createSession(c, s.user_id, ctx, s.id);
      const n = await one<{ id: string }>("SELECT id FROM auth_sessions WHERE refresh_hash=$1", [sha256(newToken)], c);
      return { userId: s.user_id, sessionId: n!.id, rotatedToken: newToken };
    });
  }
  return { userId: s.user_id, sessionId: s.id };
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  await q("UPDATE auth_sessions SET revoked_at = now() WHERE refresh_hash=$1 AND revoked_at IS NULL", [sha256(token)]);
}

export async function listDevices(userId: string) {
  return q<{ id: string; device_label: string; created_at: Date; last_used_at: Date }>(
    "SELECT id, device_label, created_at, last_used_at FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC",
    [userId],
  );
}

export async function revokeDevice(ctx: Ctx, sessionId: string): Promise<void> {
  if (!ctx.userId) throw unauthorized();
  await q("UPDATE auth_sessions SET revoked_at = now() WHERE id=$1 AND user_id=$2", [sessionId, ctx.userId]);
  await audit(pool(), ctx, "auth.device_revoked", "auth_session", sessionId);
}

export async function getMe(userId: string) {
  const user = await one<UserRow>("SELECT id, email, display_name, locale, status, created_at FROM users WHERE id=$1", [userId]);
  if (!user) throw unauthorized();
  const profile = await one<{ id: string; slug: string; name: string }>(
    "SELECT id, slug, name FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC, created_at ASC LIMIT 1",
    [userId],
  );
  return { user, profile, consents: await currentConsents(userId) };
}

export async function updateConsent(ctx: Ctx, type: ConsentType, granted: boolean) {
  if (!ctx.userId) throw unauthorized();
  if (["terms", "privacy", "age_14"].includes(type) && !granted) {
    throw badRequest("required_consent", "필수 동의는 철회할 수 없습니다. 계정 삭제를 이용하세요.");
  }
  await recordConsents(pool(), ctx.userId, [{ type, granted }], { at: "settings" });
  await audit(pool(), ctx, "consent.updated", "consent", null, { type, granted });
}

// ---------- Google Sign-in (OIDC code flow) ----------
export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// ---------- Native bearer sessions (apps/mobile, App Clip) ----------
/**
 * Explicit rotation for native clients (F-007). The old token is revoked and a new one returned; reusing the old
 * token afterwards revokes the whole session family (same theft detection as cookie sessions).
 */
export async function refreshNativeSession(token: string | undefined, ctx: Pick<Ctx, "userAgent">): Promise<{ sessionToken: string; userId: string }> {
  const s = await resolveSession(token, ctx, false, "native");
  if (!s) throw unauthorized();
  return tx(async (c) => {
    const upd = await c.query("UPDATE auth_sessions SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL", [s.sessionId]);
    if (upd.rowCount === 0) throw unauthorized();
    const sessionToken = await createSession(c, s.userId, ctx, s.sessionId, "native");
    return { sessionToken, userId: s.userId };
  });
}

// ---------- F-060 One Tap 가입: Google Identity Services ID token ----------
// The browser receives a signed ID token (JWT, RS256) from Google One Tap; the server verifies the signature against
// Google's JWKS (GOOGLE_JWKS_URL overrides it for tests), then iss/aud/exp/email_verified, and signs the user in.
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const jwksCache: { url: string; keys: Map<string, KeyObject>; fetchedAt: number; maxAgeMs: number } = { url: "", keys: new Map(), fetchedAt: 0, maxAgeMs: 0 };

export function oneTapEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID);
}

function jwksUrl(): string {
  return process.env.GOOGLE_JWKS_URL ?? "https://www.googleapis.com/oauth2/v3/certs";
}

async function googleKey(kid: string): Promise<KeyObject | null> {
  const url = jwksUrl();
  const fresh = jwksCache.url === url && Date.now() - jwksCache.fetchedAt < jwksCache.maxAgeMs;
  if (fresh && jwksCache.keys.has(kid)) return jwksCache.keys.get(kid)!;
  // unknown kid → refetch (Google rotates keys), but at most once per 30s to avoid amplification
  if (jwksCache.url === url && jwksCache.keys.has(kid) === false && Date.now() - jwksCache.fetchedAt < 30_000) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!res?.ok) throw new ApiError(502, "google_jwks_unavailable", "Google 인증 키를 가져오지 못했습니다.");
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, KeyObject>();
  for (const k of body.keys ?? []) {
    if (!k.kid || k.kty !== "RSA") continue;
    try {
      keys.set(k.kid, createPublicKey({ key: k as import("node:crypto").JsonWebKey, format: "jwk" }));
    } catch {
      /* skip malformed key */
    }
  }
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
  Object.assign(jwksCache, { url, keys, fetchedAt: Date.now(), maxAgeMs: Math.min(Math.max(maxAge, 60), 86400) * 1000 });
  return keys.get(kid) ?? null;
}

export interface GoogleIdClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  aud: string;
  iss: string;
  exp: number;
}

export async function verifyGoogleIdToken(idToken: string, audience = process.env.GOOGLE_CLIENT_ID): Promise<GoogleIdClaims> {
  const invalid = () => badRequest("invalid_google_credential", "Google 인증 정보가 올바르지 않습니다.");
  if (!audience) throw new ApiError(503, "google_not_configured", "Google 로그인이 설정되지 않았습니다(GOOGLE_CLIENT_ID).");
  if (typeof idToken !== "string" || idToken.length > 4096) throw invalid();
  const parts = idToken.split(".");
  if (parts.length !== 3) throw invalid();
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (header.alg !== "RS256" || !header.kid) throw invalid();
  const key = await googleKey(header.kid);
  if (!key) throw invalid();
  const ok = cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"));
  if (!ok) throw invalid();
  const now = Math.floor(Date.now() / 1000);
  const aud = claims.aud;
  const audOk = typeof aud === "string" ? aud === audience : Array.isArray(aud) && aud.includes(audience);
  if (!audOk || !GOOGLE_ISSUERS.has(String(claims.iss))) throw invalid();
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw badRequest("google_credential_expired", "Google 인증이 만료되었습니다. 다시 시도하세요.");
  if (typeof claims.iat === "number" && claims.iat > now + 300) throw invalid();
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (typeof claims.email !== "string" || !verified) throw badRequest("google_email_unverified", "Google 이메일이 확인되지 않았습니다.");
  if (typeof claims.sub !== "string" || !claims.sub) throw invalid();
  return { sub: claims.sub, email: claims.email, email_verified: true, name: typeof claims.name === "string" ? claims.name : undefined, aud: audience, iss: String(claims.iss), exp: claims.exp };
}

/** One Tap sign-in/up. New users must pass the required consents (422 consent_required otherwise). */
export async function signInWithGoogleIdToken(
  ctx: Ctx,
  credential: string,
  consents: { type: ConsentType; granted: boolean }[],
  clientKind: ClientKind = "web",
): Promise<{ user: UserRow; sessionToken: string; isNew: boolean }> {
  await rateLimit(`onetap:ip:${ctx.ip}`, 30, 600);
  const g = await verifyGoogleIdToken(credential);
  const email = normalizeEmail(g.email);
  if (!email) throw badRequest("invalid_email");
  return tx(async (c) => {
    const { user, isNew } = await upsertUserByEmail(c, email, consents, g.name, "google", g.sub);
    const sessionToken = await createSession(c, user.id, ctx, null, clientKind);
    await audit(c, { userId: user.id }, isNew ? "auth.signup" : "auth.login", "user", user.id, { method: "google_one_tap", client: clientKind });
    return { user, sessionToken, isNew };
  });
}
