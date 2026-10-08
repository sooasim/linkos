// org module — F-129 조직/워크스페이스(tenant isolation), F-130 역할 권한, F-004 조직 가입(초대/도메인/승인),
// F-131 팀 주소록, F-132 회사 소유 리드(퇴사 시 재배정), F-077 담당자, F-076 공유 메모, F-138 브랜딩 적용 범위.
// Tenant isolation: every org call resolves the caller's ACTIVE membership first (404 for non-members, 403 for missing permission).
import {
  DOMAIN_JOIN_MODES,
  ORG_ROLES,
  type OrgBranding,
  type OrgRole,
  type Permission,
  can,
  canAssignRole,
  canInviteAs,
  domainJoinDecision,
  generateToken,
  hashToken,
  isWellFormedToken,
  normalizeEmail,
  permissionsOf,
  slugifyOrg,
  validateBranding,
  verifyDomainClaim,
  wouldOrphanOrg,
} from "@linkos/domain";
import type pg from "pg";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, conflict, forbidden, gone, notFound, unauthorized } from "../lib/errors";
import { type Ctx, appOrigin, audit, emit, rateLimit } from "../lib/platform";
import { recordReferral } from "./referral";
import { contactInput, insertContact } from "./relationship";

export interface Membership {
  orgId: string;
  role: OrgRole;
}

/** Resolve the caller's active membership and check a permission. Pass the tx client when inside a transaction. */
export async function requireOrg(orgId: string, userId: string | null, perm: Permission, db: Db = pool()): Promise<Membership> {
  if (!userId) throw unauthorized();
  if (!z.string().uuid().safeParse(orgId).success) throw notFound("organization");
  const m = await one<{ role: OrgRole }>("SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND status='active'", [orgId, userId], db);
  if (!m) throw notFound("organization"); // non-members cannot even learn that the org exists
  if (!can(m.role, perm)) throw forbidden(`이 작업에는 '${perm}' 권한이 필요합니다.`);
  return { orgId, role: m.role };
}

// ---------- F-129 organizations ----------
export const orgCreateInput = z.object({ name: z.string().trim().min(2).max(80) });

