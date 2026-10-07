// identity module — F-001 회원가입/로그인(OTP, Google), F-002 게스트, F-003 Claim, F-007 세션 보안, F-009 동의 분리
import { randomInt } from "node:crypto";
import { CONSENT_TYPES, type ConsentType, POLICY_VERSIONS, generateToken, missingRequiredConsents, normalizeEmail } from "@linkos/domain";
import type pg from "pg";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, unauthorized } from "../lib/errors";
import { type Ctx, audit, hmac, log, rateLimit, sha256 } from "../lib/platform";
import { sendMail } from "../lib/mail";

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
    const sessionToken = await createSession(c, user.id, ctx);
    await audit(c, { userId: user.id }, isNew ? "auth.signup" : "auth.login", "user", user.id, { method: "email_otp" });
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
export async function createSession(db: Db, userId: string, ctx: Pick<Ctx, "userAgent">, rotatedFrom: string | null = null): Promise<string> {
  const token = generateToken(32);
  await db.query(
    "INSERT INTO auth_sessions (user_id, refresh_hash, user_agent, device_label, expires_at, rotated_from) VALUES ($1,$2,$3,$4,$5,$6)",
    [userId, sha256(token), ctx.userAgent.slice(0, 300), deviceLabel(ctx.userAgent), new Date(Date.now() + SESSION_TTL_MS), rotatedFrom],
  );
  return token;
}

function deviceLabel(ua: string): string {
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

/** `rotate=false` for read-only contexts (server components) that cannot set a replacement cookie. */
export async function resolveSession(token: string | undefined, ctx: Pick<Ctx, "userAgent">, rotate = true): Promise<ResolvedSession | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const s = await one<{ id: string; user_id: string; expires_at: Date; revoked_at: Date | null; last_used_at: Date; status: string }>(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, s.last_used_at, u.status
     FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_hash=$1`,
    [sha256(token)],
  );
  if (!s) return null;
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
