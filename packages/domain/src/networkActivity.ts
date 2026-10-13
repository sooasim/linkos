// N-109 네트워크 활동 기록(1:1 미팅 · 소개 · 추천사 · 그룹 활동) · N-110 Referral Partner / Ideal Customer Profile.
// 지침: docs/NETWORK_INTELLIGENCE.md §3(관계강도 입력), §10.
//
// 패키지가 BNI 에서 벤치마크한 부분이다: 반복적인 1:1 과 소개 **결과**가 관계의 실제 가치를 만든다.
// 그래서 활동 기록은 장식이 아니라 relationship strength 의 입력(meeting_depth / referral_success / shared_context)이다.
//
// N-110 의 핵심: 단순 업종 일치가 아니라 **교차 소개 가능성**을 본다 — 내 고객상(ICP)을 상대가 갖고 있고,
// 상대의 고객상을 내가 갖고 있을 때 비로소 서로 소개할 이유가 생긴다.

import { textSimilarity } from "./match";
import { industryWithParents } from "./taxonomy";

export const NETWORK_ACTIVITY_TYPES = ["one_to_one", "referral_given", "referral_received", "testimonial", "group_meeting", "introduction", "follow_up"] as const;
export type NetworkActivityType = (typeof NETWORK_ACTIVITY_TYPES)[number];

/** 소개 활동의 결과. referral_success 신호는 이 값에서만 계산한다(추측하지 않는다). */
export const REFERRAL_OUTCOMES = ["pending", "met", "qualified", "won", "lost", "declined"] as const;
export type ReferralOutcome = (typeof REFERRAL_OUTCOMES)[number];

export interface NetworkActivity {
  id: string;
  type: NetworkActivityType;
  occurredAt: Date;
  /** 1:1 미팅 길이(분). 모르면 null */
  durationMinutes: number | null;
  outcome: ReferralOutcome | null;
  /** 같은 조직/챕터 활동이면 그 조직 id */
  organizationId: string | null;
  evidenceId: string | null;
}

export interface ActivityStats {
  oneToOneCount: number;
  oneToOneMinutes: number;
  /** 1:1 미팅 사이의 평균 간격(일). 2회 미만이면 null */
  oneToOneCadenceDays: number | null;
  referralsGiven: number;
  referralsReceived: number;
  /** 결과가 met 이상으로 진행된 소개 수 */
  referralsSucceeded: number;
  testimonials: number;
  groupMeetings: number;
  sharedOrganizations: number;
  lastActivityAt: Date | null;
}

const SUCCESS: ReferralOutcome[] = ["met", "qualified", "won"];

export function activityStats(activities: NetworkActivity[]): ActivityStats {
  const oneToOnes = activities.filter((a) => a.type === "one_to_one").sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const referrals = activities.filter((a) => a.type === "referral_given" || a.type === "referral_received");
  let cadence: number | null = null;
  if (oneToOnes.length >= 2) {
    let sum = 0;
    for (let i = 1; i < oneToOnes.length; i++) sum += oneToOnes[i]!.occurredAt.getTime() - oneToOnes[i - 1]!.occurredAt.getTime();
    cadence = Math.round(sum / (oneToOnes.length - 1) / 864e5);
  }
  const times = activities.map((a) => a.occurredAt.getTime());
  return {
    oneToOneCount: oneToOnes.length,
    oneToOneMinutes: oneToOnes.reduce((a, x) => a + (x.durationMinutes ?? 0), 0),
    oneToOneCadenceDays: cadence,
    referralsGiven: activities.filter((a) => a.type === "referral_given").length,
    referralsReceived: activities.filter((a) => a.type === "referral_received").length,
    referralsSucceeded: referrals.filter((a) => a.outcome !== null && SUCCESS.includes(a.outcome)).length,
    testimonials: activities.filter((a) => a.type === "testimonial").length,
    groupMeetings: activities.filter((a) => a.type === "group_meeting").length,
    sharedOrganizations: new Set(activities.map((a) => a.organizationId).filter((x): x is string => !!x)).size,
    lastActivityAt: times.length ? new Date(Math.max(...times)) : null,
  };
}