async function uniqueSlug(name: string, db: Db): Promise<string> {
  const base = slugifyOrg(name);
  for (let i = 0; i < 6; i++) {
    const cand = i === 0 ? base : `${base}-${generateToken(8).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4)}`;
    if (!(await one("SELECT 1 FROM organizations WHERE slug=$1", [cand], db))) return cand;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function createOrg(ctx: Ctx, input: z.infer<typeof orgCreateInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await rateLimit(`org:create:${userId}`, 10, 3600);
  return tx(async (c) => {
    const slug = await uniqueSlug(input.name, c);
    const o = await one<{ id: string }>("INSERT INTO organizations (name, slug, created_by) VALUES ($1,$2,$3) RETURNING id", [input.name, slug, userId], c);
    await addMember(c, o!.id, userId, "owner", { source: "create" });
    await c.query("UPDATE users SET active_org_id=$2 WHERE id=$1", [userId, o!.id]);
    await audit(c, ctx, "org.created", "organization", o!.id, { slug }, o!.id);
    return getOrgInternal(o!.id, userId, c);
  });
}

async function addMember(c: Db, orgId: string, userId: string, role: OrgRole, opts: { source: string; invitedBy?: string | null; status?: "active" | "pending" }) {
  await c.query(
    `INSERT INTO organization_members (organization_id, user_id, role, status, joined_at, invited_by, join_source, left_at)
     VALUES ($1,$2,$3,$4,now(),$5,$6,NULL)
     ON CONFLICT (organization_id, user_id) DO UPDATE SET role=EXCLUDED.role, status=EXCLUDED.status, joined_at=now(),
       invited_by=EXCLUDED.invited_by, join_source=EXCLUDED.join_source, left_at=NULL`,
    [orgId, userId, role, opts.status ?? "active", opts.invitedBy ?? null, opts.source],
  );
  if ((opts.status ?? "active") === "active") {
    // F-138: attach the member's primary card to the org (branding) unless it already belongs to another org
    await c.query(
      `UPDATE profiles SET organization_id=$2 WHERE id = (SELECT id FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC, created_at LIMIT 1) AND organization_id IS NULL`,
      [userId, orgId],
    );
  }
}

async function getOrgInternal(orgId: string, userId: string, db: Db) {
  const o = await one<any>("SELECT * FROM organizations WHERE id=$1", [orgId], db);
  if (!o) throw notFound("organization");
  const m = await one<{ role: OrgRole; graph_opt_out: boolean }>("SELECT role, graph_opt_out FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND status='active'", [orgId, userId], db);
  if (!m) throw notFound("organization");
  const counts = await one<{ members: number; pending: number; shared: number; leads: number }>(
    `SELECT (SELECT count(*)::int FROM organization_members WHERE organization_id=$1 AND status='active') AS members,
            (SELECT count(*)::int FROM organization_members WHERE organization_id=$1 AND status='pending') AS pending,
            (SELECT count(*)::int FROM contacts WHERE organization_id=$1 AND scope='org' AND deleted_at IS NULL AND merged_into_id IS NULL) AS shared,
            (SELECT count(*)::int FROM contacts WHERE organization_id=$1 AND scope='org' AND ownership='company' AND deleted_at IS NULL AND merged_into_id IS NULL) AS leads`,
    [orgId],
    db,
  );
  const isAdmin = can(m.role, "org.update");
  // F-138: my primary card carries this org's branding when the card is attached to the org
  const myCard = await one<{ organization_id: string | null }>("SELECT organization_id FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC, created_at LIMIT 1", [userId], db);
  return {
    id: o.id as string,
    name: o.name as string,
    slug: o.slug as string,
    createdAt: o.created_at,
    role: m.role,
    permissions: permissionsOf(m.role),
    graphOptOut: m.graph_opt_out,
    showBrandingOnCard: myCard?.organization_id === orgId,
    branding: (o.branding ?? {}) as OrgBranding,
    counts,
    // settings below are visible to admins only
    domains: isAdmin ? (o.verified_domains as string[]) : undefined,
    domainJoinMode: isAdmin ? (o.domain_join_mode as string) : undefined,
    policies: isAdmin ? o.policies : undefined,
    retention: isAdmin ? o.retention : undefined,
  };
}

export async function getOrg(ctx: Ctx, orgId: string) {
  await requireOrg(orgId, ctx.userId, "org.read");
  return getOrgInternal(orgId, ctx.userId!, pool());
}

export async function listMyOrgs(userId: string) {
  const rows = await q<{ id: string; name: string; slug: string; role: OrgRole; status: string; branding: OrgBranding }>(
    `SELECT o.id, o.name, o.slug, m.role, m.status, o.branding FROM organization_members m JOIN organizations o ON o.id=m.organization_id
     WHERE m.user_id=$1 AND m.status IN ('active','pending') ORDER BY o.name`,
    [userId],
  );
  const u = await one<{ active_org_id: string | null }>("SELECT active_org_id FROM users WHERE id=$1", [userId]);
  const active = rows.find((r) => r.id === u?.active_org_id && r.status === "active") ? u!.active_org_id : null;
  return { activeOrgId: active, orgs: rows, discoverable: await discoverableOrgs(userId) };
}

/** F-129 workspace switch: personal (null) or an org the user actively belongs to. */
export async function setActiveOrg(ctx: Ctx, orgId: string | null) {
  if (!ctx.userId) throw unauthorized();
  if (orgId) await requireOrg(orgId, ctx.userId, "org.read");
  await q("UPDATE users SET active_org_id=$2 WHERE id=$1", [ctx.userId, orgId]);
  return { activeOrgId: orgId };
}

export async function activeOrgId(userId: string, db: Db = pool()): Promise<string | null> {
  const r = await one<{ id: string }>(
    `SELECT u.active_org_id AS id FROM users u JOIN organization_members m ON m.organization_id=u.active_org_id AND m.user_id=u.id AND m.status='active' WHERE u.id=$1`,
    [userId],
    db,
  );
  return r?.id ?? null;
}

export const orgUpdateInput = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  branding: z
    .object({ logoUrl: z.string().max(60_000).nullish(), primaryColor: z.string().max(7).nullish(), showOnMemberCards: z.boolean().optional(), displayName: z.string().max(80).nullish() })
    .optional(),
  domainJoinMode: z.enum(DOMAIN_JOIN_MODES).optional(),
});

export async function updateOrg(ctx: Ctx, orgId: string, input: z.infer<typeof orgUpdateInput>) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "org.update", c);
    if (input.branding) {
      const errs = validateBranding(input.branding);
      if (errs.length) throw badRequest("invalid_branding", errs.join("; "));
    }
    await c.query(
      `UPDATE organizations SET name=COALESCE($2,name), branding=COALESCE($3::jsonb, branding), domain_join_mode=COALESCE($4, domain_join_mode), updated_at=now() WHERE id=$1`,
      [orgId, input.name ?? null, input.branding ? JSON.stringify(input.branding) : null, input.domainJoinMode ?? null],
    );
    await audit(c, ctx, "org.updated", "organization", orgId, { fields: Object.keys(input) }, orgId);
    return getOrgInternal(orgId, ctx.userId!, c);
  });
}

export async function deleteOrg(ctx: Ctx, orgId: string) {
  await tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "org.delete", c);
    // company-owned leads stay with their current 담당자 as personal contacts (ON DELETE SET NULL on organization_id)
    await c.query("UPDATE contacts SET scope='personal', ownership='personal' WHERE organization_id=$1", [orgId]);
    await audit(c, ctx, "org.deleted", "organization", orgId, {}, orgId);
    await c.query("DELETE FROM organizations WHERE id=$1", [orgId]);
  });
  return { deleted: true };
}

// ---------- F-004: domains ----------
export async function addDomain(ctx: Ctx, orgId: string, domain: string) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "org.update", c);
    const me = await one<{ email: string | null }>("SELECT email FROM users WHERE id=$1", [ctx.userId], c);
    const d = verifyDomainClaim(me?.email, domain);
    if (!d) throw new ApiError(422, "domain_not_verified", "본인 로그인 이메일(인증됨)과 같은 회사 도메인만 등록할 수 있습니다. 공용 메일 도메인은 불가합니다.");
    const taken = await one("SELECT 1 FROM organizations WHERE $1 = ANY(verified_domains) AND id <> $2", [d, orgId], c);
    if (taken) throw conflict("domain_taken", "이미 다른 조직이 사용 중인 도메인입니다.");
    await c.query("UPDATE organizations SET verified_domains = array(SELECT DISTINCT unnest(verified_domains || ARRAY[$2::text])), updated_at=now() WHERE id=$1", [orgId, d]);
    await audit(c, ctx, "org.domain_added", "organization", orgId, { domain: d, proof: "admin_verified_email" }, orgId);
    return { domain: d, verified: true };
  });
}

