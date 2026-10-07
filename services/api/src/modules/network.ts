// network module — F-074 관계 강도(설명 가능), F-098 미접촉 위험, F-099 Opportunity Detection, F-097/F-152 AI 소개 후보,
// F-133 관계 그래프, F-134 Who Knows Whom. 모든 추론 결과는 provenance "ai_inferred" + 근거(reasons)를 가진다.
// Query shape: per-owner indexed lookups grouped by contact_id (single table each), joined in memory.
import {
  type GEdge,
  type GNode,
  type IntroPerson,
  type KnowsPath,
  type NeedItem,
  type OfferItem,
  type OrgPolicies,
  type StrengthResult,
  averageGapDays,
  computeStrength,
  coolingRisk,
  detectOpportunities,
  extractNeedStatements,
  forceLayout,
  introCandidates,
  rankWhoKnows,
} from "@linkos/domain";
import { type Db, one, pool, q } from "../lib/db";
import { notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit } from "../lib/platform";
import { activeOrgId, requireOrg } from "./org";

// ---------- F-074 ----------
interface Signals {
  contactId: string;
  lastAt: Date | null;
  enc90: number;
  encTotal: number;
  encDates: Date[];
  meetings: number;
  notes: number;
  followupsDone: number;
  reciprocal: boolean;
}

async function loadSignals(userId: string, contactIds: string[] | null, db: Db = pool()): Promise<Map<string, Signals>> {
  const filter = contactIds ? "AND contact_id = ANY($2::uuid[])" : "";
  const params: unknown[] = contactIds ? [userId, contactIds] : [userId];
  const base = await q<{ id: string; linked_user_id: string | null; last_contact_at: Date | null }>(
    `SELECT c.id, c.linked_user_id, (SELECT rel.last_contact_at FROM relationships rel WHERE rel.owner_user_id=$1 AND rel.contact_id=c.id) AS last_contact_at
     FROM contacts c WHERE c.owner_user_id=$1 AND c.deleted_at IS NULL AND c.merged_into_id IS NULL ${contactIds ? "AND c.id = ANY($2::uuid[])" : ""} LIMIT 5000`,
    params,
    db,
  );
  const enc = await q<{ contact_id: string; total: number; d90: number; last: Date | null; dates: Date[] }>(
    `SELECT contact_id, count(*)::int AS total, count(*) FILTER (WHERE occurred_at > now() - interval '90 days')::int AS d90, max(occurred_at) AS last,
       (array_agg(occurred_at ORDER BY occurred_at DESC))[1:20] AS dates
     FROM encounters WHERE owner_user_id=$1 ${filter} GROUP BY contact_id`,
    params,
    db,
  );
  const meet = await q<{ contact_id: string; n: number; last: Date | null }>(
    `SELECT mp.contact_id, count(*)::int AS n, max(COALESCE(m.started_at, m.created_at)) AS last FROM meetings m JOIN meeting_participants mp ON mp.meeting_id=m.id
     WHERE m.owner_user_id=$1 ${contactIds ? "AND mp.contact_id = ANY($2::uuid[])" : ""} GROUP BY mp.contact_id`,
    params,
    db,
  );
  const notes = await q<{ contact_id: string; n: number }>(`SELECT contact_id, count(*)::int AS n FROM notes WHERE owner_user_id=$1 ${filter} GROUP BY contact_id`, params, db);
  const fu = await q<{ contact_id: string; n: number }>(`SELECT contact_id, count(*)::int AS n FROM followups WHERE owner_user_id=$1 AND status='done' ${filter} GROUP BY contact_id`, params, db);
  const linked = base.filter((b) => b.linked_user_id).map((b) => b.linked_user_id!);
  const recip = linked.length
    ? await q<{ owner_user_id: string }>("SELECT DISTINCT owner_user_id FROM contacts WHERE owner_user_id = ANY($1::uuid[]) AND linked_user_id=$2 AND deleted_at IS NULL", [linked, userId], db)
    : [];
  const recipSet = new Set(recip.map((r) => r.owner_user_id));
  const E = new Map(enc.map((e) => [e.contact_id, e]));
  const M = new Map(meet.map((e) => [e.contact_id, e]));
  const N = new Map(notes.map((e) => [e.contact_id, e.n]));
  const F = new Map(fu.map((e) => [e.contact_id, e.n]));
  const out = new Map<string, Signals>();
  for (const b of base) {
    const e = E.get(b.id);
    const m = M.get(b.id);
    const candidates = [b.last_contact_at, e?.last ?? null, m?.last ?? null].filter((d): d is Date => Boolean(d)).map((d) => new Date(d));
    out.set(b.id, {
      contactId: b.id,
      lastAt: candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null,
      enc90: e?.d90 ?? 0,
      encTotal: e?.total ?? 0,
      encDates: (e?.dates ?? []).map((d) => new Date(d)),
      meetings: m?.n ?? 0,
      notes: N.get(b.id) ?? 0,
      followupsDone: F.get(b.id) ?? 0,
      reciprocal: Boolean(b.linked_user_id && recipSet.has(b.linked_user_id)),
    });
  }
  return out;
}

