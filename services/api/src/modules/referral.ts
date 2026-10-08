// growth module — F-064 Referral Attribution (privacy-safe: user ids only) · F-197 Referral Reward (P3, 실험 — REFERRAL_REWARDS_ENABLED=1 일 때만)
import { REWARD_RULES, type ReferralSource, attributable, generateToken, rewardDecision } from "@linkos/domain";
import { type Db, one, pool, q, tx } from "../lib/db";
import { unauthorized } from "../lib/errors";
import { type Ctx, appOrigin, audit } from "../lib/platform";

export function rewardsEnabled(): boolean {
  return process.env.REFERRAL_REWARDS_ENABLED === "1";
}

/**
 * Record who brought a new account in. Must be called with the caller's transaction client.
 * Only NEW accounts (created after the touchpoint, within the window) are attributed, once.
 */
export async function recordReferral(
  db: Db,
  r: { referrerId: string; referredId: string; source: ReferralSource; touchpointAt: Date; exchangeSessionId?: string | null; organizationId?: string | null },
): Promise<{ attributed: boolean; reason?: string }> {
  const u = await one<{ created_at: Date; is_guest: boolean }>("SELECT created_at, is_guest FROM users WHERE id=$1", [r.referredId], db);
  if (!u) return { attributed: false, reason: "no_user" };
  const exists = await one("SELECT 1 FROM referral_attributions WHERE referred_user_id=$1", [r.referredId], db);
  const d = attributable({ referrerId: r.referrerId, referredId: r.referredId, referredCreatedAt: u.created_at, touchpointAt: r.touchpointAt, alreadyAttributed: Boolean(exists) });
  if (!d.ok) return { attributed: false, reason: d.reason };
  const row = await one<{ id: string }>(
    `INSERT INTO referral_attributions (referrer_user_id, referred_user_id, source, exchange_session_id, organization_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (referred_user_id) DO NOTHING RETURNING id`,
    [r.referrerId, r.referredId, r.source, r.exchangeSessionId ?? null, r.organizationId ?? null],
    db,
  );
  if (!row) return { attributed: false, reason: "already_attributed" };
  if (rewardsEnabled()) {
    await db.query("INSERT INTO referral_rewards (user_id, attribution_id, amount, status, reason) VALUES ($1,$2,$3,'pending','awaiting_activation')", [r.referrerId, row.id, REWARD_RULES.pointsPerReferral]);
  }
  await audit(db, { userId: r.referredId }, "referral.attributed", "referral_attribution", row.id, { source: r.source });
  return { attributed: true };
}

async function ensureCode(userId: string, db: Db = pool()): Promise<string> {
  const cur = await one<{ referral_code: string | null }>("SELECT referral_code FROM users WHERE id=$1", [userId], db);
  if (cur?.referral_code) return cur.referral_code;
  for (let i = 0; i < 5; i++) {
    const code = generateToken(16).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
    if (code.length < 8) continue;
    const r = await one<{ referral_code: string }>("UPDATE users SET referral_code=$2 WHERE id=$1 AND referral_code IS NULL RETURNING referral_code", [userId, code], db).catch(() => null);
    if (r) return r.referral_code;
    const again = await one<{ referral_code: string | null }>("SELECT referral_code FROM users WHERE id=$1", [userId], db);
    if (again?.referral_code) return again.referral_code;
  }
  throw new Error("could not allocate referral code");
}

export function isReferralCode(code: string | null | undefined): code is string {
  return !!code && /^[A-Z0-9]{8}$/.test(code);
}

/**
 * Link-based attribution inside the sign-up transaction (/r/{code} → lk_ref cookie → any sign-up method: email OTP,
 * Google OAuth/One Tap, Apple, OIDC/SAML SSO). Only NEW accounts are attributed, once (recordReferral rules).
 */
export async function attributeSignupByCodeTx(db: Db, referredUserId: string, code: string | null | undefined): Promise<{ attributed: boolean; reason?: string }> {
  if (!isReferralCode(code)) return { attributed: false, reason: "invalid_code" };
  const ref = await one<{ id: string }>("SELECT id FROM users WHERE referral_code=$1 AND status='active'", [code], db);
  if (!ref) return { attributed: false, reason: "unknown_code" };
  return recordReferral(db, { referrerId: ref.id, referredId: referredUserId, source: "link", touchpointAt: new Date(Date.now() - 60_000) });
}