export async function removeDomain(ctx: Ctx, orgId: string, domain: string) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "org.update", c);
    await c.query("UPDATE organizations SET verified_domains = array_remove(verified_domains, $2), updated_at=now() WHERE id=$1", [orgId, domain.toLowerCase()]);
    await audit(c, ctx, "org.domain_removed", "organization", orgId, { domain }, orgId);
    return { removed: true };
  });
}

async function discoverableOrgs(userId: string) {
  const u = await one<{ email: string | null }>("SELECT email FROM users WHERE id=$1", [userId]);
  const d = u?.email?.split("@")[1]?.toLowerCase();
  if (!d) return [];
  const rows = await q<{ id: string; name: string; domain_join_mode: "off" | "auto" | "approval"; verified_domains: string[] }>(
    `SELECT o.id, o.name, o.domain_join_mode, o.verified_domains FROM organizations o
     WHERE $1 = ANY(o.verified_domains) AND o.domain_join_mode <> 'off'
       AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id=o.id AND m.user_id=$2 AND m.status IN ('active','pending'))`,
    [d, userId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, mode: domainJoinDecision(u!.email, r.verified_domains, r.domain_join_mode) }));
}

/** F-004 verified-domain join: auto → active member; approval → pending until a manager+ approves. */
export async function joinByDomain(ctx: Ctx, orgId: string) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  return tx(async (c) => {
    const o = await one<{ verified_domains: string[]; domain_join_mode: "off" | "auto" | "approval" }>("SELECT verified_domains, domain_join_mode FROM organizations WHERE id=$1", [orgId], c);
    const u = await one<{ email: string | null }>("SELECT email FROM users WHERE id=$1", [userId], c);
    const decision = o ? domainJoinDecision(u?.email, o.verified_domains, o.domain_join_mode) : "none";
    if (decision === "none") throw notFound("organization");
    const cur = await one<{ status: string }>("SELECT status FROM organization_members WHERE organization_id=$1 AND user_id=$2", [orgId, userId], c);
    if (cur?.status === "active") return { status: "active" };
    await addMember(c, orgId, userId, "member", { source: "domain", status: decision === "join" ? "active" : "pending" });
    await audit(c, ctx, decision === "join" ? "org.member_joined" : "org.join_requested", "organization", orgId, { via: "domain" }, orgId);
    return { status: decision === "join" ? "active" : "pending" };
  });
}

export async function approveMember(ctx: Ctx, orgId: string, targetUserId: string, approve: boolean) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "members.approve", c);
    const r = await c.query(
      approve
        ? "UPDATE organization_members SET status='active', joined_at=now() WHERE organization_id=$1 AND user_id=$2 AND status='pending'"
        : "UPDATE organization_members SET status='rejected', left_at=now() WHERE organization_id=$1 AND user_id=$2 AND status='pending'",
      [orgId, targetUserId],
    );
    if (!r.rowCount) throw notFound("pending member");
    if (approve) await addMember(c, orgId, targetUserId, "member", { source: "domain_approved", invitedBy: ctx.userId });
    await audit(c, ctx, approve ? "org.member_approved" : "org.member_rejected", "user", targetUserId, {}, orgId);
    return { status: approve ? "active" : "rejected" };
  });
}

// ---------- F-004: invites ----------
export const inviteInput = z.object({
  email: z.string().trim().max(200).nullish(),
  role: z.enum(ORG_ROLES).default("member"),
  maxUses: z.number().int().min(1).max(500).default(1),
  ttlDays: z.number().int().min(1).max(30).default(7),
});

export async function createInvite(ctx: Ctx, orgId: string, input: z.infer<typeof inviteInput>) {
  return tx(async (c) => {
    const me = await requireOrg(orgId, ctx.userId, "members.invite", c);
    if (!canInviteAs(me.role, input.role)) throw forbidden(`${me.role} 는 ${input.role} 역할로 초대할 수 없습니다.`);
    const email = input.email ? normalizeEmail(input.email) : null;
    if (input.email && !email) throw badRequest("invalid_email");
    const token = generateToken();
    const expires = new Date(Date.now() + input.ttlDays * 864e5);
    const r = await one<{ id: string }>(
      "INSERT INTO org_invites (organization_id, token_hash, email, role, created_by, max_uses, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [orgId, await hashToken(token), email, input.role, ctx.userId, email ? 1 : input.maxUses, expires],
      c,
    );
    await audit(c, ctx, "org.invite_created", "org_invite", r!.id, { role: input.role, emailBound: Boolean(email) }, orgId);
    return { id: r!.id, token, url: `${appOrigin()}/join/${token}`, role: input.role, email, expiresAt: expires.toISOString() };
  });
}

