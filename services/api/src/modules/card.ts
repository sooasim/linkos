// card module — Living Business Card (F-022~F-036): 3초/30초/딥 카드, Offer/Need, 필드 ACL, 변형, Access Request
import { type Audience, EXCHANGE_AUDIENCE, type Visibility, filterFieldsByAudience, generateToken, hiddenFieldCount } from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit, emit } from "../lib/platform";
import { type CardBrand, brandForProfile } from "./org";
import { assertProfilePolicy } from "./policy";

export const FIELD_TYPES = ["email", "phone", "mobile", "website", "address", "linkedin", "instagram", "x", "github", "kakao", "booking", "other"] as const;

export const profileInput = z.object({
  name: z.string().trim().min(1).max(80),
  company: z.string().trim().max(120).nullish(),
  jobTitle: z.string().trim().max(120).nullish(),
  headline: z.string().trim().max(160).nullish(),
  bioShort: z.string().trim().max(400).nullish(),
  bioLong: z.string().trim().max(4000).nullish(),
  keywords: z.array(z.string().trim().min(1).max(30)).max(3).default([]),
  industries: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  regions: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  theme: z.enum(["ink", "paper", "signal", "ember"]).default("ink"),
  matchingOptIn: z.boolean().default(true),
  deep: z
    .object({
      projects: z.array(z.object({ title: z.string().max(120), status: z.string().max(40).optional(), description: z.string().max(600).optional() })).max(12).default([]),
      achievements: z.array(z.string().max(200)).max(12).default([]),
      services: z.array(z.string().max(200)).max(12).default([]),
      interests: z.array(z.string().max(60)).max(12).default([]),
      assets: z.array(z.string().max(200)).max(12).default([]),
      network: z.array(z.string().max(200)).max(12).default([]),
      languages: z.array(z.string().max(40)).max(8).default([]),
      certifications: z.array(z.string().max(120)).max(12).default([]),
    })
    .partial()
    .default({}),
  fields: z
    .array(
      z.object({
        type: z.enum(FIELD_TYPES),
        label: z.string().max(40).nullish(),
        value: z.string().trim().min(1).max(300),
        visibility: z.enum(["public", "business", "trusted", "partner", "private"]).default("business"),
      }),
    )
    .max(30)
    .default([]),
  offers: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  needs: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  variants: z
    .array(z.object({ audience: z.enum(["investor", "customer", "partner", "recruiting", "general"]), headline: z.string().max(160).optional(), bioShort: z.string().max(400).optional(), isDefault: z.boolean().default(false) }))
    .max(5)
    .default([]),
  version: z.number().int().optional(),
});
export type ProfileInput = z.infer<typeof profileInput>;

export interface ProfileField {
  id: string;
  type: string;
  label: string | null;
  value: string;
  visibility: Visibility;
}

export interface FullProfile {
  id: string;
  userId: string | null;
  slug: string;
  name: string;
  company: string | null;
  jobTitle: string | null;
  headline: string | null;
  bioShort: string | null;
  bioLong: string | null;
  keywords: string[];
  industries: string[];
  regions: string[];
  theme: string;
  matchingOptIn: boolean;
  deep: Record<string, unknown>;
  fields: ProfileField[];
  offers: { id: string; text: string; provenance: string; confirmed: boolean }[];
  needs: { id: string; text: string; provenance: string; confirmed: boolean }[];
  variants: { audience: string; content: Record<string, unknown>; isDefault: boolean }[];
  version: number;
  updatedAt: string;
}