function toStrength(s: Signals, now = Date.now()): StrengthResult {
  return computeStrength({
    daysSinceLastContact: s.lastAt ? (now - s.lastAt.getTime()) / 864e5 : null,
    encounters90d: s.enc90,
    encountersTotal: s.encTotal,
    meetingsTotal: s.meetings,
    notesTotal: s.notes,
    followupsDone: s.followupsDone,
    reciprocal: s.reciprocal,
  });
}

/** Recompute and persist strength (+ explanation) for a user's relationships. Returns the number updated. */
export async function recomputeStrengths(userId: string, contactIds: string[] | null = null, db: Db = pool()): Promise<number> {
  const sig = await loadSignals(userId, contactIds, db);
  if (!sig.size) return 0;
  const ids: string[] = [];
  const scores: number[] = [];
  const factors: string[] = [];
  for (const s of sig.values()) {
    const r = toStrength(s);
    ids.push(s.contactId);
    scores.push(r.score);
    factors.push(JSON.stringify(r.factors));
  }
  const res = await db.query(
    `UPDATE relationships r SET strength = u.score, strength_factors = u.factors::jsonb, strength_computed_at = now()
     FROM unnest($2::uuid[], $3::numeric[], $4::text[]) AS u(contact_id, score, factors)
     WHERE r.owner_user_id = $1 AND r.contact_id = u.contact_id`,
    [userId, ids, scores, factors],
  );
  return res.rowCount ?? 0;
}

export async function strengthFor(ctx: Ctx, contactId: string) {
  if (!ctx.userId) throw unauthorized();
  const sig = await loadSignals(ctx.userId, [contactId]);
  const s = sig.get(contactId);
  if (!s) throw notFound("contact");
  await recomputeStrengths(ctx.userId, [contactId]);
  return { contactId, ...toStrength(s), provenance: "rules" as const, model: "strength-v1" };
}

/** Worker: refresh stale strengths for a bounded number of users per tick. */
export async function processStrengths(maxUsers = 20): Promise<number> {
  const users = await q<{ owner_user_id: string }>(
    `SELECT DISTINCT owner_user_id FROM relationships WHERE strength_computed_at IS NULL OR strength_computed_at < now() - interval '1 day' LIMIT $1`,
    [maxUsers],
  );
  let n = 0;
  for (const u of users) n += await recomputeStrengths(u.owner_user_id);
  return n;
}