export async function listInvites(ctx: Ctx, orgId: string) {
  await requireOrg(orgId, ctx.userId, "members.invite");
  return q<any>(
    `SELECT id, email, role, max_uses, use_count, expires_at, revoked_at, created_at,
       CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at < now() THEN 'expired' WHEN use_count >= max_uses THEN 'used' ELSE 'active' END AS status
     FROM org_invites WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [orgId],
  );
}

export async function revokeInvite(ctx: Ctx, orgId: string, inviteId: string) {
  await requireOrg(orgId, ctx.userId, "members.invite");
  const r = await one("UPDATE org_invites SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL RETURNING id", [inviteId, orgId]);
  if (!r) throw notFound("invite");
  await audit(pool(), ctx, "org.invite_revoked", "org_invite", inviteId, {}, orgId);
  return { revoked: true };
}

async function findInvite(token: string, db: Db, lock = false) {
  if (!isWellFormedToken(token)) throw notFound("invite");
  const inv = await one<any>(
    `SELECT i.*, o.name AS org_name, o.branding FROM org_invites i JOIN organizations o ON o.id=i.organization_id WHERE i.token_hash=$1${lock ? " FOR UPDATE OF i" : ""}`,
    [await hashToken(token)],
    db,
  );
  if (!inv) throw notFound("invite");
  return inv;
}

/** Public preview for /join/{token}: org name + role only (no member data). */
export async function previewInvite(token: string) {
  const inv = await findInvite(token, pool());
  const usable = !inv.revoked_at && inv.expires_at > new Date() && inv.use_count < inv.max_uses;
  return { orgName: inv.org_name as string, role: inv.role as OrgRole, emailBound: Boolean(inv.email), usable, branding: inv.branding as OrgBranding };
}

export async function acceptInvite(ctx: Ctx, token: string) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await rateLimit(`org:join:${userId}`, 20, 600);
  return tx(async (c) => {
    const inv = await findInvite(token, c, true);
    if (inv.revoked_at) throw gone("invite_revoked", "취소된 초대입니다.");
    if (inv.expires_at < new Date()) throw gone("invite_expired", "만료된 초대입니다.");
    const cur = await one<{ status: string; role: OrgRole }>("SELECT status, role FROM organization_members WHERE organization_id=$1 AND user_id=$2", [inv.organization_id, userId], c);
    if (cur?.status === "active") return { orgId: inv.organization_id as string, role: cur.role, alreadyMember: true };
    if (inv.use_count >= inv.max_uses) throw gone("invite_used", "이미 사용된 초대입니다.");
    if (inv.email) {
      const me = await one<{ email: string | null }>("SELECT email FROM users WHERE id=$1", [userId], c);
      if (normalizeEmail(me?.email ?? "") !== inv.email) throw forbidden("이 초대는 다른 이메일 주소로 발송되었습니다.");
    }
    await addMember(c, inv.organization_id, userId, inv.role, { source: "invite", invitedBy: inv.created_by });
    await c.query("UPDATE org_invites SET use_count = use_count + 1 WHERE id=$1", [inv.id]);
    await c.query("UPDATE users SET active_org_id = COALESCE(active_org_id, $2) WHERE id=$1", [userId, inv.organization_id]);
    if (inv.created_by) {
      await recordReferral(c, { referrerId: inv.created_by, referredId: userId, source: "org_invite", touchpointAt: inv.created_at, organizationId: inv.organization_id });
    }
    await audit(c, ctx, "org.member_joined", "organization", inv.organization_id, { via: "invite", role: inv.role }, inv.organization_id);
    return { orgId: inv.organization_id as string, role: inv.role as OrgRole, alreadyMember: false };
  });
}

// ---------- F-130 members & roles ----------
export async function listMembers(ctx: Ctx, orgId: string) {
  const me = await requireOrg(orgId, ctx.userId, "members.read");
  const rows = await q<any>(
    `SELECT m.user_id, m.role, m.status, m.joined_at, m.join_source, m.graph_opt_out, u.display_name, u.email,
       (SELECT count(*)::int FROM contacts c WHERE c.organization_id=m.organization_id AND c.owner_user_id=m.user_id AND c.ownership='company' AND c.deleted_at IS NULL) AS leads
     FROM organization_members m JOIN users u ON u.id=m.user_id
     WHERE m.organization_id=$1 AND m.status IN ('active','pending') ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'member' THEN 3 ELSE 4 END, u.display_name`,
    [orgId],
  );
  const showEmail = can(me.role, "contacts.read_pii");
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.display_name ?? r.email?.split("@")[0] ?? "member",
    email: showEmail ? r.email : null,
    role: r.role as OrgRole,
    status: r.status,
    joinedAt: r.joined_at,
    joinSource: r.join_source,
    leads: r.leads,
    graphOptOut: r.graph_opt_out,
  }));
}

export async function changeRole(ctx: Ctx, orgId: string, targetUserId: string, role: OrgRole) {
  return tx(async (c) => {
    const me = await requireOrg(orgId, ctx.userId, "members.role", c);
    const t = await one<{ role: OrgRole }>("SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND status='active' FOR UPDATE", [orgId, targetUserId], c);
    if (!t) throw notFound("member");
    if (!canAssignRole(me.role, t.role, role)) throw forbidden(`${me.role} 는 ${t.role} → ${role} 변경 권한이 없습니다.`);
    const owners = await one<{ n: number }>("SELECT count(*)::int AS n FROM organization_members WHERE organization_id=$1 AND role='owner' AND status='active'", [orgId], c);
    if (wouldOrphanOrg(owners!.n, t.role, role)) throw conflict("last_owner", "조직에는 최소 1명의 Owner가 필요합니다.");
    await c.query("UPDATE organization_members SET role=$3 WHERE organization_id=$1 AND user_id=$2", [orgId, targetUserId, role]);
    await audit(c, ctx, "org.role_changed", "user", targetUserId, { from: t.role, to: role }, orgId);
    return { userId: targetUserId, role };
  });
}

export const memberPrefsInput = z.object({ graphOptOut: z.boolean().optional(), showBrandingOnCard: z.boolean().optional() });

/** A member's own preferences: exclude my personal network from Who-Knows-Whom, attach/detach my card from org branding. */
export async function updateMyMembership(ctx: Ctx, orgId: string, input: z.infer<typeof memberPrefsInput>) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "org.read", c);
    if (input.graphOptOut !== undefined) await c.query("UPDATE organization_members SET graph_opt_out=$3 WHERE organization_id=$1 AND user_id=$2", [orgId, ctx.userId, input.graphOptOut]);
    if (input.showBrandingOnCard !== undefined) {
      await c.query(
        `UPDATE profiles SET organization_id=$3 WHERE id=(SELECT id FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC, created_at LIMIT 1) AND (organization_id IS NULL OR organization_id=$2)`,
        [ctx.userId, orgId, input.showBrandingOnCard ? orgId : null],
      );
    }
    await audit(c, ctx, "org.member_prefs", "organization", orgId, input, orgId);
    return { ok: true };
  });
}

/**
 * F-132 / F-077: what happens to data when a member leaves (removed, left, SCIM-deprovisioned, account deleted).
 * - company-owned leads they were 담당자 of → reassigned (to `reassignTo` or the longest-standing owner), with timeline
 * - their personal contacts shared into the org → unshared (personal network leaves with the person)
 * - their private notes are never transferred (private forever)
 */
export async function handleMemberDeparture(c: pg.PoolClient, orgId: string, leavingUserId: string, reassignTo: string | null, actor: Pick<Ctx, "userId">, reason: string) {
  let target = reassignTo;
  if (target) {
    const ok = await one<{ role: OrgRole }>("SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND status='active'", [orgId, target], c);
    if (!ok || !can(ok.role, "contacts.write") || target === leavingUserId) throw badRequest("invalid_reassign_target", "리드를 넘겨받을 활성 멤버(member 이상)를 선택하세요.");
  } else {
    const fallback = await one<{ user_id: string }>(
      "SELECT user_id FROM organization_members WHERE organization_id=$1 AND status='active' AND user_id<>$2 ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, joined_at LIMIT 1",
      [orgId, leavingUserId],
      c,
    );
    target = fallback?.user_id ?? null;
  }
  const leads = await q<{ id: string }>(
    "SELECT id FROM contacts WHERE organization_id=$1 AND owner_user_id=$2 AND ownership='company' AND deleted_at IS NULL FOR UPDATE",
    [orgId, leavingUserId],
    c,
  );
  if (leads.length && target) {
    for (const l of leads) await transferContact(c, l.id, leavingUserId, target);
  }
  const unshared = await c.query(
    "UPDATE contacts SET scope='personal', organization_id=NULL, shared_by=NULL, shared_at=NULL WHERE organization_id=$1 AND owner_user_id=$2 AND ownership='personal'",
    [orgId, leavingUserId],
  );
  await c.query("UPDATE organization_members SET status='removed', left_at=now() WHERE organization_id=$1 AND user_id=$2", [orgId, leavingUserId]);
  await c.query("UPDATE users SET active_org_id=NULL WHERE id=$1 AND active_org_id=$2", [leavingUserId, orgId]);
  await c.query("UPDATE profiles SET organization_id=NULL WHERE user_id=$1 AND organization_id=$2", [leavingUserId, orgId]);
  await audit(c, actor, "org.member_departed", "user", leavingUserId, { reason, leadsReassigned: target ? leads.length : 0, reassignedTo: target, personalUnshared: unshared.rowCount ?? 0 }, orgId);
  return { leadsReassigned: target ? leads.length : 0, reassignedTo: target, personalUnshared: unshared.rowCount ?? 0 };
}

/** Move a company lead (and its relationship/encounter timeline) to a new 담당자. Private notes stay with their author. */
async function transferContact(c: pg.PoolClient, contactId: string, from: string, to: string) {
  await c.query("UPDATE contacts SET owner_user_id=$3, version=version+1, updated_at=now() WHERE id=$1 AND owner_user_id=$2", [contactId, from, to]);
  await c.query("UPDATE relationships SET owner_user_id=$3 WHERE contact_id=$1 AND owner_user_id=$2", [contactId, from, to]);
  await c.query("UPDATE encounters SET owner_user_id=$3 WHERE contact_id=$1 AND owner_user_id=$2", [contactId, from, to]);
  await c.query("DELETE FROM contact_tags WHERE contact_id=$1", [contactId]); // tags are per-owner labels
  await emit(c, "contact.updated", "contact", contactId, { contact_id: contactId, changed_fields: ["owner"] });
}

export async function removeMember(ctx: Ctx, orgId: string, targetUserId: string, reassignTo: string | null) {
  return tx(async (c) => {
    const self = targetUserId === ctx.userId;
    const me = await requireOrg(orgId, ctx.userId, self ? "org.read" : "members.remove", c);
    const t = await one<{ role: OrgRole }>("SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND status IN ('active','pending') FOR UPDATE", [orgId, targetUserId], c);
    if (!t) throw notFound("member");
    if (!self && !canAssignRole(me.role, t.role, "viewer")) throw forbidden("이 멤버를 내보낼 권한이 없습니다.");
    const owners = await one<{ n: number }>("SELECT count(*)::int AS n FROM organization_members WHERE organization_id=$1 AND role='owner' AND status='active'", [orgId], c);
    if (wouldOrphanOrg(owners!.n, t.role, null)) throw conflict("last_owner", "마지막 Owner는 나갈 수 없습니다. 먼저 다른 Owner를 지정하세요.");
    return handleMemberDeparture(c, orgId, targetUserId, reassignTo, ctx, self ? "left" : "removed");
  });
}

/** Called before an account is hard-deleted (privacy deletion worker): company leads survive in the org. */
export async function departAllOrgs(c: pg.PoolClient, userId: string) {
  const orgs = await q<{ organization_id: string }>("SELECT organization_id FROM organization_members WHERE user_id=$1 AND status='active'", [userId], c);
  for (const o of orgs) {
    // team notes authored by the deleted user on company data are kept for the org (author link is cleared)
    const newOwner = await one<{ user_id: string }>("SELECT user_id FROM organization_members WHERE organization_id=$1 AND status='active' AND user_id<>$2 ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, joined_at LIMIT 1", [o.organization_id, userId], c);
    if (newOwner) await c.query("UPDATE notes SET owner_user_id=$3, author_user_id=NULL WHERE organization_id=$1 AND owner_user_id=$2 AND scope='team'", [o.organization_id, userId, newOwner.user_id]);
    await handleMemberDeparture(c, o.organization_id, userId, null, { userId: null }, "account_deleted");
  }
}

// ---------- F-131 team address book / F-132 company leads / F-077 담당자 ----------
const TEAM_SELECT = `c.id, c.full_name, co.name AS company, c.job_title, c.department, c.email, c.phone, c.ownership, c.owner_user_id,
  c.shared_by, c.shared_at, c.updated_at, ou.display_name AS owner_name,
  (SELECT rel.strength FROM relationships rel WHERE rel.owner_user_id = c.owner_user_id AND rel.contact_id = c.id) AS strength,
  (SELECT rel.last_contact_at FROM relationships rel WHERE rel.owner_user_id = c.owner_user_id AND rel.contact_id = c.id) AS last_contact_at,
  (SELECT count(*)::int FROM notes n WHERE n.contact_id = c.id AND n.scope='team' AND n.organization_id = c.organization_id) AS team_notes`;

function teamDto(r: any, pii: boolean) {
  return {
    id: r.id as string,
    fullName: r.full_name as string,
    company: r.company as string | null,
    jobTitle: r.job_title as string | null,
    department: r.department as string | null,
    email: pii ? (r.email as string | null) : null,
    phone: pii ? (r.phone as string | null) : null,
    piiHidden: !pii && Boolean(r.email || r.phone),
    ownership: r.ownership as "personal" | "company",
    owner: { userId: r.owner_user_id as string, name: (r.owner_name as string | null) ?? "member" },
    strength: r.strength == null ? null : Number(r.strength),
    lastContactAt: r.last_contact_at,
    teamNotes: r.team_notes as number,
    sharedAt: r.shared_at,
    updatedAt: r.updated_at,
  };
}

export async function listTeamContacts(ctx: Ctx, orgId: string, opts: { query?: string; ownership?: "personal" | "company"; ownerId?: string; limit?: number } = {}) {
  const me = await requireOrg(orgId, ctx.userId, "contacts.read");
  const params: unknown[] = [orgId];
  let where = "c.organization_id=$1 AND c.scope='org' AND c.deleted_at IS NULL AND c.merged_into_id IS NULL";
  if (opts.query) {
    params.push(`%${opts.query.replace(/[%_\\]/g, "\\$&")}%`);
    const i = params.length;
    where += ` AND (c.full_name ILIKE $${i} OR c.job_title ILIKE $${i} OR EXISTS (SELECT 1 FROM companies cq WHERE cq.id=c.company_id AND cq.name ILIKE $${i}))`;
  }
  if (opts.ownership) {
    params.push(opts.ownership);
    where += ` AND c.ownership=$${params.length}`;
  }
  if (opts.ownerId) {
    params.push(opts.ownerId);
    where += ` AND c.owner_user_id=$${params.length}`;
  }
  params.push(Math.max(1, Math.min(opts.limit ?? 100, 500)));
  const rows = await q<any>(
    `SELECT ${TEAM_SELECT} FROM contacts c LEFT JOIN companies co ON co.id=c.company_id LEFT JOIN users ou ON ou.id=c.owner_user_id
     WHERE ${where} ORDER BY c.updated_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => teamDto(r, can(me.role, "contacts.read_pii")));
}

