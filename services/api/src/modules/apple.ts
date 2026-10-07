// F-001 회원가입/로그인 · F-060 One Tap 가입 — Sign in with Apple (web, OAuth code flow with response_mode=form_post).
//
// Flow: GET /auth/apple → one-time state (SHA-256 hash stored) + nonce → appleid.apple.com/auth/authorize →
// Apple POSTs code/state/(first login only) user JSON to /auth/apple/callback → code exchanged with an ES256
// client-secret JWT → id_token verified against Apple's JWKS (RS256/ES256, iss, aud = Services ID, exp, nonce) →
// user created/linked through identity.upsertUserByEmail (provider 'apple') → session.
// New users without accepted consents get 422 consent_required → /login?consent=apple (separated consent step).
// Endpoints are overridable with APPLE_API_BASE so tests run against a local fake Apple.
import { normalizeEmail, formatAppleName, generateToken, isApplePrivateRelay } from "@linkos/domain";
import { type JWTPayload, SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify } from "jose";
import { one, q, tx } from "../lib/db";
import { ApiError, badRequest, unavailable } from "../lib/errors";
import { track } from "../lib/metering";
import { type Ctx, appOrigin, audit, log, rateLimit, sha256 } from "../lib/platform";
import { type ClientKind, createSession, upsertUserByEmail } from "./identity";
import { seal, unseal } from "./integration";

export const APPLE_ISSUER = "https://appleid.apple.com";
const STATE_TTL_MIN = 10;
const PENDING_PROFILE_TTL_MIN = 30;
const REQUIRED_CONSENTS = ["terms", "privacy", "age_14"] as const;

export function appleEnabled(): boolean {
  return Boolean(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);
}

function base(): string {
  return (process.env.APPLE_API_BASE || APPLE_ISSUER).replace(/\/$/, "");
}
export const appleEndpoints = () => ({ authorize: `${base()}/auth/authorize`, token: `${base()}/auth/token`, keys: `${base()}/auth/keys` });
export const appleRedirectUri = () => `${appOrigin()}/api/v1/auth/apple/callback`;

function requireConfigured() {
  if (!appleEnabled()) throw unavailable("apple_not_configured", "Apple 로그인이 설정되지 않았습니다(APPLE_CLIENT_ID/TEAM_ID/KEY_ID/PRIVATE_KEY).");
}

// ---------- client secret (ES256 JWT signed with the .p8 key) ----------
let secretCache: { fingerprint: string; jwt: string; exp: number } | null = null;

/** APPLE_PRIVATE_KEY: PKCS#8 PEM (literal "\n" escapes allowed) or the base64 of the whole .p8 file. */
function privateKeyPem(): string {
  const raw = process.env.APPLE_PRIVATE_KEY!.trim();
  if (raw.includes("BEGIN")) return raw.replace(/\\n/g, "\n");
  return Buffer.from(raw, "base64").toString("utf8");
}

export async function appleClientSecret(nowMs = Date.now()): Promise<string> {
  requireConfigured();
  const pem = privateKeyPem();
  const fingerprint = sha256(`${process.env.APPLE_TEAM_ID}:${process.env.APPLE_KEY_ID}:${process.env.APPLE_CLIENT_ID}:${pem}`);
  if (secretCache && secretCache.fingerprint === fingerprint && secretCache.exp * 1000 - 5 * 60_000 > nowMs) return secretCache.jwt;
  let key: CryptoKey;
  try {
    key = await importPKCS8(pem, "ES256");
  } catch {
    throw unavailable("apple_key_invalid", "APPLE_PRIVATE_KEY 가 올바른 ES256(PKCS#8) 키가 아닙니다.");
  }
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 60 * 60; // Apple allows up to 6 months; short-lived is safer and it is cached
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: process.env.APPLE_KEY_ID! })
    .setIssuer(process.env.APPLE_TEAM_ID!)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setAudience(APPLE_ISSUER)
    .setSubject(process.env.APPLE_CLIENT_ID!)
    .sign(key);
  secretCache = { fingerprint, jwt, exp };
  return jwt;
}

// ---------- id_token verification ----------
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function appleJwks() {
  const url = appleEndpoints().keys;
  let set = jwksByUrl.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 60 * 60_000 });
    jwksByUrl.set(url, set);
  }
  return set;
}

