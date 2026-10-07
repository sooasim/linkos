// X-003 card view analytics helpers · X-005 meeting prep brief · X-006 re-connect digest · audit G-01 match announcements.
// Pure functions. The brief/digest only restate the owner's own records; AI-inferred lines are labelled.
import { textSimilarity } from "./match";

// ---------------------------------------------------------------- X-003 card views

export const CARD_VIEW_KINDS = ["view", "cta", "vcard", "reply", "link_sig", "link_bg", "link_wallet"] as const;
export type CardViewKind = (typeof CARD_VIEW_KINDS)[number];
/** Kinds a browser may report (views of /x and /p are counted server-side; replies come from the exchange itself). */
export const CLIENT_CARD_VIEW_KINDS: readonly CardViewKind[] = ["cta", "vcard"];

export function isCardViewKind(x: unknown): x is CardViewKind {
  return typeof x === "string" && (CARD_VIEW_KINDS as readonly string[]).includes(x);
}

/** Owner opt-out wins; a viewer's Global Privacy Control / Do-Not-Track also suppresses counting. */
export function viewCountingAllowed(o: { ownerOptOut: boolean; gpc?: string | null; dnt?: string | null; isOwner?: boolean }): boolean {
  if (o.ownerOptOut || o.isOwner) return false;
  if (o.gpc === "1" || o.dnt === "1") return false;
  return true;
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Oldest → newest daily counts for the last `days` days ending today (missing days are 0). */
export function fillDailySeries(rows: { day: string | Date; count: number }[], days: number, today: Date = new Date()): number[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = typeof r.day === "string" ? r.day.slice(0, 10) : utcDay(r.day);
    m.set(k, (m.get(k) ?? 0) + Number(r.count));
  }
  const out: number[] = [];
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (let i = days - 1; i >= 0; i--) out.push(m.get(utcDay(new Date(base - i * 864e5))) ?? 0);
  return out;
}

/** SVG polyline points for a sparkline (flat line at the bottom when everything is 0). */
export function sparklinePoints(values: number[], w: number, h: number, pad = 2): string {
  if (!values.length) return "";
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  return values.map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - (v / max) * (h - pad * 2)).toFixed(1)}`).join(" ");
}

// ---------------------------------------------------------------- X-005 meeting prep brief

export interface PrepBriefSource {
  meetingTitle: string;
  startsAt: Date;
  location?: string | null;
  contact: { id: string; fullName: string; company?: string | null; jobTitle?: string | null };
  lastEncounter?: { at: Date; place?: string | null } | null;
  encounterCount?: number;
  recentNote?: { body: string; at: Date } | null;
  openActions?: { description: string; dueAt?: Date | null }[];
  theirOffers?: string[];
  theirNeeds?: string[];
  myOffers?: string[];
  myNeeds?: string[];
}

export interface BriefItem {
  kind: "who" | "last_met" | "note" | "open_action" | "their_offer" | "their_need" | "topic";
  text: string;
  provenance: "record" | "ai_inferred";
}

export interface PrepBrief {
  title: string;
  contactId: string;
  startsAt: string;
  items: BriefItem[];
  aiInferredCount: number;
  empty: boolean;
}

const fmtDate = (d: Date) => `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Due when `now` is inside [start − lead, start). lead 0 = off. */
export function prepBriefDue(startsAt: Date, now: Date, leadMin: number): boolean {
  if (leadMin <= 0) return false;
  const t = startsAt.getTime();
  return now.getTime() >= t - leadMin * 60_000 && now.getTime() < t;
}