/** Link-based attribution (/r/{code} → cookie → signup). Called right after a NEW account is created. */
export async function attributeSignupByCode(referredUserId: string, code: string | null | undefined): Promise<{ attributed: boolean; reason?: string }> {
  if (!isReferralCode(code)) return { attributed: false, reason: "invalid_code" };
  return tx((c) => attributeSignupByCodeTx(c, referredUserId, code));
}

export async function myReferrals(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  const code = await ensureCode(ctx.userId);
  const bySource = await q<{ source: string; n: number }>(
    "SELECT source, count(*)::int AS n FROM referral_attributions WHERE referrer_user_id=$1 GROUP BY source",
    [ctx.userId],
  );
  const recent = await q<{ id: string; source: string; created_at: Date; display_name: string | null }>(
    `SELECT a.id, a.source, a.created_at, u.display_name FROM referral_attributions a JOIN users u ON u.id = a.referred_user_id
     WHERE a.referrer_user_id=$1 ORDER BY a.created_at DESC LIMIT 20`,
    [ctx.userId],
  );
  const rewards = await one<{ granted: number; pending: number; capped: number }>(
    `SELECT COALESCE(sum(amount) FILTER (WHERE status='granted'),0)::int AS granted,
            COALESCE(sum(amount) FILTER (WHERE status='pending'),0)::int AS pending,
            count(*) FILTER (WHERE status='capped')::int AS capped
     FROM referral_rewards WHERE user_id=$1`,
    [ctx.userId],
  );
  return {
    code,
    link: `${appOrigin()}/r/${code}`,
    total: bySource.reduce((a, r) => a + r.n, 0),
    bySource: Object.fromEntries(bySource.map((r) => [r.source, r.n])),
    // referred people are shown by display name only (no email/phone) — privacy-safe attribution
    recent: recent.map((r) => ({ id: r.id, source: r.source, at: r.created_at, name: r.display_name ?? "새 사용자" })),
    rewards: { enabled: rewardsEnabled(), experimental: true, ...rewards, rules: REWARD_RULES },
  };
}

/** Worker: pending rewards → granted once the referred user completed ≥1 exchange; monthly cap per referrer. */
export async function processReferralRewards(limit = 100): Promise<number> {
  if (!rewardsEnabled()) return 0;
  const pending = await q<{ id: string; user_id: string; referred_user_id: string }>(
    `SELECT r.id, r.user_id, a.referred_user_id FROM referral_rewards r JOIN referral_attributions a ON a.id = r.attribution_id
     WHERE r.status='pending' ORDER BY r.created_at LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const p of pending) {
    await tx(async (c) => {
      const activated = await one(
        "SELECT 1 FROM exchange_sessions WHERE sender_user_id=$1 AND state IN ('EXCHANGED','CLAIM_PENDING','CLAIMED','SYNCED') LIMIT 1",
        [p.referred_user_id],
        c,
      );
      const granted = await one<{ n: number }>(
        "SELECT count(*)::int AS n FROM referral_rewards WHERE user_id=$1 AND status='granted' AND granted_at >= date_trunc('month', now())",
        [p.user_id],
        c,
      );
      const d = rewardDecision({ referredActivated: Boolean(activated), grantedThisMonth: granted?.n ?? 0 });
      if (d === "wait") return;
      await c.query(
        "UPDATE referral_rewards SET status=$2, reason=$3, granted_at=CASE WHEN $2='granted' THEN now() ELSE NULL END WHERE id=$1 AND status='pending'",
        [p.id, d === "grant" ? "granted" : "capped", d === "grant" ? "referred_user_activated" : "monthly_cap"],
      );
      await audit(c, { userId: null }, d === "grant" ? "referral.reward_granted" : "referral.reward_capped", "referral_reward", p.id);
      n++;
    });
  }
  return n;
}
