// passkey module — F-006 Passkey (WebAuthn, @simplewebauthn/server). Server-side challenge storage, one-time use,
// 5-minute TTL, counter regression rejected by the library, discoverable-credential login supported.
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { normalizeEmail } from "@linkos/domain";
import { z } from "zod";
import { one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, notFound, unauthorized } from "../lib/errors";
import { type Ctx, appOrigin, audit, log, rateLimit } from "../lib/platform";
import { createSession } from "./identity";
import { assertSsoAllowed } from "./ssoPolicy";

const CHALLENGE_TTL = "5 minutes";

export function rpConfig() {
  const origin = appOrigin();
  const extra = (process.env.WEBAUTHN_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { rpID: process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname, rpName: "LINKOS", origins: [origin, ...extra] };
}

export async function registrationOptions(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  const u = await one<{ id: string; email: string | null; display_name: string | null }>("SELECT id, email, display_name FROM users WHERE id=$1", [ctx.userId]);
  if (!u) throw unauthorized();
  const existing = await q<{ credential_id: string; transports: string[] }>("SELECT credential_id, transports FROM webauthn_credentials WHERE user_id=$1", [u.id]);
  const rp = rpConfig();
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: u.email ?? u.id,
    userDisplayName: u.display_name ?? u.email ?? "LINKOS",
    userID: new TextEncoder().encode(u.id),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports as AuthenticatorTransportFuture[] })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  await q(`INSERT INTO webauthn_challenges (user_id, kind, challenge, expires_at) VALUES ($1,'register',$2, now() + interval '${CHALLENGE_TTL}')`, [u.id, options.challenge]);
  return options;
}

export const registerVerifyInput = z.object({ response: z.record(z.string(), z.unknown()), name: z.string().trim().max(60).nullish() });

export async function verifyRegistration(ctx: Ctx, input: z.infer<typeof registerVerifyInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const response = input.response as unknown as RegistrationResponseJSON;
  return tx(async (c) => {
    // consume the most recent live challenge for this user (one-time)
    const ch = await one<{ id: string; challenge: string }>(
      `UPDATE webauthn_challenges SET consumed_at=now() WHERE id = (
         SELECT id FROM webauthn_challenges WHERE user_id=$1 AND kind='register' AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1
       ) RETURNING id, challenge`,
      [userId],
      c,
    );
    if (!ch) throw badRequest("challenge_expired", "등록 요청이 만료되었습니다. 다시 시도하세요.");
    const rp = rpConfig();
    let v;
    try {
      v = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: false });
    } catch (e) {
      log("warn", "passkey.register_failed", { error: (e as Error).message });
      throw badRequest("passkey_verification_failed", "패스키 등록을 확인하지 못했습니다.");
    }
    if (!v.verified) throw badRequest("passkey_verification_failed");
    const cred = v.registrationInfo.credential;
    const dup = await one("SELECT 1 FROM webauthn_credentials WHERE credential_id=$1", [cred.id], c);
    if (dup) throw new ApiError(409, "passkey_exists", "이미 등록된 패스키입니다.");
    const r = await one<{ id: string; created_at: Date }>(
      "INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at",
      [userId, cred.id, Buffer.from(cred.publicKey), cred.counter, cred.transports ?? response.response?.transports ?? [], v.registrationInfo.credentialDeviceType, v.registrationInfo.credentialBackedUp, input.name ?? null],
      c,
    );
    await audit(c, ctx, "auth.passkey_registered", "webauthn_credential", r!.id, { deviceType: v.registrationInfo.credentialDeviceType });
    return { id: r!.id, name: input.name ?? null, createdAt: r!.created_at };
  });
}

