// living module — Living Card intelligence:
// F-031 프로필 변형 auto-select, F-032 AI Adaptive Card(제안만, 소유자 확인 후 반영), F-033 Living Update(연결 상대에게 갱신 제안),
// F-036 Action Card CTA(예약/견적/제안/NDA 요청 — 게스트 가능, rate limit, 동의 기록)
import {
  ACTION_KINDS,
  ACTION_LABEL_KO,
  type ActionKind,
  LIVING_FIELDS,
  POLICY_VERSIONS,
  filterFieldsByAudience,
  livingUpdateDiff,
  normalizeEmail,
  rankHighlights,
  scoreVariants,
  selectVariant,
} from "@linkos/domain";
import { isValidGlyph, resolveGlyph } from "@linkos/domain/cardDesign";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { badRequest, forbidden, notFound, unauthorized } from "../lib/errors";
import { structured } from "../lib/llm";
import { track } from "../lib/metering";
import { type Ctx, audit, emit, rateLimit } from "../lib/platform";
import { type FullProfile, type PublicCard, glyphRef, loadProfile } from "./card";
import { notify } from "./inbox";
import { upsertCompany } from "./relationship";

// ---------- F-031 variant auto-select ----------
export interface VariantRequest {
  explicit?: string | null;
  eventId?: string | null;
  /** an existing contact of the owner (the recipient) — industry/title context */
  contactId?: string | null;
}

async function variantContext(ownerUserId: string, req: VariantRequest, db: Db) {
  const eventAudience = req.eventId ? ((await one<{ audience: string | null }>("SELECT audience FROM events WHERE id=$1", [req.eventId], db))?.audience ?? null) : null;
  let recipient: { job_title: string | null; company: string | null; industry: string | null } | null = null;
  if (req.contactId) {
    recipient = await one(
      `SELECT c.job_title, co.name AS company, co.industry FROM contacts c LEFT JOIN companies co ON co.id=c.company_id
       WHERE c.id=$1 AND c.owner_user_id=$2 AND c.deleted_at IS NULL`,
      [req.contactId, ownerUserId],
      db,
    );
  }
  return { eventAudience, recipientIndustry: recipient?.industry ?? null, recipientTitle: recipient?.job_title ?? null, recipientCompany: recipient?.company ?? null };
}

export async function chooseVariant(p: FullProfile, req: VariantRequest, db: Db = pool()) {
  const ctx = await variantContext(p.userId ?? "", req, db);
  const sel = selectVariant(p.variants, { explicit: req.explicit, ownerIndustries: p.industries, ...ctx });
  const variant = sel.audience ? (p.variants.find((v) => v.audience === sel.audience) ?? null) : null;
  return { ...sel, variant };
}

async function highlightsFor(profileId: string, audience: string, db: Db): Promise<string[]> {
  return (await one<{ highlights: string[] }>("SELECT highlights FROM profile_variants WHERE profile_id=$1 AND audience=$2", [profileId, audience], db))?.highlights ?? [];
}

/** Apply the chosen variant to an already ACL-filtered card (headline/bio override + confirmed highlight order). */
export async function adaptCard(card: PublicCard, profileId: string, req: VariantRequest, db: Db = pool()): Promise<PublicCard & { audience: string | null; audienceReason: string }> {
  const p = await loadProfile(profileId, db);
  if (!p || !p.variants.length) return { ...card, audience: null, audienceReason: "none" };
  const sel = await chooseVariant(p, req, db);
  if (!sel.variant) return { ...card, audience: null, audienceReason: sel.reason };
  const content = sel.variant.content as { headline?: string; bioShort?: string };
  const order = await highlightsFor(profileId, sel.variant.audience, db);
  const offers = order.length ? [...order.filter((h) => card.offers.includes(h)), ...card.offers.filter((o) => !order.includes(o))] : card.offers;
  return { ...card, headline: content.headline || card.headline, bioShort: content.bioShort || card.bioShort, offers, audience: sel.variant.audience, audienceReason: sel.reason };
}

