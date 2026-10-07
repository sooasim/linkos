// F-020 중복 후보 탐지, F-021 정보 병합.
// 이메일/전화 exact match 최우선, 이름+회사 fuzzy는 후보로만 제시. 자동 병합 임계값은 매우 높게.
import { nameKey, normalizeCompanyName, normalizeEmail, normalizePhone } from "./normalize";

export interface ContactLike {
  id?: string;
  fullName: string;
  company?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  website?: string | null;
}

export interface DuplicateCandidate<T extends ContactLike> {
  contact: T;
  score: number; // 0..1
  reasons: string[];
  autoMergeable: boolean;
}

export const AUTO_MERGE_THRESHOLD = 0.98;
export const CANDIDATE_THRESHOLD = 0.6;

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

/** Dice coefficient on character bigrams — works for Hangul and Latin. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export function scoreDuplicate(a: ContactLike, b: ContactLike): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const ea = a.email ? normalizeEmail(a.email) : null;
  const eb = b.email ? normalizeEmail(b.email) : null;
  if (ea && eb && ea === eb) {
    reasons.push("email_exact");
    return { score: 0.99, reasons };
  }
  const pa = a.phone ? normalizePhone(a.phone) : null;
  const pb = b.phone ? normalizePhone(b.phone) : null;
  if (pa && pb && pa === pb) {
    reasons.push("phone_exact");
    return { score: 0.97, reasons };
  }
  const n = similarity(nameKey(a.fullName), nameKey(b.fullName));
  const ca = a.company ? normalizeCompanyName(a.company) : "";
  const cb = b.company ? normalizeCompanyName(b.company) : "";
  const c = ca && cb ? similarity(ca, cb) : 0;
  if (n >= 0.99) reasons.push("name_exact");
  else if (n >= 0.7) reasons.push("name_similar");
  if (c >= 0.8) reasons.push("company_similar");
  // fuzzy name+company is never auto-mergeable (max 0.9)
  const score = Math.min(0.9, n * 0.6 + c * 0.35);
  return { score: n >= 0.7 ? score : score * 0.5, reasons };
}

export function findDuplicates<T extends ContactLike>(candidate: ContactLike, existing: T[]): DuplicateCandidate<T>[] {
  return existing
    .filter((e) => e.id === undefined || e.id !== candidate.id)
    .map((contact) => {
      const { score, reasons } = scoreDuplicate(candidate, contact);
      return { contact, score, reasons, autoMergeable: score >= AUTO_MERGE_THRESHOLD };
    })
    .filter((d) => d.score >= CANDIDATE_THRESHOLD)
    .sort((x, y) => y.score - x.score);
}

export type MergeChoice = "primary" | "secondary";
export const MERGEABLE_FIELDS = ["fullName", "company", "jobTitle", "department", "email", "phone", "address", "website"] as const;
export type MergeableField = (typeof MERGEABLE_FIELDS)[number];

export interface FieldDiff {
  field: MergeableField;
  primary: string | null;
  secondary: string | null;
  differs: boolean;
}

export function diffContacts(primary: ContactLike, secondary: ContactLike): FieldDiff[] {
  return MERGEABLE_FIELDS.map((field) => {
    const p = (primary[field] ?? null) || null;
    const s = (secondary[field] ?? null) || null;
    return { field, primary: p, secondary: s, differs: (p ?? "") !== (s ?? "") };
  });
}

/** Field-level merge. Unspecified fields keep primary unless primary is empty. */
export function mergeContacts<T extends ContactLike>(
  primary: T,
  secondary: ContactLike,
  choices: Partial<Record<MergeableField, MergeChoice>> = {},
): T {
  const out: T = { ...primary };
  for (const f of MERGEABLE_FIELDS) {
    const choice = choices[f];
    const pv = primary[f];
    const sv = secondary[f];
    if (choice === "secondary" && sv) (out as ContactLike)[f] = sv as never;
    else if (!choice && !pv && sv) (out as ContactLike)[f] = sv as never;
  }
  return out;
}