export async function getTeamContact(ctx: Ctx, orgId: string, contactId: string) {
  const me = await requireOrg(orgId, ctx.userId, "contacts.read");
  const r = await one<any>(
    `SELECT ${TEAM_SELECT} FROM contacts c LEFT JOIN companies co ON co.id=c.company_id LEFT JOIN users ou ON ou.id=c.owner_user_id
     WHERE c.id=$2 AND c.organization_id=$1 AND c.scope='org' AND c.deleted_at IS NULL`,
    [orgId, contactId],
  );
  if (!r) throw notFound("contact");
  const notes = await listTeamNotesInternal(orgId, contactId);
  const enc = await one<{ n: number; last: Date | null }>("SELECT count(*)::int AS n, max(occurred_at) AS last FROM encounters WHERE contact_id=$1 AND owner_user_id=$2", [contactId, r.owner_user_id]);
  return { contact: teamDto(r, can(me.role, "contacts.read_pii")), notes, encounters: { count: enc?.n ?? 0, last: enc?.last ?? null } };
}

export const shareInput = z.object({ contactIds: z.array(z.string().uuid()).min(1).max(500), asCompanyLead: z.boolean().default(false) });

/** Share my own contacts into the org (scope=org). `asCompanyLead` transfers ownership to the company (irreversible by the sharer). */
export async function shareContacts(ctx: Ctx, orgId: string, input: z.infer<typeof shareInput>) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "contacts.share", c);
    const rows = await q<{ id: string; organization_id: string | null }>(
      "SELECT id, organization_id FROM contacts WHERE id = ANY($1::uuid[]) AND owner_user_id=$2 AND deleted_at IS NULL FOR UPDATE",
      [input.contactIds, ctx.userId],
      c,
    );
    if (rows.length !== new Set(input.contactIds).size) throw notFound("contact");
    if (rows.some((r) => r.organization_id && r.organization_id !== orgId)) throw conflict("shared_elsewhere", "다른 조직에 공유된 연락처가 포함되어 있습니다.");
    await c.query(
      `UPDATE contacts SET organization_id=$2, scope='org', ownership = CASE WHEN $4 THEN 'company' ELSE ownership END,
         shared_by=COALESCE(shared_by,$3), shared_at=COALESCE(shared_at, now()), updated_at=now() WHERE id = ANY($1::uuid[])`,
      [input.contactIds, orgId, ctx.userId, input.asCompanyLead],
    );
    await audit(c, ctx, "org.contacts_shared", "organization", orgId, { count: rows.length, asCompanyLead: input.asCompanyLead }, orgId);
    return { shared: rows.length };
  });
}