/** Exchange-session wrapper used by the guest landing (context comes from the sender's session). */
export async function adaptCardForSession(card: PublicCard, profileId: string, context: Record<string, unknown> | null | undefined) {
  return adaptCard(card, profileId, { explicit: (context?.audience as string | undefined) ?? null, eventId: (context?.eventId as string | undefined) ?? null });
}

/** GET /profiles/{id}/variant — owner preview of which variant a recipient would see. */
export async function previewVariant(ctx: Ctx, profileId: string, req: VariantRequest) {
  if (!ctx.userId) throw unauthorized();
  const p = await loadProfile(profileId);
  if (!p || p.userId !== ctx.userId) throw notFound("profile");
  const sel = await chooseVariant(p, req);
  return { audience: sel.audience, reason: sel.reason, content: sel.variant?.content ?? null, highlights: sel.audience ? await highlightsFor(p.id, sel.audience, pool()) : [] };
}

// ---------- F-032 AI Adaptive Card ----------
export const adaptiveInput = z.object({
  contactId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  context: z.string().trim().max(1000).optional(),
});

const AdaptiveSchema = z.object({
  audience: z.string(),
  highlights: z.array(z.string()),
  reasons: z.array(z.string()),
});

function profileHighlights(p: FullProfile): string[] {
  const deep = p.deep as { achievements?: string[]; services?: string[] };
  return [...new Set([...p.offers.filter((o) => o.confirmed).map((o) => o.text), ...p.keywords, ...(deep.achievements ?? []), ...(deep.services ?? [])])].slice(0, 20);
}

/**
 * POST /profiles/{id}/adaptive — suggestion only (labeled "AI 추론", needs owner confirmation).
 * The model may only pick an existing variant and reorder existing highlights; anything else is discarded.
 */
export async function adaptiveSuggest(ctx: Ctx, profileId: string, input: z.infer<typeof adaptiveInput>) {
  if (!ctx.userId) throw unauthorized();
  const p = await loadProfile(profileId);
  if (!p || p.userId !== ctx.userId) throw notFound("profile");
  if (!p.variants.length) throw badRequest("no_variants", "먼저 상대별 카드 변형을 하나 이상 만들어 주세요.");
  const vctx = await variantContext(ctx.userId, { eventId: input.eventId, contactId: input.contactId }, pool());
  const eventName = input.eventId ? ((await one<{ name: string }>("SELECT name FROM events WHERE id=$1", [input.eventId]))?.name ?? "") : "";
  const contextText = [vctx.recipientTitle, vctx.recipientCompany, vctx.recipientIndustry, eventName, input.context].filter(Boolean).join(" · ");
  const highlights = profileHighlights(p);
  const audiences = p.variants.map((v) => v.audience);

  const llm = await structured({
    schema: AdaptiveSchema,
    task:
      `Choose which audience variant of this business card best fits the recipient, and order the card's highlights for that recipient. ` +
      `audience MUST be one of: ${audiences.join(", ")}. highlights MUST be copied verbatim from the provided list (reorder only; do not add or rewrite). ` +
      `reasons: up to 3 short reasons grounded in the recipient context.`,
    data: JSON.stringify({ recipient: contextText, variants: p.variants.map((v) => ({ audience: v.audience, content: v.content })), highlights }),
    promptVersion: "adaptive-card-v1",
    ownerUserId: ctx.userId,
    kind: "adaptive_card",
    sourceIds: [p.id, ...(input.contactId ? [input.contactId] : []), ...(input.eventId ? [input.eventId] : [])],
  });

  let audience: string;
  let ordered: string[];
  let reasons: string[];
  let provenance: "ai" | "rules";
  if (llm && audiences.includes(llm.output.audience)) {
    const valid = llm.output.highlights.filter((h) => highlights.includes(h));
    ordered = [...new Set([...valid, ...highlights])];
    audience = llm.output.audience;
    reasons = llm.output.reasons.slice(0, 3).map((r) => r.slice(0, 200));
    provenance = "ai";
  } else {
    const sel = selectVariant(p.variants, { ownerIndustries: p.industries, ...vctx });
    const scored = scoreVariants(p.variants, contextText);
    audience = sel.reason !== "default" && sel.reason !== "none" && sel.audience ? sel.audience : (scored[0]?.audience ?? audiences[0]!);
    ordered = rankHighlights(highlights, contextText);
    reasons = contextText ? [`상대 맥락: ${contextText.slice(0, 120)}`] : ["상대 정보가 없어 기본 변형을 추천합니다."];
    provenance = "rules";
  }
  return { audience, highlights: ordered, reasons, provenance, label: "AI 추론", needsConfirmation: true };
}