export async function authenticationOptions(ctx: Ctx, email?: string | null) {
  await rateLimit(`passkey:opts:${ctx.ip}`, 30, 600);
  const rp = rpConfig();
  let allow: { id: string; transports?: AuthenticatorTransportFuture[] }[] | undefined;
  let userId: string | null = null;
  const e = email ? normalizeEmail(email) : null;
  if (e) {
    const u = await one<{ id: string }>("SELECT id FROM users WHERE email=$1 AND status='active'", [e]);
    if (u) {
      userId = u.id;
      allow = (await q<{ credential_id: string; transports: string[] }>("SELECT credential_id, transports FROM webauthn_credentials WHERE user_id=$1", [u.id])).map((c) => ({
        id: c.credential_id,
        transports: c.transports as AuthenticatorTransportFuture[],
      }));
    }
    // unknown email → behave like discoverable login (no account enumeration)
  }
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, allowCredentials: allow?.length ? allow : undefined, userVerification: "preferred" });
  const ch = await one<{ id: string }>(`INSERT INTO webauthn_challenges (user_id, kind, challenge, expires_at) VALUES ($1,'login',$2, now() + interval '${CHALLENGE_TTL}') RETURNING id`, [
    userId,
    options.challenge,
  ]);
  return { challengeId: ch!.id, options };
}

export const loginVerifyInput = z.object({ challengeId: z.string().uuid(), response: z.record(z.string(), z.unknown()) });

export async function verifyAuthentication(ctx: Ctx, input: z.infer<typeof loginVerifyInput>) {
  await rateLimit(`passkey:verify:${ctx.ip}`, 30, 600);
  const response = input.response as unknown as AuthenticationResponseJSON;
  return tx(async (c) => {
    const ch = await one<{ challenge: string; user_id: string | null }>(
      "UPDATE webauthn_challenges SET consumed_at=now() WHERE id=$1 AND kind='login' AND consumed_at IS NULL AND expires_at > now() RETURNING challenge, user_id",
      [input.challengeId],
      c,
    );
    if (!ch) throw badRequest("challenge_expired", "로그인 요청이 만료되었습니다. 다시 시도하세요.");
    const cred = await one<{ id: string; user_id: string; credential_id: string; public_key: Buffer; counter: string; transports: string[]; status: string }>(
      "SELECT w.*, u.status FROM webauthn_credentials w JOIN users u ON u.id=w.user_id WHERE w.credential_id=$1 FOR UPDATE OF w",
      [String(response.id ?? "")],
      c,
    );
    if (!cred || (ch.user_id && ch.user_id !== cred.user_id)) throw unauthorized("등록되지 않은 패스키입니다.");
    if (cred.status !== "active") throw new ApiError(403, "account_disabled", "비활성화된 계정입니다.");
    const rp = rpConfig();
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpID,
        credential: { id: cred.credential_id, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.counter), transports: cred.transports as AuthenticatorTransportFuture[] },
        requireUserVerification: false,
      });
    } catch (e) {
      log("warn", "passkey.login_failed", { error: (e as Error).message });
      throw unauthorized("패스키를 확인하지 못했습니다.");
    }
    if (!v.verified) throw unauthorized("패스키를 확인하지 못했습니다.");
    await c.query("UPDATE webauthn_credentials SET counter=$2, last_used_at=now() WHERE id=$1", [cred.id, v.authenticationInfo.newCounter]);
    // F-008 sso_required (checked only after the passkey itself verified)
    const owner = await one<{ email: string | null }>("SELECT email FROM users WHERE id=$1", [cred.user_id], c);
    if (owner?.email) await assertSsoAllowed(c, owner.email, "passkey"); // F-008 sso_required
    const token = await createSession(c, cred.user_id, ctx, null, "web", "passkey");
    await audit(c, { userId: cred.user_id }, "auth.login", "user", cred.user_id, { method: "passkey" });
    return { userId: cred.user_id, sessionToken: token };
  });
}

export async function listPasskeys(userId: string) {
  return q<{ id: string; name: string | null; device_type: string | null; backed_up: boolean; created_at: Date; last_used_at: Date | null }>(
    "SELECT id, name, device_type, backed_up, created_at, last_used_at FROM webauthn_credentials WHERE user_id=$1 ORDER BY created_at DESC",
    [userId],
  );
}

export async function deletePasskey(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one("DELETE FROM webauthn_credentials WHERE id=$1 AND user_id=$2 RETURNING id", [id, ctx.userId]);
  if (!r) throw notFound("passkey");
  await audit(pool(), ctx, "auth.passkey_deleted", "webauthn_credential", id);
  return { deleted: true };
}