export async function unshareContact(ctx: Ctx, orgId: string, contactId: string) {
  return tx(async (c) => {
    const me = await requireOrg(orgId, ctx.userId, "contacts.read", c);
    const r = await one<{ owner_user_id: string; ownership: string }>("SELECT owner_user_id, ownership FROM contacts WHERE id=$1 AND organization_id=$2 AND scope='org' FOR UPDATE", [contactId, orgId], c);
    if (!r) throw notFound("contact");
    if (r.ownership === "company") throw conflict("company_owned", "회사 소유 리드는 공유 해제할 수 없습니다(담당자 재배정만 가능).");
    if (r.owner_user_id !== ctx.userId && !can(me.role, "members.remove")) throw forbidden();
    await c.query("UPDATE contacts SET scope='personal', organization_id=NULL, shared_by=NULL, shared_at=NULL WHERE id=$1", [contactId]);
    await audit(c, ctx, "org.contact_unshared", "contact", contactId, {}, orgId);
    return { unshared: true };
  });
}

export const leadInput = contactInput.extend({ assigneeUserId: z.string().uuid().nullish() });

/** F-132 회사 소유 리드 생성: the organization owns it; the 담당자 is owner_user_id. */
export async function createLead(ctx: Ctx, orgId: string, input: z.infer<typeof leadInput>) {
  return tx(async (c) => {
    const me = await requireOrg(orgId, ctx.userId, "contacts.write", c);
    let assignee = ctx.userId!;
    if (input.assigneeUserId && input.assigneeUserId !== ctx.userId) {
      if (!can(me.role, "leads.assign")) throw forbidden("다른 담당자 지정은 manager 이상만 가능합니다.");
      const t = await one<{ role: OrgRole }>("SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND status='active'", [orgId, input.assigneeUserId], c);
      if (!t || !can(t.role, "contacts.write")) throw badRequest("invalid_assignee");
      assignee = input.assigneeUserId;
    }
    const { assigneeUserId: _a, ...contact } = input;
    const ids = await insertContact(c, assignee, contact);
    await c.query("UPDATE contacts SET organization_id=$2, scope='org', ownership='company', shared_by=$3, shared_at=now() WHERE id=$1", [ids.contactId, orgId, ctx.userId]);
    await audit(c, ctx, "org.lead_created", "contact", ids.contactId, { assignee }, orgId);
    return { contactId: ids.contactId, assigneeUserId: assignee };
  });
}

