// F-074 관계 강도 (최근접촉/빈도/미팅/메모/후속/상호연결 신호) · F-098 미접촉 위험 (VIP/유망 관계 방치 탐지)
// 모든 점수는 설명 가능한 factor 목록과 함께 반환된다(백서: AI 추론은 근거를 보여준다).

export interface StrengthSignals {
  daysSinceLastContact: number | null;
  encounters90d: number;
  encountersTotal: number;
  meetingsTotal: number;
  notesTotal: number;
  followupsDone: number;
  /** the contact is a LINKOS user who also has me in their book (two-way exchange) */
  reciprocal: boolean;
}

export interface StrengthFactor {
  kind: "recency" | "frequency" | "meetings" | "notes" | "followups" | "reciprocal";
  value: number;
  contribution: number;
  text: string;
}

export interface StrengthResult {
  score: number; // 0..1
  band: "strong" | "medium" | "weak";
  factors: StrengthFactor[];
}

export const STRENGTH_WEIGHTS = { recency: 0.35, frequency: 0.2, meetings: 0.2, notes: 0.08, followups: 0.07, reciprocal: 0.1 } as const;

const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeStrength(s: StrengthSignals): StrengthResult {
  const W = STRENGTH_WEIGHTS;
  const recency = s.daysSinceLastContact == null ? 0 : Math.exp(-Math.max(0, s.daysSinceLastContact) / 60);
  const frequency = Math.min(1, s.encounters90d / 4) * 0.7 + Math.min(1, s.encountersTotal / 10) * 0.3;
  const meetings = Math.min(1, s.meetingsTotal / 3);
  const notes = Math.min(1, s.notesTotal / 3);
  const followups = Math.min(1, s.followupsDone / 2);
  const reciprocal = s.reciprocal ? 1 : 0;
  const factors: StrengthFactor[] = [
    { kind: "recency", value: r2(recency), contribution: r2(W.recency * recency), text: s.daysSinceLastContact == null ? "접촉 기록 없음" : `마지막 접촉 ${Math.round(s.daysSinceLastContact)}일 전` },
    { kind: "frequency", value: r2(frequency), contribution: r2(W.frequency * frequency), text: `최근 90일 접촉 ${s.encounters90d}회 · 누적 ${s.encountersTotal}회` },
    { kind: "meetings", value: r2(meetings), contribution: r2(W.meetings * meetings), text: `함께한 미팅 ${s.meetingsTotal}회` },
    { kind: "notes", value: r2(notes), contribution: r2(W.notes * notes), text: `메모 ${s.notesTotal}개` },
    { kind: "followups", value: r2(followups), contribution: r2(W.followups * followups), text: `완료한 후속 ${s.followupsDone}건` },
    { kind: "reciprocal", value: reciprocal, contribution: r2(W.reciprocal * reciprocal), text: s.reciprocal ? "서로 연결된 LINKOS 사용자" : "단방향 연락처" },
  ];
  const score = r2(Math.min(1, factors.reduce((a, f) => a + W[f.kind] * f.value, 0)));
  return { score, band: score >= 0.55 ? "strong" : score >= 0.3 ? "medium" : "weak", factors: factors.sort((a, b) => b.contribution - a.contribution) };
}

export interface CoolingInput {
  strength: number;
  daysSinceLastContact: number | null;
  /** mean days between encounters, null when < 2 encounters */
  avgGapDays: number | null;
  meetingsTotal: number;
  vip: boolean;
}

export interface CoolingResult {
  atRisk: boolean;
  level: "high" | "medium" | null;
  thresholdDays: number;
  reasons: string[];
}

/** A relationship is "cooling" when it mattered (strong, VIP, or had meetings) and the silence exceeds its usual cadence. */
export function coolingRisk(c: CoolingInput): CoolingResult {
  const important = c.vip || c.strength >= 0.45 || c.meetingsTotal >= 1;
  const threshold = Math.round(Math.max(30, Math.min(120, c.avgGapDays ? c.avgGapDays * 2 : 45)));
  const reasons: string[] = [];
  if (!important || c.daysSinceLastContact == null || c.daysSinceLastContact <= threshold) return { atRisk: false, level: null, thresholdDays: threshold, reasons };
  if (c.vip) reasons.push("VIP 태그");
  if (c.strength >= 0.45) reasons.push(`관계 강도 ${c.strength}`);
  if (c.meetingsTotal) reasons.push(`미팅 ${c.meetingsTotal}회 이력`);
  reasons.push(c.avgGapDays ? `평소 ${Math.round(c.avgGapDays)}일 간격 → 지금 ${Math.round(c.daysSinceLastContact)}일째 무소식` : `${Math.round(c.daysSinceLastContact)}일째 접촉 없음`);
  return { atRisk: true, level: c.daysSinceLastContact > threshold * 2 ? "high" : "medium", thresholdDays: threshold, reasons };
}

export function averageGapDays(dates: Date[]): number | null {
  if (dates.length < 2) return null;
  const t = dates.map((d) => d.getTime()).sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < t.length; i++) sum += t[i]! - t[i - 1]!;
  return sum / (t.length - 1) / 864e5;
}