function slugify(name: string): string {
  const base = name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${base || "card"}-${generateToken(16).slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

export async function loadProfile(id: string, db: Db = pool()): Promise<FullProfile | null> {
  const p = await one<Record<string, any>>("SELECT * FROM profiles WHERE id=$1", [id], db);
  if (!p) return null;
  // sequential: `db` may be a single transaction client (no concurrent queries on one client)
  const fields = await q<any>("SELECT id, field_type, label, value, visibility FROM profile_fields WHERE profile_id=$1 ORDER BY sort_order, id", [id], db);
  const offers = await q<any>("SELECT id, text, provenance, confirmed FROM offers WHERE profile_id=$1 ORDER BY created_at", [id], db);
  const needs = await q<any>("SELECT id, text, provenance, confirmed FROM needs WHERE profile_id=$1 ORDER BY created_at", [id], db);
  const variants = await q<any>("SELECT audience, content, is_default FROM profile_variants WHERE profile_id=$1", [id], db);
  return {
    id: p.id,
    userId: p.user_id,
    slug: p.slug,
    name: p.name,
    company: p.company,
    jobTitle: p.job_title,
    headline: p.headline,
    bioShort: p.bio_short,
    bioLong: p.bio_long,
    keywords: p.keywords ?? [],
    industries: p.industries ?? [],
    regions: p.regions ?? [],
    theme: p.theme,
    matchingOptIn: p.matching_opt_in,
    deep: p.deep ?? {},
    fields: fields.map((f) => ({ id: f.id, type: f.field_type, label: f.label, value: typeof f.value === "string" ? f.value : String(f.value?.v ?? f.value), visibility: f.visibility })),
    offers,
    needs,
    variants: variants.map((v) => ({ audience: v.audience, content: v.content, isDefault: v.is_default })),
    version: p.version,
    updatedAt: new Date(p.updated_at).toISOString(),
  };
}

export async function primaryProfileId(userId: string, db: Db = pool()): Promise<string | null> {
  const r = await one<{ id: string }>("SELECT id FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC, created_at LIMIT 1", [userId], db);
  return r?.id ?? null;
}

export async function listMyProfiles(userId: string) {
  return q<{ id: string; slug: string; name: string; company: string | null; is_primary: boolean }>(
    "SELECT id, slug, name, company, is_primary FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC, created_at",
    [userId],
  );
}

/** Create or update a profile. F-005 다중 프로필, F-033 Living Update(profile.updated 이벤트). */
export async function saveProfile(ctx: Ctx, input: ProfileInput, profileId?: string, db?: Db): Promise<FullProfile> {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const run = async (c: Db) => {
    let id = profileId;
    let changed: string[] = [];
    let version = 1;
    if (id) {
      const cur = await one<any>("SELECT * FROM profiles WHERE id=$1 FOR UPDATE", [id], c);
      if (!cur) throw notFound("profile");
      if (cur.user_id !== userId) throw forbidden();
      // F-139: org card policy (min field visibility / required fields) for org-attached cards
      await assertProfilePolicy(id, input.fields.map((f) => ({ type: f.type, visibility: f.visibility, value: f.value })), c);
      if (input.version !== undefined && input.version !== cur.version) {
        throw conflict("version_conflict", "다른 기기에서 먼저 수정되었습니다. 최신 내용을 확인하세요.", { serverVersion: cur.version });
      }
      const map: Record<string, unknown> = { name: input.name, company: input.company ?? null, job_title: input.jobTitle ?? null, headline: input.headline ?? null };
      changed = Object.entries(map).filter(([k, v]) => (cur[k] ?? null) !== v).map(([k]) => k);
      version = cur.version + 1;
      await c.query(
        `UPDATE profiles SET name=$2, company=$3, job_title=$4, headline=$5, bio_short=$6, bio_long=$7, keywords=$8, industries=$9, regions=$10,
         theme=$11, matching_opt_in=$12, deep=$13, version=$14, updated_at=now() WHERE id=$1`,
        [id, input.name, input.company ?? null, input.jobTitle ?? null, input.headline ?? null, input.bioShort ?? null, input.bioLong ?? null, input.keywords, input.industries, input.regions, input.theme, input.matchingOptIn, JSON.stringify(input.deep ?? {}), version],
      );
    } else {
      const hasPrimary = await one("SELECT 1 FROM profiles WHERE user_id=$1 AND is_primary", [userId], c);
      const row = await one<{ id: string }>(
        `INSERT INTO profiles (user_id, name, company, job_title, headline, bio_short, bio_long, keywords, industries, regions, theme, matching_opt_in, deep, slug, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [userId, input.name, input.company ?? null, input.jobTitle ?? null, input.headline ?? null, input.bioShort ?? null, input.bioLong ?? null, input.keywords, input.industries, input.regions, input.theme, input.matchingOptIn, JSON.stringify(input.deep ?? {}), slugify(input.name), !hasPrimary],
        c,
      );
      id = row!.id;
      changed = ["created"];
      await c.query("UPDATE users SET display_name = COALESCE(display_name, $2) WHERE id=$1", [userId, input.name]);
    }
    await c.query("DELETE FROM profile_fields WHERE profile_id=$1", [id]);
    let i = 0;
    for (const f of input.fields) {
      await c.query("INSERT INTO profile_fields (profile_id, field_type, label, value, visibility, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", [id, f.type, f.label ?? null, JSON.stringify(f.value), f.visibility, i++]);
    }
    await syncTexts(c, "offers", id!, input.offers);
    await syncTexts(c, "needs", id!, input.needs);
    await c.query("DELETE FROM profile_variants WHERE profile_id=$1", [id]);
    for (const v of input.variants) {
      await c.query("INSERT INTO profile_variants (profile_id, audience, content, is_default) VALUES ($1,$2,$3,$4)", [id, v.audience, JSON.stringify({ headline: v.headline, bioShort: v.bioShort }), v.isDefault]);
    }
    await emit(c, "profile.updated", "profile", id!, { profile_id: id!, changed_fields: changed, version });
    await audit(c, ctx, profileId ? "profile.updated" : "profile.created", "profile", id!);
    return (await loadProfile(id!, c))!;
  };
  return db ? run(db) : tx(run);
}

async function syncTexts(c: Db, table: "offers" | "needs", profileId: string, texts: string[]) {
  const existing = await q<{ id: string; text: string }>(`SELECT id, text FROM ${table} WHERE profile_id=$1`, [profileId], c);
  const keep = new Set(texts);
  for (const e of existing) if (!keep.has(e.text)) await c.query(`DELETE FROM ${table} WHERE id=$1`, [e.id]);
  const have = new Set(existing.map((e) => e.text));
  for (const t of texts) if (!have.has(t)) await c.query(`INSERT INTO ${table} (profile_id, text, provenance, confirmed) VALUES ($1,$2,'user',true)`, [profileId, t]);
}

export interface PublicCard {
  id: string;
  slug: string;
  name: string;
  company: string | null;
  jobTitle: string | null;
  headline: string | null;
  bioShort: string | null;
  keywords: string[];
  theme: string;
  fields: Omit<ProfileField, "id">[];
  offers: string[];
  needs: string[];
  deep: Record<string, unknown> | null;
  hiddenFields: number;
  /** F-138: org branding on member cards (null unless the org enabled it and the card is attached) */
  brand?: CardBrand | null;
}

/** Public-safe projection after ACL filtering (F-034). bio_long/deep only for trusted+. */
export function projectCard(p: FullProfile, audience: Audience): PublicCard {
  const visible = filterFieldsByAudience(p.fields, audience);
  const deepAllowed = audience === "owner" || audience === "trusted" || audience === "partner" || audience === "business";
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    company: p.company,
    jobTitle: p.jobTitle,
    headline: p.headline,
    bioShort: p.bioShort,
    keywords: p.keywords,
    theme: p.theme,
    fields: visible.map(({ type, label, value, visibility }) => ({ type, label, value, visibility })),
    offers: p.offers.filter((o) => o.confirmed).map((o) => o.text),
    needs: p.needs.filter((n) => n.confirmed).map((n) => n.text),
    deep: deepAllowed ? p.deep : null,
    hiddenFields: hiddenFieldCount(p.fields.filter((f) => f.visibility !== "private"), audience),
  };
}

export async function getPublicProfileBySlug(slug: string, viewerUserId: string | null): Promise<PublicCard> {
  const row = await one<{ id: string; user_id: string }>("SELECT id, user_id FROM profiles WHERE slug=$1", [slug]);
  if (!row) throw notFound("profile");
  const p = (await loadProfile(row.id))!;
  let audience: Audience = "public";
  if (viewerUserId && viewerUserId === row.user_id) audience = "owner";
  else if (viewerUserId) {
    // the owner has a relationship with the viewer → business; approved access requests → trusted
    const granted = await one<{ ok: boolean }>(
      "SELECT true AS ok FROM access_requests WHERE requester_user_id=$1 AND target_profile_id=$2 AND status='approved' LIMIT 1",
      [viewerUserId, row.id],
    );
    const related = await one("SELECT 1 FROM contacts WHERE owner_user_id=$1 AND linked_user_id=$2 AND deleted_at IS NULL", [row.user_id, viewerUserId]);
    audience = granted ? "trusted" : related ? "business" : "public";
  }
  return { ...projectCard(p, audience), brand: await brandForProfile(row.id) };
}

export async function getExchangeCard(profileId: string, db: Db = pool()): Promise<PublicCard> {
  const p = await loadProfile(profileId, db);
  if (!p) throw notFound("profile");
  return { ...projectCard(p, EXCHANGE_AUDIENCE), brand: await brandForProfile(profileId, db) };
}

// ---------- Access Request (F-035) ----------
export async function requestAccess(ctx: Ctx, profileId: string, fields: string[], message?: string) {
  if (!ctx.userId) throw unauthorized();
  const p = await one<{ user_id: string }>("SELECT user_id FROM profiles WHERE id=$1", [profileId]);
  if (!p) throw notFound("profile");
  if (p.user_id === ctx.userId) throw badRequest("own_profile");
  const existing = await one<{ id: string }>("SELECT id FROM access_requests WHERE requester_user_id=$1 AND target_profile_id=$2 AND status='pending'", [ctx.userId, profileId]);
  if (existing) return { id: existing.id, status: "pending" };
  const r = await one<{ id: string }>(
    "INSERT INTO access_requests (requester_user_id, target_profile_id, requested_fields) VALUES ($1,$2,$3) RETURNING id",
    [ctx.userId, profileId, fields.length ? fields : ["trusted"]],
  );
  await audit(pool(), ctx, "access_request.created", "profile", profileId, { message: message ? "[provided]" : null });
  return { id: r!.id, status: "pending" };
}

export async function listIncomingAccessRequests(userId: string) {
  return q<any>(
    `SELECT ar.id, ar.requested_fields, ar.status, ar.created_at, u.display_name AS requester_name, u.email AS requester_email
     FROM access_requests ar JOIN profiles p ON p.id = ar.target_profile_id JOIN users u ON u.id = ar.requester_user_id
     WHERE p.user_id=$1 ORDER BY ar.created_at DESC LIMIT 100`,
    [userId],
  );
}

export async function resolveAccessRequest(ctx: Ctx, id: string, approve: boolean) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<{ id: string }>(
    `UPDATE access_requests ar SET status=$3, resolved_at=now() FROM profiles p
     WHERE ar.id=$1 AND p.id=ar.target_profile_id AND p.user_id=$2 AND ar.status='pending' RETURNING ar.id`,
    [id, ctx.userId, approve ? "approved" : "declined"],
  );
  if (!r) throw notFound("access request");
  await audit(pool(), ctx, approve ? "access_request.approved" : "access_request.declined", "access_request", id);
  return { id, status: approve ? "approved" : "declined" };
}