/** F-077 담당자 재배정 (company leads only). */
export async function assignLead(ctx: Ctx, orgId: string, contactId: string, toUserId: string) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "leads.assign", c);
    const r = await one<{ owner_user_id: string; ownership: string }>("SELECT owner_user_id, ownership FROM contacts WHERE id=$1 AND organization_id=$2 AND scope='org' AND deleted_at IS NULL FOR UPDATE", [contactId, orgId], c);
    if (!r) throw notFound("contact");
    if (r.ownership !== "company") throw conflict("personal_contact", "개인 연락처는 재배정할 수 없습니다. 회사 리드로 전환된 연락처만 가능합니다.");
    const t = await one<{ role: OrgRole }>("SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND status='active'", [orgId, toUserId], c);
    if (!t || !can(t.role, "contacts.write")) throw badRequest("invalid_assignee", "활성 멤버(member 이상)에게만 배정할 수 있습니다.");
    if (r.owner_user_id !== toUserId) await transferContact(c, contactId, r.owner_user_id, toUserId);
    await audit(c, ctx, "org.lead_assigned", "contact", contactId, { from: r.owner_user_id, to: toUserId }, orgId);
    return { contactId, ownerUserId: toUserId };
  });
}

/** Convert a shared personal contact into a company-owned lead — only the person who owns it may give it to the company. */
export async function convertToCompanyLead(ctx: Ctx, orgId: string, contactId: string) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "contacts.share", c);
    const r = await c.query("UPDATE contacts SET ownership='company', updated_at=now() WHERE id=$1 AND organization_id=$2 AND scope='org' AND owner_user_id=$3 AND ownership='personal'", [contactId, orgId, ctx.userId]);
    if (!r.rowCount) throw notFound("contact");
    await audit(c, ctx, "org.lead_converted", "contact", contactId, {}, orgId);
    return { contactId, ownership: "company" };
  });
}