/** "만나기 전 30초 브리핑": only facts from the owner's records; need↔offer topics are marked ai_inferred. */
export function composePrepBrief(src: PrepBriefSource): PrepBrief {
  const items: BriefItem[] = [];
  const role = [src.contact.jobTitle, src.contact.company].filter(Boolean).join(" · ");
  items.push({ kind: "who", text: role ? `${src.contact.fullName} — ${role}` : src.contact.fullName, provenance: "record" });
  if (src.lastEncounter) {
    const times = src.encounterCount && src.encounterCount > 1 ? ` (지금까지 ${src.encounterCount}번 만남)` : "";
    items.push({ kind: "last_met", text: `마지막 만남 ${fmtDate(src.lastEncounter.at)}${src.lastEncounter.place ? ` · ${src.lastEncounter.place}` : ""}${times}`, provenance: "record" });
  }
  if (src.recentNote?.body.trim()) items.push({ kind: "note", text: `내 메모: ${clip(src.recentNote.body.trim(), 140)}`, provenance: "record" });
  for (const a of (src.openActions ?? []).slice(0, 3)) items.push({ kind: "open_action", text: `미완료 할 일: ${clip(a.description, 100)}${a.dueAt ? ` (기한 ${fmtDate(a.dueAt)})` : ""}`, provenance: "record" });
  for (const o of (src.theirOffers ?? []).slice(0, 2)) items.push({ kind: "their_offer", text: `상대 Offer: ${clip(o, 100)}`, provenance: "record" });
  for (const n of (src.theirNeeds ?? []).slice(0, 2)) items.push({ kind: "their_need", text: `상대 Need: ${clip(n, 100)}`, provenance: "record" });
  const topics: string[] = [];
  for (const n of src.myNeeds ?? []) for (const o of src.theirOffers ?? []) if (textSimilarity(n, o) > 0.2) topics.push(`내 Need “${clip(n, 60)}” ↔ 상대 Offer “${clip(o, 60)}”`);
  for (const o of src.myOffers ?? []) for (const n of src.theirNeeds ?? []) if (textSimilarity(o, n) > 0.2) topics.push(`상대 Need “${clip(n, 60)}”에 내 Offer “${clip(o, 60)}” 제안해 보기`);
  for (const t of topics.slice(0, 2)) items.push({ kind: "topic", text: t, provenance: "ai_inferred" });
  return {
    title: src.meetingTitle,
    contactId: src.contact.id,
    startsAt: src.startsAt.toISOString(),
    items,
    aiInferredCount: items.filter((i) => i.provenance === "ai_inferred").length,
    empty: items.length === 1,
  };
}

/** Short push/inbox body: the first factual lines, never the AI-inferred ones. */
export function prepBriefNotificationBody(b: PrepBrief, max = 180): string {
  const facts = b.items.filter((i) => i.provenance === "record" && i.kind !== "who").map((i) => i.text);
  const body = facts.length ? facts.slice(0, 2).join(" · ") : "기록된 이전 만남이 없어요. 브리핑에서 상대 카드를 확인하세요.";
  return clip(body, max);
}

// ---------------------------------------------------------------- X-006 re-connect digest

export interface CoolingCandidate {
  contactId: string;
  fullName: string;
  company?: string | null;
  daysSilent: number;
  level: "high" | "medium" | string;
  reasons?: string[];
}

/** Monday (UTC) of the week containing `d`, as YYYY-MM-DD. */
export function weekStart(d: Date): string {
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  return utcDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff)));
}

/** Top `n` cooling relationships, skipping ones nudged in recent digests; high risk first, then longest silence. */
export function pickReconnectDigest(items: CoolingCandidate[], recentlyNudged: Set<string> = new Set(), n = 3): CoolingCandidate[] {
  return items
    .filter((i) => !recentlyNudged.has(i.contactId))
    .sort((a, b) => (a.level === b.level ? b.daysSilent - a.daysSilent : a.level === "high" ? -1 : b.level === "high" ? 1 : 0))
    .slice(0, n);
}

/**
 * One-tap re-connect draft (CLAUDE.md rule 8: saved as a draft, never sent automatically).
 * Mentions only what the record holds (name, company, last place) — no invented shared history.
 */
export function reconnectDraft(o: { fullName: string; company?: string | null; lastPlace?: string | null; senderName?: string | null }): { subject: string; body: string } {
  const greet = `${o.fullName}님, 안녕하세요.`;
  const where = o.lastPlace ? `지난번 ${o.lastPlace}에서 뵌 뒤로 연락이 뜸했네요.` : "한동안 연락을 못 드렸네요.";
  const ask = o.company ? `${o.company}에서 요즘 어떤 일에 집중하고 계신지 궁금합니다.` : "요즘 어떤 일에 집중하고 계신지 궁금합니다.";
  const close = "편하실 때 짧게 커피나 통화 한번 어떠세요?";
  const sign = o.senderName ? `\n\n${o.senderName} 드림` : "";
  return { subject: "오랜만에 안부 전합니다", body: `${greet}\n\n${where} ${ask}\n${close}${sign}` };
}

// ---------------------------------------------------------------- audit G-01 match.created

/** Pairs worth announcing (emitting `match.created`): score at or above the threshold. */
export function announceableMatches<T extends { score: number }>(results: T[], minScore = 0.3): T[] {
  return results.filter((r) => r.score >= minScore);
}