export interface AppleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  isPrivateEmail: boolean;
}

const truthy = (v: unknown) => v === true || v === "true";

export async function verifyAppleIdToken(idToken: string, expectedNonce: string, audience = process.env.APPLE_CLIENT_ID): Promise<AppleIdentity> {
  if (!audience) throw unavailable("apple_not_configured");
  if (typeof idToken !== "string" || idToken.length > 8192 || idToken.split(".").length !== 3) throw new ApiError(401, "apple_invalid_token", "Apple 신원 토큰이 올바르지 않습니다.");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, appleJwks(), { issuer: APPLE_ISSUER, audience, algorithms: ["RS256", "ES256"], clockTolerance: 60, requiredClaims: ["sub", "exp", "iat"] }));
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (code === "ERR_JWT_EXPIRED") throw new ApiError(401, "apple_token_expired", "Apple 인증이 만료되었습니다. 다시 시도하세요.");
    if (code === "ERR_JWKS_TIMEOUT" || (code === "" && /fetch|ECONN|network/i.test((e as Error).message))) {
      throw new ApiError(502, "apple_jwks_unavailable", "Apple 인증 키를 가져오지 못했습니다.");
    }
    log("warn", "apple.id_token_invalid", { code, reason: (e as Error).message?.slice(0, 120) });
    throw new ApiError(401, "apple_invalid_token", "Apple 신원 토큰 검증에 실패했습니다.");
  }
  if (typeof payload.nonce !== "string" || payload.nonce !== expectedNonce) throw new ApiError(401, "apple_nonce_mismatch", "Apple 로그인 요청이 일치하지 않습니다.");
  const sub = String(payload.sub);
  if (!sub || sub.length > 255) throw new ApiError(401, "apple_invalid_token");
  const email = typeof payload.email === "string" ? payload.email : null;
  return {
    sub,
    email,
    // Apple only returns verified addresses (including Hide-My-Email relays); still honor an explicit false
    emailVerified: email ? payload.email_verified === undefined || truthy(payload.email_verified) : false,
    isPrivateEmail: truthy(payload.is_private_email) || isApplePrivateRelay(email),
  };
}

// ---------- start ----------
export async function appleAuthStart(ctx: Ctx, opts: { next?: string | null; consentAccepted?: boolean } = {}): Promise<{ url: string }> {
  requireConfigured();
  await rateLimit(`apple:start:${ctx.ip}`, 30, 600);
  const state = generateToken(32);
  const nonce = generateToken(16);
  await q(
    `INSERT INTO apple_login_states (state_hash, nonce, next_path, consent_accepted, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)`,
    [sha256(state), nonce, opts.next ?? null, Boolean(opts.consentAccepted), String(STATE_TTL_MIN)],
  );
  if (Math.random() < 0.05) {
    void q("DELETE FROM apple_login_states WHERE expires_at < now() - interval '1 day'").catch(() => undefined);
    void q("DELETE FROM apple_pending_profiles WHERE expires_at < now()").catch(() => undefined);
  }
  const params = new URLSearchParams({
    response_type: "code",
    response_mode: "form_post", // required by Apple when the name/email scopes are requested
    client_id: process.env.APPLE_CLIENT_ID!,
    redirect_uri: appleRedirectUri(),
    scope: "name email",
    state,
    nonce,
  });
  return { url: `${appleEndpoints().authorize}?${params}` };
}

// ---------- callback ----------
export interface AppleCallbackInput {
  code: string | null;
  state: string | null;
  /** Apple's first-authorization-only JSON: {"name":{"firstName","lastName"},"email"} — unsigned, used for the display name only */
  user?: string | null;
}

function parseAppleUser(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const u = JSON.parse(raw) as { name?: { firstName?: unknown; lastName?: unknown } };
    return formatAppleName(u?.name);
  } catch {
    return null;
  }
}

async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(appleEndpoints().token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: process.env.APPLE_CLIENT_ID!, client_secret: await appleClientSecret(), code, grant_type: "authorization_code", redirect_uri: appleRedirectUri() }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) {
    log("warn", "apple.token_failed", { status: res?.status ?? 0 });
    throw new ApiError(502, "apple_token_failed", "Apple 인증 서버와 통신하지 못했습니다.");
  }
  const tok = (await res.json().catch(() => ({}))) as { id_token?: string };
  if (!tok.id_token) throw new ApiError(502, "apple_no_id_token", "Apple 인증 응답에 신원 토큰이 없습니다.");
  return tok.id_token;
}