export const adaptiveConfirmInput = z.object({
  audience: z.string().max(40),
  highlights: z.array(z.string().max(200)).max(20),
  makeDefault: z.boolean().default(false),
});

/** POST /profiles/{id}/adaptive/confirm — the owner accepts (possibly edited) suggestion. */
export async function adaptiveConfirm(ctx: Ctx, profileId: string, input: z.infer<typeof adaptiveConfirmInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  return tx(async (c) => {
    const p = await loadProfile(profileId, c);
    if (!p || p.userId !== userId) throw notFound("profile");
    if (!p.variants.some((v) => v.audience === input.audience)) throw badRequest("unknown_variant");
    const allowed = new Set(profileHighlights(p));
    const highlights = input.highlights.filter((h) => allowed.has(h));
    await c.query("UPDATE profile_variants SET highlights=$3 WHERE profile_id=$1 AND audience=$2", [profileId, input.audience, highlights]);
    if (input.makeDefault) await c.query("UPDATE profile_variants SET is_default = (audience = $2) WHERE profile_id=$1", [profileId, input.audience]);
    await c.query("UPDATE ai_runs SET user_confirmed=true WHERE id = (SELECT id FROM ai_runs WHERE owner_user_id=$1 AND kind='adaptive_card' AND $2 = ANY(source_ids) ORDER BY created_at DESC LIMIT 1)", [userId, profileId]);
    await audit(c, ctx, "profile.adaptive_confirmed", "profile", profileId, { audience: input.audience, makeDefault: input.makeDefault });
    return { audience: input.audience, highlights, isDefault: input.makeDefault };
  });
}

// ---------- F-033 Living Update ----------
/**
 * Outbox consumer for profile.updated: for every contact other users hold of this person, compare the business-visible
 * company / title / website with what they have and leave an update suggestion + inbox notification. Idempotent.
 */
export async function fanOutLivingUpdate(c: Db, profileId: string): Promise<number> {
  const p = await loadProfile(profileId, c);
  if (!p?.userId) return 0;
  const primary = await one<{ is_primary: boolean }>("SELECT is_primary FROM profiles WHERE id=$1", [profileId], c);
  if (!primary?.is_primary) return 0;
  // ACL: contact holders exchanged with this person → business audience
  const website = filterFieldsByAudience(p.fields, "business").find((f) => f.type === "website")?.value ?? null;
  const target = { company: p.company, jobTitle: p.jobTitle, website };
  const holders = await q<{ id: string; owner_user_id: string; company: string | null; job_title: string | null; website: string | null }>(
    `SELECT c.id, c.owner_user_id, co.name AS company, c.job_title, c.website FROM contacts c LEFT JOIN companies co ON co.id=c.company_id
     JOIN users u ON u.id = c.owner_user_id AND u.status='active'
     WHERE c.linked_user_id=$1 AND c.owner_user_id <> $1 AND c.deleted_at IS NULL AND c.merged_into_id IS NULL`,
    [p.userId],
    c,
  );
  let n = 0;
  for (const h of holders) {
    const changes = livingUpdateDiff(target, { company: h.company, jobTitle: h.job_title, website: h.website });
    if (!changes.length) {
      await c.query("UPDATE living_update_suggestions SET status='superseded', resolved_at=now() WHERE contact_id=$1 AND status='pending'", [h.id]);
      continue;
    }
    const existing = await one<{ id: string }>("SELECT id FROM living_update_suggestions WHERE contact_id=$1 AND status='pending' FOR UPDATE", [h.id], c);
    let sid: string;
    if (existing) {
      await c.query("UPDATE living_update_suggestions SET changes=$2, profile_version=$3, created_at=now() WHERE id=$1", [existing.id, JSON.stringify(changes), p.version]);
      sid = existing.id;
    } else {
      sid = (await one<{ id: string }>(
        "INSERT INTO living_update_suggestions (owner_user_id, contact_id, source_profile_id, profile_version, changes) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [h.owner_user_id, h.id, profileId, p.version, JSON.stringify(changes)],
        c,
      ))!.id;
    }
    const label: Record<string, string> = { company: "회사", jobTitle: "직책", website: "웹사이트" };
    await notify(c, h.owner_user_id, {
      kind: "living_update",
      title: `${p.name}님의 정보가 바뀌었어요`,
      body: changes.map((x) => `${label[x.field]}: ${x.from ?? "—"} → ${x.to}`).join("\n"),
      link: `/app/inbox`,
      data: { suggestionId: sid, contactId: h.id },
      dedupeKey: `living:${h.id}`,
    });
    n++;
  }
  return n;
}

