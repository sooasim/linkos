// ai module — Relationship Memory search (UX-017), Need↔Offer Match (UX-018).
// ACL 필터 후 검색(본인 소유 데이터만), 결과마다 근거(evidence) 제공, 매칭은 "ai_inferred" 라벨.
import { type MatchProfile, type MatchResult, rankMatches, tokens } from "@linkos/domain";
import { one, q } from "../lib/db";
import { unauthorized } from "../lib/errors";
import type { Ctx } from "../lib/platform";
import { loadProfile, primaryProfileId } from "./card";

const YEAR_HINTS: [RegExp, (now: Date) => [Date, Date]][] = [
  [/작년|지난해|last year/i, (n) => [new Date(n.getFullYear() - 1, 0, 1), new Date(n.getFullYear(), 0, 1)]],
  [/올해|this year/i, (n) => [new Date(n.getFullYear(), 0, 1), new Date(n.getFullYear() + 1, 0, 1)]],
  [/지난달|last month/i, (n) => [new Date(n.getFullYear(), n.getMonth() - 1, 1), new Date(n.getFullYear(), n.getMonth(), 1)]],
  [/이번\s?달|this month/i, (n) => [new Date(n.getFullYear(), n.getMonth(), 1), new Date(n.getFullYear(), n.getMonth() + 1, 1)]],
  [/지난\s?주|last week/i, (n) => [new Date(n.getTime() - 14 * 864e5), new Date(n.getTime() - 7 * 864e5)]],
];
const FILLER = /(에서|만난|만났던|사람|누구|였지|이었지|있었던|관련|대표님?|님|분|찾아줘|알려줘|who|met|at|the|person)/gi;

export interface SearchHit {
  contactId: string;
  fullName: string;
  company: string | null;
  jobTitle: string | null;
  score: number;
  evidence: { kind: "contact" | "encounter" | "note" | "meeting" | "event"; text: string; at: string | null }[];
}

export async function relationshipSearch(ctx: Ctx, query: string): Promise<{ query: string; interpreted: { terms: string[]; from: string | null; to: string | null }; results: SearchHit[] }> {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const now = new Date();
  let range: [Date, Date] | null = null;
  for (const [re, fn] of YEAR_HINTS) if (re.test(query)) range = fn(now);
  const cleaned = query.replace(FILLER, " ").replace(/작년|지난해|올해|지난달|이번\s?달|지난\s?주/g, " ");
  const words = cleaned.split(/[\s,.?!]+/).map((w) => w.trim()).filter((w) => w.length >= 2);
  const termTokens = tokens(cleaned);

  // Candidate pool: all owned contacts with their textual context (ACL: owner-only corpus)
  const rows = await q<any>(
    `SELECT c.id, c.full_name, co.name AS company, c.job_title, c.department, c.email, c.address,
       COALESCE(json_agg(DISTINCT jsonb_build_object('t', 'encounter', 'text', concat_ws(' · ', e.place_label, ev.name, e.note), 'at', e.occurred_at)) FILTER (WHERE e.id IS NOT NULL), '[]') AS encounters,
       COALESCE(json_agg(DISTINCT jsonb_build_object('t', 'note', 'text', n.body, 'at', n.created_at)) FILTER (WHERE n.id IS NOT NULL), '[]') AS notes,
       COALESCE(json_agg(DISTINCT jsonb_build_object('t', 'meeting', 'text', concat_ws(' · ', m.title, m.purpose), 'at', COALESCE(m.started_at, m.created_at))) FILTER (WHERE m.id IS NOT NULL), '[]') AS meetings
     FROM contacts c
     LEFT JOIN companies co ON co.id = c.company_id
     LEFT JOIN encounters e ON e.contact_id = c.id AND e.owner_user_id = c.owner_user_id
     LEFT JOIN events ev ON ev.id = e.event_id
     LEFT JOIN notes n ON n.contact_id = c.id AND n.owner_user_id = c.owner_user_id
     LEFT JOIN meeting_participants mp ON mp.contact_id = c.id
     LEFT JOIN meetings m ON m.id = mp.meeting_id AND m.owner_user_id = c.owner_user_id
     WHERE c.owner_user_id = $1 AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
     GROUP BY c.id, co.name
     LIMIT 2000`,
    [userId],
  );

  const results: SearchHit[] = [];
  for (const r of rows) {
    const evidence: SearchHit["evidence"] = [];
    let score = 0;
    const base = [r.full_name, r.company, r.job_title, r.department, r.email, r.address].filter(Boolean).join(" ");
    const scoreText = (text: string) => {
      if (!text) return 0;
      let s = 0;
      const low = text.toLowerCase();
      for (const w of words) if (low.includes(w.toLowerCase())) s += 1;
      const tt = tokens(text);
      let inter = 0;
      for (const t of termTokens) if (tt.has(t)) inter++;
      return s + (termTokens.size ? inter / termTokens.size : 0);
    };
    const bs = scoreText(base);
    if (bs > 0) {
      score += bs * 1.2;
      evidence.push({ kind: "contact", text: [r.company, r.job_title].filter(Boolean).join(" · ") || r.full_name, at: null });
    }
    let inRange = !range;
    for (const ctxItem of [...r.encounters, ...r.notes, ...r.meetings] as { t: string; text: string; at: string | null }[]) {
      const at = ctxItem.at ? new Date(ctxItem.at) : null;
      if (range && at && at >= range[0] && at < range[1]) inRange = true;
      const s = scoreText(ctxItem.text ?? "");
      if (s > 0) {
        score += s;
        evidence.push({ kind: ctxItem.t as SearchHit["evidence"][number]["kind"], text: ctxItem.text, at: ctxItem.at });
      }
    }
    if (!words.length && range && inRange) score += 0.5;
    if (range && !inRange) score *= 0.2;
    if (score > 0.3) {
      results.push({ contactId: r.id, fullName: r.full_name, company: r.company, jobTitle: r.job_title, score: Math.round(score * 100) / 100, evidence: evidence.slice(0, 4) });
    }
  }
  results.sort((a, b) => b.score - a.score);
  await q("INSERT INTO ai_runs (owner_user_id, kind, model, prompt_version, source_ids, output) VALUES ($1,'relationship_search','lexical-v1','search-1',$2,$3)", [
    userId,
    results.slice(0, 20).map((r) => r.contactId),
    JSON.stringify({ count: results.length }),
  ]);
  return { query, interpreted: { terms: words, from: range?.[0].toISOString() ?? null, to: range?.[1].toISOString() ?? null }, results: results.slice(0, 20) };
}

