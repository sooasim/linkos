// F-031 프로필 변형 auto-select · F-032 Adaptive Card(규칙 폴백 스코어링) · F-033 Living Update diff
// F-036 Action Card kinds · F-147 부스 Lead 스코어 · F-149 Event ROI
import { normalizeCompanyName } from "./normalize";

export const VARIANT_AUDIENCES = ["investor", "customer", "partner", "recruiting", "general"] as const;
export type VariantAudience = (typeof VARIANT_AUDIENCES)[number];

export interface VariantContext {
  /** explicit choice by the sender (always wins when that variant exists) */
  explicit?: string | null;
  /** audience configured on the event the exchange happens at */
  eventAudience?: string | null;
  recipientIndustry?: string | null;
  recipientTitle?: string | null;
  recipientCompany?: string | null;
  ownerIndustries?: string[];
}

export type VariantReason = "explicit" | "event" | "industry" | "title" | "default" | "none";

const SIGNALS: Record<Exclude<VariantAudience, "general">, RegExp> = {
  investor: /(투자|벤처\s*캐피탈|벤처캐피털|심사역|\bvc\b|venture|capital|investor|fund|펀드|액셀러레이터|accelerator|angel|엔젤|LP\b|GP\b)/i,
  recruiting: /(채용|인사|\bhr\b|recruit|talent|헤드헌|people\s*team|people\s*ops|리크루터)/i,
  partner: /(제휴|파트너|partnership|alliance|business\s*development|사업\s*개발|\bbd\b|유통|reseller|distribut)/i,
  customer: /(구매|조달|procurement|purchasing|buyer|고객|operations|운영)/i,
};

/** Rule-based audience inference from free text (title/industry/company). */
export function inferAudience(text: string): VariantAudience | null {
  for (const a of ["investor", "recruiting", "partner", "customer"] as const) if (SIGNALS[a].test(text)) return a;
  return null;
}

/** F-031: choose which audience variant a recipient should see. Only returns an audience that exists. */
export function selectVariant(available: { audience: string; isDefault: boolean }[], ctx: VariantContext): { audience: string | null; reason: VariantReason } {
  const has = (a: string | null | undefined): a is string => !!a && available.some((v) => v.audience === a);
  if (has(ctx.explicit)) return { audience: ctx.explicit, reason: "explicit" };
  if (has(ctx.eventAudience)) return { audience: ctx.eventAudience, reason: "event" };
  const byIndustry = ctx.recipientIndustry ? inferAudience(ctx.recipientIndustry) : null;
  if (has(byIndustry)) return { audience: byIndustry, reason: "industry" };
  const byTitle = inferAudience(`${ctx.recipientTitle ?? ""} ${ctx.recipientCompany ?? ""}`);
  if (has(byTitle)) return { audience: byTitle, reason: "title" };
  // same industry as the owner → peer/partner; otherwise a prospective customer
  if (ctx.recipientIndustry && ctx.ownerIndustries?.length) {
    const same = ctx.ownerIndustries.some((i) => i.toLowerCase() === ctx.recipientIndustry!.toLowerCase());
    const guess = same ? "partner" : "customer";
    if (has(guess)) return { audience: guess, reason: "industry" };
  }
  const def = available.find((v) => v.isDefault);
  if (def) return { audience: def.audience, reason: "default" };
  return { audience: null, reason: "none" };
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2),
  );
}

/** F-032 fallback: reorder highlights by token overlap with the recipient context (stable; never adds items). */
export function rankHighlights(highlights: string[], context: string): string[] {
  const ctx = tokens(context);
  const score = (h: string) => [...tokens(h)].filter((t) => ctx.has(t) || [...ctx].some((c) => c.length >= 3 && (t.includes(c) || c.includes(t)))).length;
  return highlights
    .map((h, i) => ({ h, i, s: score(h) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.h);
}

/** F-032 fallback: score each available variant against the context; highest wins (ties → default/first). */
export function scoreVariants(available: { audience: string; isDefault: boolean }[], context: string): { audience: string; score: number }[] {
  const inferred = inferAudience(context);
  return available
    .map((v) => ({ audience: v.audience, score: (v.audience === inferred ? 2 : 0) + (v.isDefault ? 0.5 : 0) }))
    .sort((a, b) => b.score - a.score);
}

// ---------- F-033 Living Update ----------
export const LIVING_FIELDS = ["company", "jobTitle", "website"] as const;
export type LivingField = (typeof LIVING_FIELDS)[number];

const norm = (f: LivingField, v: string | null | undefined) => {
  const s = (v ?? "").trim();
  if (!s) return "";
  if (f === "company") return normalizeCompanyName(s) || s.toLowerCase();
  if (f === "website") return s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  return s.toLowerCase().replace(/\s+/g, " ");
};

/** Changes to propose to a contact owner: only non-empty profile values that differ from the contact. */
export function livingUpdateDiff(
  profile: Partial<Record<LivingField, string | null>>,
  contact: Partial<Record<LivingField, string | null>>,
): { field: LivingField; from: string | null; to: string }[] {
  const out: { field: LivingField; from: string | null; to: string }[] = [];
  for (const f of LIVING_FIELDS) {
    const to = profile[f]?.trim();
    if (!to) continue;
    if (norm(f, to) !== norm(f, contact[f])) out.push({ field: f, from: contact[f] ?? null, to });
  }
  return out;
}

// ---------- F-036 Action Card ----------
export const ACTION_KINDS = ["booking", "quote", "proposal", "nda"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const ACTION_LABEL_KO: Record<ActionKind, string> = { booking: "미팅 예약", quote: "견적 요청", proposal: "제안 요청", nda: "NDA 요청" };

// ---------- F-147 booth lead qualification ----------
export const LEAD_QUALIFIERS = ["budget", "authority", "need", "timeline"] as const;
export type LeadQualifier = (typeof LEAD_QUALIFIERS)[number];

export function scoreLead(input: { qualifiers: string[]; hasEmail: boolean; hasPhone: boolean; hasNotes: boolean; interest?: "hot" | "warm" | "cold" | null }) {
  const q = new Set(input.qualifiers.filter((x): x is LeadQualifier => (LEAD_QUALIFIERS as readonly string[]).includes(x)));
  let score = q.size * 18; // BANT: 72 max
  if (input.hasEmail) score += 10;
  if (input.hasPhone) score += 5;
  if (input.hasNotes) score += 3;
  if (input.interest === "hot") score += 10;
  else if (input.interest === "warm") score += 5;
  score = Math.min(100, score);
  const grade: "A" | "B" | "C" = score >= 70 ? "A" : score >= 40 ? "B" : "C";
  return { score, grade };
}

// ---------- F-149 Event ROI ----------
export interface EventRoiInput {
  leads: number;
  qualifiedLeads: number;
  meetingsBooked: number;
  followupsTotal: number;
  followupsDone: number;
  costCents: number;
  pipelineCents: number;
  wonCents: number;
}

export function eventRoi(i: EventRoiInput) {
  const r = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    ...i,
    costPerLeadCents: i.leads ? Math.round(i.costCents / i.leads) : null,
    costPerQualifiedLeadCents: i.qualifiedLeads ? Math.round(i.costCents / i.qualifiedLeads) : null,
    qualificationRate: r(i.qualifiedLeads, i.leads),
    meetingRate: r(i.meetingsBooked, i.leads),
    followupCompletion: r(i.followupsDone, i.followupsTotal),
    roiPct: i.costCents ? Math.round(((i.wonCents - i.costCents) / i.costCents) * 1000) / 10 : null,
  };
}