/**
 * 활동 기록을 관계강도 관측값에 더한다. 활동이 있는 쪽만 덮어쓰고 나머지는 호출자 값을 유지한다 —
 * 활동 기록이 없다고 미팅 횟수를 0 으로 되돌리면 안 된다(다른 출처가 있을 수 있다).
 */
export function activityContribution(s: ActivityStats): { meetingsTotal: number; meetingMinutesTotal: number; referralsGiven: number; referralsSucceeded: number; sharedOrganizations: number } {
  return {
    meetingsTotal: s.oneToOneCount + s.groupMeetings,
    meetingMinutesTotal: s.oneToOneMinutes,
    referralsGiven: s.referralsGiven + s.referralsReceived,
    referralsSucceeded: s.referralsSucceeded,
    sharedOrganizations: s.sharedOrganizations,
  };
}

/** BNI 형 1:1 리듬 진단. "다음에 뭘 해야 하는가"를 알려주는 용도다. */
export function oneToOneHealth(s: ActivityStats, now: Date = new Date()): { state: "healthy" | "due" | "never" | "lapsed"; text: string } {
  if (!s.oneToOneCount) return { state: "never", text: "아직 1:1 미팅 기록이 없습니다. 첫 1:1 을 제안해 보세요." };
  const last = s.lastActivityAt ? Math.round((now.getTime() - s.lastActivityAt.getTime()) / 864e5) : null;
  const target = s.oneToOneCadenceDays ?? 90;
  if (last == null) return { state: "healthy", text: `1:1 ${s.oneToOneCount}회 기록` };
  if (last > target * 2) return { state: "lapsed", text: `평소 ${target}일 간격이었는데 ${last}일째 활동이 없습니다` };
  if (last > target) return { state: "due", text: `1:1 주기(${target}일)가 지났습니다 — ${last}일 경과` };
  return { state: "healthy", text: `1:1 ${s.oneToOneCount}회 · 평균 ${target}일 간격으로 유지되고 있습니다` };
}

// ---------- N-110 Ideal Customer Profile ----------

export interface IdealCustomerProfile {
  /** 내가 팔고 싶은 대상의 산업 */
  industries: string[];
  regions: string[];
  /** 의사결정자의 역할 카테고리 */
  roleCategories: string[];
  /** 그 고객이 보통 갖고 있는 Need */
  needs: string[];
  /** 자유 설명 — 사용자가 직접 쓴다 */
  description?: string | null;
}

export interface IcpFitResult {
  score: number;
  reasons: string[];
}

/** 후보가 내 ICP 에 얼마나 맞는가. 조건이 비어 있으면 그 축은 계산에서 빠진다. */
export function icpFit(candidate: { industries: string[]; regions: string[]; roleCategories: string[]; needs: string[] }, icp: IdealCustomerProfile): IcpFitResult {
  const reasons: string[] = [];
  const parts: number[] = [];
  const hit = (want: string[], have: string[], label: string, expand = false): void => {
    if (!want.length) return;
    const W = expand ? want.flatMap(industryWithParents) : want;
    const H = new Set((expand ? have.flatMap(industryWithParents) : have).map((x) => x.toLowerCase()));
    const matched = [...new Set(W.filter((w) => H.has(w.toLowerCase())))];
    parts.push(matched.length ? 1 : 0);
    if (matched.length) reasons.push(`${label} 일치: ${matched.slice(0, 3).join(", ")}`);
  };
  hit(icp.industries, candidate.industries, "산업", true);
  hit(icp.regions, candidate.regions, "지역");
  hit(icp.roleCategories, candidate.roleCategories, "의사결정 역할");
  if (icp.needs.length && candidate.needs.length) {
    let best = 0;
    for (const n of icp.needs) for (const c of candidate.needs) best = Math.max(best, textSimilarity(n, c));
    parts.push(Math.min(1, best * 1.3));
    if (best > 0.2) reasons.push("고객상에 적은 Need 와 상대가 밝힌 Need 가 유사합니다");
  }
  const score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  return { score: Math.round(score * 1000) / 1000, reasons };
}