// ---------- F-098 ----------
export async function coolingRelationships(ctx: Ctx, limit = 30) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const sig = await loadSignals(userId, null);
  const meta = await q<{ id: string; full_name: string; company: string | null; vip: boolean }>(
    `SELECT c.id, c.full_name, co.name AS company,
       EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.contact_id=c.id AND lower(t.name) IN ('vip','중요')) AS vip
     FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE c.owner_user_id=$1 AND c.deleted_at IS NULL AND c.merged_into_id IS NULL LIMIT 5000`,
    [userId],
  );
  const now = Date.now();
  const out = [];
  for (const m of meta) {
    const s = sig.get(m.id);
    if (!s) continue;
    const strength = toStrength(s, now);
    const days = s.lastAt ? (now - s.lastAt.getTime()) / 864e5 : null;
    const risk = coolingRisk({ strength: strength.score, daysSinceLastContact: days, avgGapDays: averageGapDays(s.encDates), meetingsTotal: s.meetings, vip: m.vip });
    if (!risk.atRisk) continue;
    out.push({ contactId: m.id, fullName: m.full_name, company: m.company, strength: strength.score, daysSilent: Math.round(days ?? 0), level: risk.level, thresholdDays: risk.thresholdDays, reasons: risk.reasons, provenance: "ai_inferred" as const });
  }
  out.sort((a, b) => (a.level === b.level ? b.daysSilent - a.daysSilent : a.level === "high" ? -1 : 1));
  return { results: out.slice(0, limit), model: "cooling-v1" };
}

// ---------- shared loaders for Need/Offer ----------
async function linkedProfilesOf(userId: string, db: Db = pool()) {
  // my contacts that are LINKOS users → their primary profile's confirmed offers/needs (business-visible data only)
  return q<{ contact_id: string; full_name: string; company: string | null; profile_id: string; industries: string[]; strength: number | null; matching_opt_in: boolean }>(
    `SELECT DISTINCT ON (c.id) c.id AS contact_id, c.full_name, co.name AS company, p.id AS profile_id, p.industries, p.matching_opt_in,
       (SELECT rel.strength FROM relationships rel WHERE rel.owner_user_id=$1 AND rel.contact_id=c.id) AS strength
     FROM contacts c JOIN profiles p ON p.user_id = c.linked_user_id LEFT JOIN companies co ON co.id=c.company_id
     WHERE c.owner_user_id=$1 AND c.linked_user_id IS NOT NULL AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
     ORDER BY c.id, p.is_primary DESC LIMIT 1000`,
    [userId],
    db,
  );
}

async function textsFor(profileIds: string[], db: Db = pool()) {
  if (!profileIds.length) return { offers: new Map<string, string[]>(), needs: new Map<string, string[]>() };
  const [o, n] = await Promise.all([
    q<{ profile_id: string; text: string }>("SELECT profile_id, text FROM offers WHERE profile_id = ANY($1::uuid[]) AND confirmed", [profileIds], db),
    q<{ profile_id: string; text: string }>("SELECT profile_id, text FROM needs WHERE profile_id = ANY($1::uuid[]) AND confirmed", [profileIds], db),
  ]);
  const group = (rows: { profile_id: string; text: string }[]) => {
    const m = new Map<string, string[]>();
    for (const r of rows) m.set(r.profile_id, [...(m.get(r.profile_id) ?? []), r.text]);
    return m;
  };
  return { offers: group(o), needs: group(n) };
}

// ---------- F-097 / F-152 ----------
export async function introSuggestions(ctx: Ctx, limit = 20) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const linked = (await linkedProfilesOf(userId)).filter((l) => l.matching_opt_in);
  const { offers, needs } = await textsFor(linked.map((l) => l.profile_id));
  // needs stated in my own notes about a contact (only I can see these, and only I see the suggestion)
  const noteRows = await q<{ contact_id: string; body: string }>("SELECT contact_id, body FROM notes WHERE owner_user_id=$1 AND contact_id IS NOT NULL ORDER BY created_at DESC LIMIT 2000", [userId]);
  const noteNeeds = new Map<string, string[]>();
  for (const n of noteRows) for (const s of extractNeedStatements(n.body)) noteNeeds.set(n.contact_id, [...(noteNeeds.get(n.contact_id) ?? []), s]);
  const people: IntroPerson[] = linked.map((l) => ({
    id: l.contact_id,
    name: l.full_name,
    company: l.company,
    offers: offers.get(l.profile_id) ?? [],
    needs: [...(needs.get(l.profile_id) ?? []), ...(noteNeeds.get(l.contact_id) ?? [])],
    industries: l.industries ?? [],
    strength: Number(l.strength ?? 0.3),
    via: "나",
  }));
  // contacts without a LINKOS profile can still be the "needing" side via my notes
  const linkedIds = new Set(linked.map((l) => l.contact_id));
  const extraIds = [...noteNeeds.keys()].filter((id) => !linkedIds.has(id)).slice(0, 200);
  if (extraIds.length) {
    const extra = await q<{ id: string; full_name: string; company: string | null; strength: number | null }>(
      `SELECT c.id, c.full_name, co.name AS company, (SELECT rel.strength FROM relationships rel WHERE rel.owner_user_id=$1 AND rel.contact_id=c.id) AS strength
       FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE c.owner_user_id=$1 AND c.id = ANY($2::uuid[]) AND c.deleted_at IS NULL`,
      [userId, extraIds],
    );
    for (const e of extra) people.push({ id: e.id, name: e.full_name, company: e.company, offers: [], needs: noteNeeds.get(e.id) ?? [], industries: [], strength: Number(e.strength ?? 0.3), via: "나" });
  }
  const results = introCandidates(people, limit).map((r) => ({ ...r, actionable: true }));
  await q("INSERT INTO ai_runs (owner_user_id, kind, model, prompt_version, source_ids, output) VALUES ($1,'intro_candidates','graph-needoffer-v1','intro-cand-1',$2,$3)", [
    userId,
    results.flatMap((r) => [r.partyA.id, r.partyB.id]).slice(0, 100),
    JSON.stringify({ count: results.length }),
  ]);
  return { results, model: "graph-needoffer-v1", provenance: "ai_inferred" as const };
}

