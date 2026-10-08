// F-064 Referral Attribution (privacy-safe: user ids only, never the guest's contact details) · F-197 Referral Reward (P3, 실험)
// F-159 소개 성과 (소개 → 미팅 → 기회 전환)

export const REFERRAL_SOURCES = ["exchange_claim", "org_invite", "link"] as const;
export type ReferralSource = (typeof REFERRAL_SOURCES)[number];

/** Attribution window: the referred account must have been created within this window of the referral touchpoint. */
export const ATTRIBUTION_WINDOW_MS = 7 * 864e5;

export function attributable(args: { referrerId: string; referredId: string; referredCreatedAt: Date; touchpointAt: Date; alreadyAttributed: boolean }): { ok: boolean; reason?: string } {
  if (args.referrerId === args.referredId) return { ok: false, reason: "self" };
  if (args.alreadyAttributed) return { ok: false, reason: "already_attributed" };
  // only NEW accounts count: created after (or at) the touchpoint and within the window
  const dt = args.referredCreatedAt.getTime() - args.touchpointAt.getTime();
  if (dt < -60_000) return { ok: false, reason: "existing_user" };
  if (dt > ATTRIBUTION_WINDOW_MS) return { ok: false, reason: "outside_window" };
  return { ok: true };
}

export const REWARD_RULES = { pointsPerReferral: 100, monthlyCapPerReferrer: 20 } as const;

/** Reward is granted only once the referred user is genuinely active (completed ≥1 exchange), with a monthly cap. */
export function rewardDecision(args: { referredActivated: boolean; grantedThisMonth: number }): "grant" | "wait" | "cap" {
  if (!args.referredActivated) return "wait";
  if (args.grantedThisMonth >= REWARD_RULES.monthlyCapPerReferrer) return "cap";
  return "grant";
}

export const INTRO_OUTCOMES = ["none", "meeting", "opportunity", "won", "lost"] as const;
export type IntroOutcome = (typeof INTRO_OUTCOMES)[number];

export interface IntroStatsInput {
  state: string;
  outcome: IntroOutcome;
}

export function introStats(rows: IntroStatsInput[]) {
  const total = rows.length;
  const accepted = rows.filter((r) => ["PARTY_B_ACCEPTED", "ROOM_CREATED", "MEETING_BOOKED", "ACTIVE", "WON"].includes(r.state) || ["meeting", "opportunity", "won"].includes(r.outcome)).length;
  const meetings = rows.filter((r) => ["meeting", "opportunity", "won"].includes(r.outcome) || ["MEETING_BOOKED", "ACTIVE", "WON"].includes(r.state)).length;
  const opportunities = rows.filter((r) => ["opportunity", "won"].includes(r.outcome)).length;
  const won = rows.filter((r) => r.outcome === "won" || r.state === "WON").length;
  const declined = rows.filter((r) => r.state === "DECLINED").length;
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    total,
    accepted,
    meetings,
    opportunities,
    won,
    declined,
    acceptRate: pct(accepted, total),
    meetingRate: pct(meetings, accepted),
    opportunityRate: pct(opportunities, meetings),
    winRate: pct(won, total),
  };
}