// ---------- N-110 Referral Partner ----------

export interface ReferralPartnerInput {
  /** 내 정보 */
  me: { icp: IdealCustomerProfile; capabilities: string[] };
  /** 상대 정보 */
  other: {
    id: string;
    icp: IdealCustomerProfile;
    capabilities: string[];
    /** 상대가 보유한(= 소개해 줄 수 있는) 연락처의 산업/역할 분포 */
    networkIndustries: string[];
    networkRoleCategories: string[];
    /** 나와 상대의 관계강도 0..1 */
    strength: number;
    hops: number;
    /** 상대가 과거에 소개를 실제로 해 줬는가 0..1 */
    referralTrack: number;
  };
}

export interface ReferralPartnerResult {
  partnerId: string;
  /** 0..100 */
  score: number;
  /** 상대의 네트워크가 내 ICP 를 갖고 있는 정도 */
  inboundPotential: number;
  /** 내 역량이 상대의 ICP 에 맞는 정도(= 내가 상대에게 줄 수 있는 것) */
  outboundPotential: number;
  /** 서로 줄 것이 있는가 — 한쪽만 이득이면 교차소개가 지속되지 않는다 */
  reciprocal: boolean;
  reasons: string[];
}

/**
 * 교차 소개 가능성. 양방향성을 명시적으로 본다:
 *  inbound  = 상대의 네트워크 ∩ 내 ICP      (상대가 나에게 소개해 줄 수 있는가)
 *  outbound = 내 역량 ∩ 상대의 ICP          (내가 상대에게 줄 수 있는가)
 * 한쪽만 높으면 reciprocal=false 로 표시해 사용자가 기대치를 알 수 있게 한다.
 */
export function referralPartnerFit(input: ReferralPartnerInput): ReferralPartnerResult {
  const { me, other } = input;
  const reasons: string[] = [];

  const inbound = icpFit({ industries: other.networkIndustries, regions: other.icp.regions, roleCategories: other.networkRoleCategories, needs: [] }, me.icp);
  if (inbound.score > 0) reasons.push(`상대 네트워크에 내 고객상과 맞는 분들이 있습니다 — ${inbound.reasons[0] ?? "산업 분포 일치"}`);

  let outbound = 0;
  for (const cap of me.capabilities) {
    for (const need of [...other.icp.needs, ...other.icp.industries]) outbound = Math.max(outbound, textSimilarity(cap, need));
  }
  outbound = Math.min(1, outbound * 1.3);
  if (outbound > 0.2) reasons.push("내 역량이 상대의 고객상이 필요로 하는 것과 맞습니다");

  const reciprocal = inbound.score >= 0.3 && outbound >= 0.3;
  if (!reciprocal) reasons.push(inbound.score > outbound ? "지금은 내가 받을 쪽이 큽니다 — 먼저 줄 것을 찾으면 관계가 지속됩니다" : "지금은 내가 줄 쪽이 큽니다");
  if (other.referralTrack > 0.5) reasons.push("과거에 실제로 소개를 해 준 이력이 있습니다");
  if (other.hops > 1) reasons.push(`${other.hops}촌 — 먼저 소개를 받아 관계를 만들어야 합니다`);

  const raw = 0.38 * inbound.score + 0.3 * outbound + 0.14 * other.strength + 0.12 * other.referralTrack + 0.06 * (other.hops <= 1 ? 1 : other.hops === 2 ? 0.5 : 0.2);
  return {
    partnerId: other.id,
    score: Math.round(100 * Math.max(0, Math.min(1, raw)) * 10) / 10,
    inboundPotential: inbound.score,
    outboundPotential: Math.round(outbound * 1000) / 1000,
    reciprocal,
    reasons: reasons.slice(0, 4),
  };
}

export function rankReferralPartners(me: ReferralPartnerInput["me"], others: ReferralPartnerInput["other"][], limit = 20): ReferralPartnerResult[] {
  return others
    .map((other) => referralPartnerFit({ me, other }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.reciprocal) - Number(a.reciprocal))
    .slice(0, limit);
}