/**
 * Consumes the one-time state, verifies the identity and signs the user in/up. Throws ApiError 422 consent_required
 * (details.next) for a new account whose consents were not accepted before this attempt.
 */
export async function appleCallback(ctx: Ctx, input: AppleCallbackInput, clientKind: ClientKind = "web"): Promise<{ sessionToken: string; userId: string; isNew: boolean; next: string | null; privateEmail: boolean }> {
  requireConfigured();
  await rateLimit(`apple:cb:${ctx.ip}`, 30, 600);
  if (!input.state || input.state.length > 200) throw badRequest("invalid_state", "Apple 로그인 요청이 만료되었거나 이미 사용되었습니다.");
  const st = await one<{ nonce: string; next_path: string | null; consent_accepted: boolean; expires_at: Date }>(
    "UPDATE apple_login_states SET consumed_at=now() WHERE state_hash=$1 AND consumed_at IS NULL RETURNING nonce, next_path, consent_accepted, expires_at",
    [sha256(input.state)],
  );
  if (!st || st.expires_at < new Date()) throw badRequest("invalid_state", "Apple 로그인 요청이 만료되었거나 이미 사용되었습니다.");
  if (!input.code || input.code.length > 2048) throw badRequest("apple_missing_code", "Apple 인증 코드가 없습니다.");
  const idToken = await exchangeCode(input.code);
  const who = await verifyAppleIdToken(idToken, st.nonce);
  const subjectHash = sha256(`apple:${who.sub}`);

  // The name arrives only on the first authorization: park it (encrypted) until the account actually exists.
  // Best effort: a missing vault key (CREDENTIALS_KEY) must not block sign-in — the name is optional.
  let name = parseAppleUser(input.user);
  try {
    if (name) {
      await q(
        `INSERT INTO apple_pending_profiles (subject_hash, encrypted_profile, expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)
         ON CONFLICT (subject_hash) DO UPDATE SET encrypted_profile=EXCLUDED.encrypted_profile, expires_at=EXCLUDED.expires_at`,
        [subjectHash, seal({ name }), String(PENDING_PROFILE_TTL_MIN)],
      );
    } else {
      const pending = await one<{ encrypted_profile: Buffer }>("SELECT encrypted_profile FROM apple_pending_profiles WHERE subject_hash=$1 AND expires_at > now()", [subjectHash]);
      if (pending) name = unseal<{ name: string | null }>(pending.encrypted_profile).name ?? null;
    }
  } catch (e) {
    log("warn", "apple.pending_profile_unavailable", { code: (e as ApiError).code ?? "error" });
  }

  const email = who.email && who.emailVerified ? normalizeEmail(who.email) : null;
  const consents = st.consent_accepted ? REQUIRED_CONSENTS.map((type) => ({ type, granted: true })) : [];
  try {
    return await tx(async (c) => {
      const linked = await one<{ user_id: string }>("SELECT user_id FROM identities WHERE provider='apple' AND provider_subject=$1", [who.sub], c);
      if (!linked && !email) throw new ApiError(401, "apple_email_missing", "Apple 계정이 확인된 이메일을 제공하지 않았습니다.");
      const { user, isNew } = await upsertUserByEmail(c, email ?? "", consents, name ?? undefined, "apple", who.sub);
      const sessionToken = await createSession(c, user.id, ctx, null, clientKind);
      await audit(c, { userId: user.id }, isNew ? "auth.signup" : "auth.login", "user", user.id, { method: "apple", client: clientKind, private_email: who.isPrivateEmail });
      if (isNew) await track(c, "signup_completed", { userId: user.id }, { method: "apple" }); // F-188
      await c.query("DELETE FROM apple_pending_profiles WHERE subject_hash=$1", [subjectHash]);
      return { sessionToken, userId: user.id, isNew, next: st.next_path, privateEmail: who.isPrivateEmail };
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === "consent_required") {
      throw new ApiError(422, "consent_required", e.message, { ...(e.details as object), next: st.next_path });
    }
    throw e;
  }
}
