// X-003 card view analytics — privacy-preserving daily counters (no IP, no cookie id, no hash: just counts).
// Counting is skipped when the card owner opted out of analytics, when the viewer sends GPC/DNT, and for the owner's own views.
import { type CardViewKind, CLIENT_CARD_VIEW_KINDS, fillDailySeries, utcDay, viewCountingAllowed } from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q } from "../lib/db";
import { unauthorized } from "../lib/errors";
import { type Ctx, audit, rateLimit } from "../lib/platform";

const NO_SESSION = "00000000-0000-0000-0000-000000000000";

export interface ViewSignal {
  profileId: string;
  sessionId?: string | null;
  kind: CardViewKind;
  viewerUserId?: string | null;
  gpc?: string | null;
  dnt?: string | null;
}

/** Increment today's counter. Returns false when counting was suppressed (opt-out / GPC / DNT / owner / unknown profile). */
export async function recordView(s: ViewSignal, db: Db = pool()): Promise<boolean> {
  const owner = await one<{ user_id: string | null; analytics_opt_out: boolean }>(
    "SELECT p.user_id, COALESCE(u.analytics_opt_out, false) AS analytics_opt_out FROM profiles p LEFT JOIN users u ON u.id=p.user_id WHERE p.id=$1",
    [s.profileId],
    db,
  );
  if (!owner) return false;
  if (!viewCountingAllowed({ ownerOptOut: owner.analytics_opt_out, gpc: s.gpc, dnt: s.dnt, isOwner: !!s.viewerUserId && s.viewerUserId === owner.user_id })) return false;
  await db.query(
    `INSERT INTO card_view_daily (profile_id, exchange_session_id, day, kind, count) VALUES ($1,$2,$3,$4,1)
     ON CONFLICT (profile_id, exchange_session_id, day, kind) DO UPDATE SET count = card_view_daily.count + 1`,
    [s.profileId, s.sessionId ?? NO_SESSION, utcDay(new Date()), s.kind],
  );
  return true;
}

/** Browser-reported CTA taps / vCard saves. The session (when given) must belong to the profile. */
export const clientSignalInput = z.object({
  profileId: z.string().uuid(),
  sessionId: z.string().uuid().nullish(),
  kind: z.enum(CLIENT_CARD_VIEW_KINDS as unknown as [CardViewKind, ...CardViewKind[]]),
});

export async function recordClientSignal(ctx: Ctx, input: z.infer<typeof clientSignalInput>, privacy: { gpc?: string | null; dnt?: string | null }): Promise<{ counted: boolean }> {
  await rateLimit(`cardview:${ctx.ip}`, 60, 60);
  if (input.sessionId) {
    const ok = await one("SELECT 1 FROM exchange_sessions WHERE id=$1 AND sender_profile_id=$2", [input.sessionId, input.profileId]);
    if (!ok) return { counted: false };
  }
  return { counted: await recordView({ ...input, viewerUserId: ctx.userId, ...privacy }) };
}

export async function getPreference(userId: string) {
  const r = await one<{ analytics_opt_out: boolean }>("SELECT analytics_opt_out FROM users WHERE id=$1", [userId]);
  return { optOut: r?.analytics_opt_out ?? false };
}

/** Opting out also deletes the counters collected so far. */
export async function setPreference(ctx: Ctx, optOut: boolean) {
  if (!ctx.userId) throw unauthorized();
  await pool().query("UPDATE users SET analytics_opt_out=$2, updated_at=now() WHERE id=$1", [ctx.userId, optOut]);
  let purged = 0;
  if (optOut) {
    const r = await pool().query("DELETE FROM card_view_daily WHERE profile_id IN (SELECT id FROM profiles WHERE user_id=$1)", [ctx.userId]);
    purged = r.rowCount ?? 0;
  }
  await audit(pool(), ctx, optOut ? "analytics.opted_out" : "analytics.opted_in", "user", ctx.userId, { purged });
  return { optOut, purged };
}

const KINDS: CardViewKind[] = ["view", "cta", "vcard", "reply", "link_sig", "link_bg", "link_wallet"];

/** /app/insights: totals, 30-day series per kind, top exchange sessions and profiles. */
export async function cardViewInsights(userId: string, days = 30) {
  const d = Math.min(90, Math.max(7, days));
  const pref = await getPreference(userId);
  const rows = await q<{ day: Date; kind: CardViewKind; count: number }>(
    `SELECT v.day, v.kind, sum(v.count)::int AS count FROM card_view_daily v JOIN profiles p ON p.id=v.profile_id
     WHERE p.user_id=$1 AND v.day > current_date - $2::int GROUP BY v.day, v.kind`,
    [userId, d],
  );
  const today = new Date();
  const series = Object.fromEntries(KINDS.map((k) => [k, fillDailySeries(rows.filter((r) => r.kind === k).map((r) => ({ day: utcDay(new Date(r.day)), count: r.count })), d, today)])) as Record<CardViewKind, number[]>;
  const totals = Object.fromEntries(KINDS.map((k) => [k, series[k].reduce((a, b) => a + b, 0)])) as Record<CardViewKind, number>;
  const sessions = await q<{ id: string; created_at: Date; place_label: string | null; is_group: boolean; view: number; cta: number; vcard: number; reply: number }>(
    `SELECT s.id, s.created_at, s.context->>'placeLabel' AS place_label, s.is_group,
       sum(v.count) FILTER (WHERE v.kind='view')::int AS view, sum(v.count) FILTER (WHERE v.kind='cta')::int AS cta,
       sum(v.count) FILTER (WHERE v.kind='vcard')::int AS vcard, sum(v.count) FILTER (WHERE v.kind='reply')::int AS reply
     FROM card_view_daily v JOIN exchange_sessions s ON s.id=v.exchange_session_id
     WHERE s.sender_user_id=$1 AND v.day > current_date - $2::int GROUP BY s.id ORDER BY s.created_at DESC LIMIT 10`,
    [userId, d],
  );
  const profiles = await q<{ id: string; name: string; view: number; cta: number; vcard: number; reply: number }>(
    `SELECT p.id, p.name, COALESCE(sum(v.count) FILTER (WHERE v.kind='view'),0)::int AS view, COALESCE(sum(v.count) FILTER (WHERE v.kind='cta'),0)::int AS cta,
       COALESCE(sum(v.count) FILTER (WHERE v.kind='vcard'),0)::int AS vcard, COALESCE(sum(v.count) FILTER (WHERE v.kind='reply'),0)::int AS reply
     FROM profiles p LEFT JOIN card_view_daily v ON v.profile_id=p.id AND v.day > current_date - $2::int
     WHERE p.user_id=$1 GROUP BY p.id ORDER BY p.is_primary DESC, p.created_at`,
    [userId, d],
  );
  return {
    windowDays: d,
    optOut: pref.optOut,
    totals,
    series,
    sessions: sessions.map((s) => ({ sessionId: s.id, createdAt: s.created_at, placeLabel: s.place_label, isGroup: s.is_group, view: s.view ?? 0, cta: s.cta ?? 0, vcard: s.vcard ?? 0, reply: s.reply ?? 0 })),
    profiles,
  };
}