// ---------- F-099 ----------
export async function opportunities(ctx: Ctx, limit = 30) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const linked = (await linkedProfilesOf(userId)).filter((l) => l.matching_opt_in);
  const myProfile = await one<{ id: string; name: string }>("SELECT id, name FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC, created_at LIMIT 1", [userId]);
  const orgId = await activeOrgId(userId);
  const memberProfiles = orgId
    ? await q<{ user_id: string; profile_id: string; name: string }>(
        `SELECT DISTINCT ON (m.user_id) m.user_id, p.id AS profile_id, p.name FROM organization_members m JOIN profiles p ON p.user_id=m.user_id
         WHERE m.organization_id=$1 AND m.status='active' AND m.user_id<>$2 AND p.matching_opt_in ORDER BY m.user_id, p.is_primary DESC LIMIT 500`,
        [orgId, userId],
      )
    : [];
  const pids = [...linked.map((l) => l.profile_id), ...(myProfile ? [myProfile.id] : []), ...memberProfiles.map((m) => m.profile_id)];
  const { offers, needs } = await textsFor(pids);
  const needItems: NeedItem[] = [];
  for (const l of linked) for (const t of needs.get(l.profile_id) ?? []) needItems.push({ text: t, source: "profile_need", sourceId: l.profile_id, personId: l.contact_id, personName: l.full_name });
  // need statements in my notes and meeting records (literal sentences only, never synthesized)
  const noteRows = await q<{ id: string; contact_id: string; body: string; full_name: string }>(
    `SELECT n.id, n.contact_id, n.body, c.full_name FROM notes n JOIN contacts c ON c.id=n.contact_id WHERE n.owner_user_id=$1 AND c.deleted_at IS NULL ORDER BY n.created_at DESC LIMIT 2000`,
    [userId],
  );
  for (const n of noteRows) for (const s of extractNeedStatements(n.body)) needItems.push({ text: s, source: "note", sourceId: n.id, personId: n.contact_id, personName: n.full_name });
  const meetRows = await q<{ id: string; contact_id: string; full_name: string; text: string }>(
    `SELECT m.id, mp.contact_id, c.full_name, concat_ws(E'\n', m.purpose, (SELECT string_agg(d, E'\n') FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(m.summary->'discussion')='array' THEN m.summary->'discussion' ELSE '[]'::jsonb END) d)) AS text
     FROM meetings m JOIN meeting_participants mp ON mp.meeting_id=m.id JOIN contacts c ON c.id=mp.contact_id
     WHERE m.owner_user_id=$1 ORDER BY m.created_at DESC LIMIT 500`,
    [userId],
  );
  for (const m of meetRows) for (const s of extractNeedStatements(m.text ?? "")) needItems.push({ text: s, source: "meeting", sourceId: m.id, personId: m.contact_id, personName: m.full_name });
  const offerItems: OfferItem[] = [];
  for (const l of linked) for (const t of offers.get(l.profile_id) ?? []) offerItems.push({ text: t, personId: l.contact_id, personName: l.full_name, kind: "contact" });
  if (myProfile) for (const t of offers.get(myProfile.id) ?? []) offerItems.push({ text: t, personId: `me:${userId}`, personName: "나", kind: "me" });
  for (const m of memberProfiles) for (const t of offers.get(m.profile_id) ?? []) offerItems.push({ text: t, personId: `member:${m.user_id}`, personName: `${m.name} (팀)`, kind: "member" });
  const results = detectOpportunities(needItems, offerItems, limit);
  return { results, model: "needoffer-lexical-v1", provenance: "ai_inferred" as const, scanned: { needs: needItems.length, offers: offerItems.length } };
}