// ---------- F-076 shared (team) notes ----------
async function listTeamNotesInternal(orgId: string, contactId: string, db: Db = pool()) {
  // scope='team' only — private notes are never selected here
  return q<any>(
    `SELECT n.id, n.body, n.created_at, COALESCE(u.display_name, '탈퇴한 멤버') AS author, n.author_user_id
     FROM notes n LEFT JOIN users u ON u.id = n.author_user_id
     WHERE n.organization_id=$1 AND n.contact_id=$2 AND n.scope='team' ORDER BY n.created_at DESC LIMIT 200`,
    [orgId, contactId],
    db,
  );
}

export async function listTeamNotes(ctx: Ctx, orgId: string, contactId: string) {
  await requireOrg(orgId, ctx.userId, "notes.read");
  const ok = await one("SELECT 1 FROM contacts WHERE id=$1 AND organization_id=$2 AND scope='org'", [contactId, orgId]);
  if (!ok) throw notFound("contact");
  return listTeamNotesInternal(orgId, contactId);
}

export async function addTeamNote(ctx: Ctx, orgId: string, contactId: string, body: string) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "notes.write", c);
    const ok = await one("SELECT 1 FROM contacts WHERE id=$1 AND organization_id=$2 AND scope='org' AND deleted_at IS NULL", [contactId, orgId], c);
    if (!ok) throw notFound("contact");
    const r = await one<{ id: string; created_at: Date }>(
      "INSERT INTO notes (owner_user_id, author_user_id, contact_id, scope, organization_id, body, kind) VALUES ($1,$1,$2,'team',$3,$4,'text') RETURNING id, created_at",
      [ctx.userId, contactId, orgId, body],
      c,
    );
    await audit(c, ctx, "org.team_note_added", "contact", contactId, {}, orgId);
    return { id: r!.id, body, scope: "team", createdAt: r!.created_at };
  });
}

export async function deleteTeamNote(ctx: Ctx, orgId: string, noteId: string) {
  return tx(async (c) => {
    const me = await requireOrg(orgId, ctx.userId, "notes.write", c);
    const n = await one<{ author_user_id: string | null }>("SELECT author_user_id FROM notes WHERE id=$1 AND organization_id=$2 AND scope='team'", [noteId, orgId], c);
    if (!n) throw notFound("note");
    if (n.author_user_id !== ctx.userId && !can(me.role, "members.remove")) throw forbidden("본인 메모만 삭제할 수 있습니다.");
    await c.query("DELETE FROM notes WHERE id=$1", [noteId]);
    await audit(c, ctx, "org.team_note_deleted", "note", noteId, {}, orgId);
    return { deleted: true };
  });
}

// ---------- F-138 branding on member cards ----------
export interface CardBrand {
  orgName: string;
  logoUrl: string | null;
  primaryColor: string | null;
}

export async function brandForProfile(profileId: string, db: Db = pool()): Promise<CardBrand | null> {
  const r = await one<{ name: string; branding: OrgBranding }>(
    `SELECT o.name, o.branding FROM profiles p JOIN organizations o ON o.id = p.organization_id
     JOIN organization_members m ON m.organization_id = o.id AND m.user_id = p.user_id AND m.status='active'
     WHERE p.id=$1`,
    [profileId],
    db,
  );
  if (!r || !r.branding?.showOnMemberCards) return null;
  return { orgName: r.branding.displayName || r.name, logoUrl: r.branding.logoUrl ?? null, primaryColor: r.branding.primaryColor ?? null };
}