async function matchProfileFor(profileId: string, trust = 0): Promise<MatchProfile | null> {
  const p = await loadProfile(profileId);
  if (!p) return null;
  const projects = ((p.deep as any)?.projects ?? []).map((x: any) => x.title).filter(Boolean);
  return {
    id: p.id,
    name: p.name,
    offers: p.offers.filter((o) => o.confirmed).map((o) => o.text),
    needs: p.needs.filter((n) => n.confirmed).map((n) => n.text),
    industries: p.industries,
    regions: p.regions,
    projects,
    trust,
    matchingOptOut: !p.matchingOptIn,
  };
}

/** GET /matches — candidates are (a) people in my network who use LINKOS, (b) opted-in co-attendees of my events. */
export async function listMatches(ctx: Ctx, opts: { eventId?: string } = {}): Promise<{ subject: string | null; results: (MatchResult & { company: string | null; slug: string; contactId: string | null })[] }> {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const myPid = await primaryProfileId(userId);
  if (!myPid) return { subject: null, results: [] };
  const me = await matchProfileFor(myPid);
  if (!me) return { subject: null, results: [] };

  let candidates: { profile_id: string; strength: number | null; contact_id: string | null }[];
  if (opts.eventId) {
    candidates = await q<any>(
      `SELECT ea.profile_id, NULL::numeric AS strength, NULL::uuid AS contact_id FROM event_attendees ea
       WHERE ea.event_id=$1 AND ea.opt_in AND ea.profile_id IS NOT NULL AND ea.user_id IS DISTINCT FROM $2
         AND EXISTS (SELECT 1 FROM event_attendees me WHERE me.event_id=$1 AND me.user_id=$2)`,
      [opts.eventId, userId],
    );
  } else {
    candidates = await q<any>(
      `SELECT DISTINCT ON (p.user_id) p.id AS profile_id, rel.strength, c.id AS contact_id
       FROM contacts c JOIN profiles p ON p.user_id = c.linked_user_id
       LEFT JOIN relationships rel ON rel.contact_id = c.id AND rel.owner_user_id = c.owner_user_id
       WHERE c.owner_user_id=$1 AND c.linked_user_id IS NOT NULL AND c.deleted_at IS NULL AND p.matching_opt_in
       ORDER BY p.user_id, p.is_primary DESC
       LIMIT 500`,
      [userId],
    );
    const eventPeers = await q<any>(
      `SELECT DISTINCT ON (ea.profile_id) ea.profile_id, NULL::numeric AS strength, NULL::uuid AS contact_id FROM event_attendees ea
       JOIN event_attendees me ON me.event_id = ea.event_id AND me.user_id = $1
       WHERE ea.opt_in AND ea.profile_id IS NOT NULL AND ea.user_id IS DISTINCT FROM $1 LIMIT 500`,
      [userId],
    );
    const seen = new Set(candidates.map((c) => c.profile_id));
    for (const e of eventPeers) if (!seen.has(e.profile_id)) candidates.push(e);
  }
  const pool_: (MatchProfile & { contactId: string | null })[] = [];
  for (const c of candidates) {
    const mp = await matchProfileFor(c.profile_id, Number(c.strength ?? 0));
    if (mp) pool_.push({ ...mp, contactId: c.contact_id });
  }
  const ranked = rankMatches(me, pool_);
  const out = [];
  for (const m of ranked) {
    const p = await one<{ company: string | null; slug: string }>("SELECT company, slug FROM profiles WHERE id=$1", [m.candidateId]);
    out.push({ ...m, company: p?.company ?? null, slug: p?.slug ?? "", contactId: pool_.find((x) => x.id === m.candidateId)?.contactId ?? null });
  }
  return { subject: me.id, results: out };
}