// ---------- F-134 ----------
export async function whoKnows(ctx: Ctx, orgId: string, companyQuery: string) {
  await requireOrg(orgId, ctx.userId, "graph.read");
  const term = companyQuery.trim();
  if (term.length < 2) return { companies: [], results: [] };
  const policy = (await one<{ policies: OrgPolicies }>("SELECT policies FROM organizations WHERE id=$1", [orgId]))?.policies ?? {};
  const companies = await q<{ id: string; name: string }>(
    "SELECT id, name FROM companies WHERE name ILIKE $1 OR normalized_name ILIKE $1 ORDER BY length(name) LIMIT 20",
    [`%${term.replace(/[%_\\]/g, "\\$&")}%`],
  );
  if (!companies.length) return { companies: [], results: [] };
  const members = await q<{ user_id: string; name: string; graph_opt_out: boolean }>(
    `SELECT m.user_id, COALESCE(u.display_name, split_part(u.email,'@',1)) AS name, m.graph_opt_out FROM organization_members m JOIN users u ON u.id=m.user_id
     WHERE m.organization_id=$1 AND m.status='active'`,
    [orgId],
  );
  const M = new Map(members.map((m) => [m.user_id, m]));
  const rows = await q<{ id: string; full_name: string; job_title: string | null; owner_user_id: string; organization_id: string | null; scope: string; strength: number | null }>(
    `SELECT c.id, c.full_name, c.job_title, c.owner_user_id, c.organization_id, c.scope,
       (SELECT rel.strength FROM relationships rel WHERE rel.owner_user_id=c.owner_user_id AND rel.contact_id=c.id) AS strength
     FROM contacts c WHERE c.company_id = ANY($1::uuid[]) AND c.owner_user_id = ANY($2::uuid[]) AND c.deleted_at IS NULL AND c.merged_into_id IS NULL LIMIT 2000`,
    [companies.map((c) => c.id), members.map((m) => m.user_id)],
  );
  const paths: KnowsPath[] = [];
  for (const r of rows) {
    const m = M.get(r.owner_user_id)!;
    const shared = (r.organization_id === orgId && r.scope === "org") || r.owner_user_id === ctx.userId;
    if (!shared && (m.graph_opt_out || policy.graphPersonalExposure === "shared_only")) continue;
    paths.push({ memberId: r.owner_user_id, memberName: m.name, contactId: r.id, contactName: r.full_name, jobTitle: r.job_title, strength: Number(r.strength ?? 0.3), shared });
  }
  await audit(pool(), ctx, "org.who_knows", "organization", orgId, { companies: companies.length, paths: paths.length }, orgId);
  return { companies, results: rankWhoKnows(paths), provenance: "ai_inferred" as const };
}