export async function listLivingUpdates(userId: string) {
  return q<any>(
    `SELECT s.id, s.contact_id, c.full_name, s.changes, s.created_at FROM living_update_suggestions s JOIN contacts c ON c.id=s.contact_id
     WHERE s.owner_user_id=$1 AND s.status='pending' ORDER BY s.created_at DESC LIMIT 100`,
    [userId],
  );
}

export const livingResolveInput = z.object({
  accept: z.boolean(),
  fields: z.array(z.enum(LIVING_FIELDS)).optional(),
});

/** POST /living-updates/{id} — accept (contact updated, provenance 'sync') or dismiss. */
export async function resolveLivingUpdate(ctx: Ctx, id: string, input: z.infer<typeof livingResolveInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  return tx(async (c) => {
    const s = await one<{ id: string; contact_id: string; changes: { field: string; from: string | null; to: string }[]; profile_version: number; source_profile_id: string }>(
      "SELECT * FROM living_update_suggestions WHERE id=$1 AND owner_user_id=$2 AND status='pending' FOR UPDATE",
      [id, userId],
      c,
    );
    if (!s) throw notFound("living update");
    if (!input.accept) {
      await c.query("UPDATE living_update_suggestions SET status='dismissed', resolved_at=now() WHERE id=$1", [id]);
      await c.query("UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE user_id=$1 AND dedupe_key=$2", [userId, `living:${s.contact_id}`]);
      await audit(c, ctx, "living_update.dismissed", "contact", s.contact_id);
      return { status: "dismissed" as const, contactId: s.contact_id };
    }
    const pick = s.changes.filter((x) => !input.fields || input.fields.includes(x.field as (typeof LIVING_FIELDS)[number]));
    const cur = await one<{ field_provenance: Record<string, unknown> }>("SELECT field_provenance FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL FOR UPDATE", [s.contact_id, userId], c);
    if (!cur) throw notFound("contact");
    const prov = { ...cur.field_provenance };
    const at = new Date().toISOString();
    for (const ch of pick) {
      if (ch.field === "company") await c.query("UPDATE contacts SET company_id=$2 WHERE id=$1", [s.contact_id, await upsertCompany(c, ch.to)]);
      else if (ch.field === "jobTitle") await c.query("UPDATE contacts SET job_title=$2 WHERE id=$1", [s.contact_id, ch.to]);
      else if (ch.field === "website") await c.query("UPDATE contacts SET website=$2 WHERE id=$1", [s.contact_id, ch.to]);
      prov[ch.field] = { source: "sync", confidence: 1, at, profileVersion: s.profile_version };
      await c.query("INSERT INTO contact_field_history (contact_id, owner_user_id, field, old_value, new_value, source) VALUES ($1,$2,$3,$4,$5,'sync')", [s.contact_id, userId, ch.field, ch.from, ch.to]);
    }
    if (pick.length) {
      await c.query("UPDATE contacts SET field_provenance=$2, version=version+1, updated_at=now() WHERE id=$1", [s.contact_id, JSON.stringify(prov)]);
      await emit(c, "contact.updated", "contact", s.contact_id, { contact_id: s.contact_id, changed_fields: pick.map((x) => x.field) });
    }
    await c.query("UPDATE living_update_suggestions SET status='accepted', resolved_at=now() WHERE id=$1", [id]);
    await c.query("UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE user_id=$1 AND dedupe_key=$2", [userId, `living:${s.contact_id}`]);
    await audit(c, ctx, "living_update.accepted", "contact", s.contact_id, { fields: pick.map((x) => x.field) });
    await track(c, "living_update_accepted", { userId }, { fields: pick.length });
    return { status: "accepted" as const, contactId: s.contact_id, applied: pick.map((x) => x.field) };
  });
}