// ---------- F-133 ----------
export async function orgGraph(ctx: Ctx, orgId: string, opts: { width?: number; height?: number } = {}) {
  await requireOrg(orgId, ctx.userId, "graph.read");
  const policy = (await one<{ policies: OrgPolicies }>("SELECT policies FROM organizations WHERE id=$1", [orgId]))?.policies ?? {};
  const members = await q<{ user_id: string; name: string; role: string; graph_opt_out: boolean }>(
    `SELECT m.user_id, COALESCE(u.display_name, split_part(u.email,'@',1)) AS name, m.role, m.graph_opt_out FROM organization_members m JOIN users u ON u.id=m.user_id
     WHERE m.organization_id=$1 AND m.status='active' LIMIT 300`,
    [orgId],
  );
  const shared = await q<{ id: string; full_name: string; owner_user_id: string; company_id: string | null; company: string | null; ownership: string; strength: number | null }>(
    `SELECT c.id, c.full_name, c.owner_user_id, c.company_id, co.name AS company, c.ownership,
       (SELECT rel.strength FROM relationships rel WHERE rel.owner_user_id=c.owner_user_id AND rel.contact_id=c.id) AS strength
     FROM contacts c LEFT JOIN companies co ON co.id=c.company_id
     WHERE c.organization_id=$1 AND c.scope='org' AND c.deleted_at IS NULL AND c.merged_into_id IS NULL ORDER BY c.updated_at DESC LIMIT 250`,
    [orgId],
  );
  // personal networks → company-level aggregates only (no names/PII), respecting member opt-out and org policy
  const exposed = policy.graphPersonalExposure === "shared_only" ? [] : members.filter((m) => !m.graph_opt_out).map((m) => m.user_id);
  const agg = exposed.length
    ? await q<{ owner_user_id: string; company_id: string; company: string; n: number; best: number | null }>(
        `SELECT x.owner_user_id, x.company_id, co.name AS company, x.n, x.best FROM (
           SELECT c.owner_user_id, c.company_id, count(*)::int AS n,
             max((SELECT rel.strength FROM relationships rel WHERE rel.owner_user_id=c.owner_user_id AND rel.contact_id=c.id)) AS best
           FROM contacts c WHERE c.owner_user_id = ANY($1::uuid[]) AND c.company_id IS NOT NULL AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
             AND (c.organization_id IS DISTINCT FROM $2 OR c.scope <> 'org')
           GROUP BY c.owner_user_id, c.company_id) x JOIN companies co ON co.id=x.company_id
         ORDER BY x.n DESC LIMIT 300`,
        [exposed, orgId],
      )
    : [];
  const nodes: (GNode & { label: string; kind: "member" | "contact" | "company"; weight?: number; meta?: Record<string, unknown> })[] = [];
  const edges: (GEdge & { kind: string })[] = [];
  const seen = new Set<string>();
  const addNode = (n: (typeof nodes)[number]) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    nodes.push(n);
  };
  for (const m of members) addNode({ id: `m:${m.user_id}`, kind: "member", label: m.name, meta: { role: m.role } });
  for (const s of shared) {
    addNode({ id: `c:${s.id}`, kind: "contact", label: s.full_name, meta: { ownership: s.ownership, company: s.company } });
    edges.push({ source: `m:${s.owner_user_id}`, target: `c:${s.id}`, weight: Number(s.strength ?? 0.3), kind: "knows" });
    if (s.company_id) {
      addNode({ id: `co:${s.company_id}`, kind: "company", label: s.company ?? "회사" });
      edges.push({ source: `c:${s.id}`, target: `co:${s.company_id}`, weight: 0.5, kind: "works_at" });
    }
  }
  for (const a of agg) {
    addNode({ id: `co:${a.company_id}`, kind: "company", label: a.company });
    edges.push({ source: `m:${a.owner_user_id}`, target: `co:${a.company_id}`, weight: Number(a.best ?? 0.3), kind: `knows_${a.n}` });
  }
  const pos = forceLayout(nodes, edges, { width: opts.width ?? 900, height: opts.height ?? 640, seed: 11 });
  return {
    width: opts.width ?? 900,
    height: opts.height ?? 640,
    nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, meta: n.meta ?? {}, ...pos[n.id]! })),
    edges: edges.map((e) => ({ source: e.source, target: e.target, weight: Math.round((e.weight ?? 0) * 100) / 100, kind: e.kind.startsWith("knows_") ? "knows_company" : e.kind, count: e.kind.startsWith("knows_") ? Number(e.kind.slice(6)) : 1 })),
    privacy: policy.graphPersonalExposure === "shared_only" ? "shared_only" : "company_level",
  };
}