// ---------- F-036 Action Card ----------
// F-036 + F-021: each CTA may carry an icon/emoji from the banks ("i:<id>" | "e:<emoji>"), validated on save.
const ctaIcon = glyphRef.refine(isValidGlyph, "unknown icon or emoji").nullish();
export const actionCtasInput = z.object({
  booking: z.object({ enabled: z.boolean(), url: z.string().url().max(300).refine((u) => /^https:\/\//.test(u), "https only").nullish(), icon: ctaIcon }).default({ enabled: false }),
  quote: z.object({ enabled: z.boolean(), icon: ctaIcon }).default({ enabled: false }),
  proposal: z.object({ enabled: z.boolean(), icon: ctaIcon }).default({ enabled: false }),
  nda: z.object({ enabled: z.boolean(), icon: ctaIcon }).default({ enabled: false }),
});
export type ActionCtas = z.infer<typeof actionCtasInput>;

export async function setActionCtas(ctx: Ctx, profileId: string, input: ActionCtas) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<{ id: string }>("UPDATE profiles SET action_ctas=$3, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id", [profileId, ctx.userId, JSON.stringify(input)]);
  if (!r) throw notFound("profile");
  await audit(pool(), ctx, "profile.action_ctas_updated", "profile", profileId, { enabled: ACTION_KINDS.filter((k) => input[k].enabled) });
  return input;
}

function publicCtas(raw: Partial<ActionCtas> | null | undefined) {
  const r = actionCtasInput.safeParse(raw ?? {});
  const v = r.success ? r.data : actionCtasInput.parse({});
  return ACTION_KINDS.filter((k) => v[k].enabled).map((k) => ({ kind: k, label: ACTION_LABEL_KO[k], url: k === "booking" ? (v.booking.url ?? null) : null, glyph: resolveGlyph(v[k].icon) }));
}

/** Public: which CTAs a card shows (by profile id or slug). */
export async function getActionCtas(profileIdOrSlug: string) {
  const isId = /^[0-9a-f-]{36}$/i.test(profileIdOrSlug);
  const p = await one<{ id: string; action_ctas: Partial<ActionCtas> }>(`SELECT id, action_ctas FROM profiles WHERE ${isId ? "id" : "slug"}=$1`, [profileIdOrSlug]);
  if (!p) throw notFound("profile");
  return { profileId: p.id, actions: publicCtas(p.action_ctas), consentPolicyVersion: POLICY_VERSIONS.exchange };
}

export async function getOwnActionCtas(ctx: Ctx, profileId: string) {
  if (!ctx.userId) throw unauthorized();
  const p = await one<{ action_ctas: Partial<ActionCtas> }>("SELECT action_ctas FROM profiles WHERE id=$1 AND user_id=$2", [profileId, ctx.userId]);
  if (!p) throw notFound("profile");
  const v = actionCtasInput.parse(p.action_ctas ?? {});
  // F-021: resolved icons for the owner's editor preview (refs stay in each CTA's `icon`)
  return { ...v, glyphs: Object.fromEntries(ACTION_KINDS.map((k) => [k, resolveGlyph(v[k].icon)])) };
}

export const actionRequestInput = z.object({
  kind: z.enum(ACTION_KINDS),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().max(200),
  company: z.string().trim().max(120).nullish(),
  message: z.string().trim().max(2000).nullish(),
  details: z
    .object({
      preferredTimes: z.array(z.string().max(80)).max(5).optional(),
      budget: z.string().max(80).optional(),
      scope: z.string().max(1000).optional(),
      deadline: z.string().max(40).optional(),
    })
    .default({}),
  consent: z.literal(true),
  /** honeypot: must stay empty */
  website: z.string().max(0).optional(),
});

/** POST /cards/{profileId}/actions — guest-accessible request (no login). Rate limited per IP and per card. */
export async function submitActionRequest(ctx: Ctx, profileId: string, input: z.infer<typeof actionRequestInput>) {
  await rateLimit(`action:ip:${ctx.ip}`, 10, 3600);
  await rateLimit(`action:card:${profileId}`, 200, 86400);
  const email = normalizeEmail(input.email);
  if (!email) throw badRequest("invalid_email", "올바른 이메일을 입력하세요.");
  const p = await one<{ id: string; user_id: string | null; name: string; action_ctas: Partial<ActionCtas> }>("SELECT id, user_id, name, action_ctas FROM profiles WHERE id=$1", [profileId]);
  if (!p?.user_id) throw notFound("profile");
  if (!publicCtas(p.action_ctas).some((a) => a.kind === input.kind)) throw forbidden("이 카드에서 받지 않는 요청입니다.");
  if (ctx.userId && ctx.userId === p.user_id) throw badRequest("own_card");
  const ownerId = p.user_id;
  return tx(async (c) => {
    const r = await one<{ id: string; created_at: Date }>(
      `INSERT INTO card_action_requests (profile_id, owner_user_id, kind, requester_user_id, requester_name, requester_email, requester_company, message, details, consent_policy_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
      [p.id, ownerId, input.kind, ctx.userId, input.name, email, input.company ?? null, input.message ?? null, JSON.stringify(input.details), POLICY_VERSIONS.exchange],
      c,
    );
    if (ctx.userId) {
      await c.query("INSERT INTO consent_records (subject_user_id, consent_type, policy_version, granted, context) VALUES ($1,'exchange',$2,true,$3)", [
        ctx.userId,
        POLICY_VERSIONS.exchange,
        JSON.stringify({ action_request: r!.id, kind: input.kind }),
      ]);
    }
    await notify(c, ownerId, {
      kind: "action_request",
      title: `새 ${ACTION_LABEL_KO[input.kind]}: ${input.name}${input.company ? ` · ${input.company}` : ""}`,
      body: input.message?.slice(0, 200) ?? null,
      link: "/app/inbox",
      data: { requestId: r!.id, kind: input.kind },
    });
    await audit(c, { userId: ctx.userId }, "action_request.created", "profile", p.id, { kind: input.kind, guest: !ctx.userId });
    await track(c, "action_request_submitted", { userId: ctx.userId, anonId: ctx.userId ? null : `ip:${ctx.ip}` }, { kind: input.kind, guest: !ctx.userId });
    return { id: r!.id, status: "new", kind: input.kind, createdAt: r!.created_at };
  });
}

export async function listActionRequests(userId: string, status?: string) {
  return q<any>(
    `SELECT id, profile_id, kind, requester_name, requester_email, requester_company, message, details, status, created_at FROM card_action_requests
     WHERE owner_user_id=$1 ${status ? "AND status=$2" : ""} ORDER BY created_at DESC LIMIT 200`,
    status ? [userId, status] : [userId],
  );
}

export async function updateActionRequest(ctx: Ctx, id: string, status: "in_progress" | "done" | "declined") {
  if (!ctx.userId) throw unauthorized();
  const r = await one<{ id: string }>(
    "UPDATE card_action_requests SET status=$3, resolved_at = CASE WHEN $3 IN ('done','declined') THEN now() END WHERE id=$1 AND owner_user_id=$2 RETURNING id",
    [id, ctx.userId, status],
  );
  if (!r) throw notFound("action request");
  await audit(pool(), ctx, "action_request.updated", "card_action_request", id, { status });
  return { id, status };
}

export type { ActionKind };
