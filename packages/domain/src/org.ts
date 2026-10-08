// F-129 조직/워크스페이스 · F-130 역할 권한(RBAC) · F-004 조직 가입(도메인) · F-139 정책 강제 · F-136 Data Retention · F-140 API 키
// Pure logic only (no I/O). Services call `can()` before every org-scoped read/write.
import type { Visibility } from "./acl";

export const ORG_ROLES = ["owner", "admin", "manager", "member", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, member: 1, manager: 2, admin: 3, owner: 4 };

export const PERMISSIONS = [
  "org.read",
  "org.update", // settings, branding, domains
  "org.delete",
  "policy.manage", // F-139
  "retention.manage", // F-136
  "sso.manage", // F-008
  "apikeys.manage", // F-140
  "audit.read",
  "members.read",
  "members.invite",
  "members.approve",
  "members.role", // change roles
  "members.remove",
  "contacts.read", // team address book
  "contacts.read_pii", // email/phone in the team book
  "contacts.share", // share own contacts into the org
  "contacts.write", // create company leads, edit shared contacts
  "leads.assign", // F-077 / F-132 reassign 담당자
  "notes.read",
  "notes.write", // F-076 team notes
  "graph.read", // F-133/F-134
  "dashboard.read", // F-135
  "export.org", // export of team book
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MIN_ROLE: Record<Permission, OrgRole> = {
  "org.read": "viewer",
  "org.update": "admin",
  "org.delete": "owner",
  "policy.manage": "admin",
  "retention.manage": "admin",
  "sso.manage": "admin",
  "apikeys.manage": "admin",
  "audit.read": "admin",
  "members.read": "viewer",
  "members.invite": "manager",
  "members.approve": "manager",
  "members.role": "admin",
  "members.remove": "admin",
  "contacts.read": "viewer",
  "contacts.read_pii": "member",
  "contacts.share": "member",
  "contacts.write": "member",
  "leads.assign": "manager",
  "notes.read": "viewer",
  "notes.write": "member",
  "graph.read": "member",
  "dashboard.read": "manager",
  "export.org": "manager",
};

export function isOrgRole(v: unknown): v is OrgRole {
  return typeof v === "string" && (ORG_ROLES as readonly string[]).includes(v);
}

export function roleAtLeast(role: OrgRole, min: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function can(role: OrgRole | null | undefined, perm: Permission): boolean {
  if (!role) return false;
  return roleAtLeast(role, MIN_ROLE[perm]);
}

export function permissionsOf(role: OrgRole): Permission[] {
  return PERMISSIONS.filter((p) => can(role, p));
}

/**
 * Role change rules: only an owner can grant/revoke the owner role; admins manage roles strictly below admin
 * (they cannot touch other admins or owners); nobody else changes roles. Managers may invite only up to member.
 */
export function canAssignRole(actor: OrgRole, targetCurrent: OrgRole | null, next: OrgRole): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") {
    if (targetCurrent && roleAtLeast(targetCurrent, "admin")) return false;
    return !roleAtLeast(next, "admin");
  }
  return false;
}

/** Which roles can an actor hand out in an invite. */
export function canInviteAs(actor: OrgRole, role: OrgRole): boolean {
  if (!can(actor, "members.invite")) return false;
  if (actor === "manager") return !roleAtLeast(role, "manager");
  return canAssignRole(actor, null, role);
}

/** The org must always keep at least one owner. */
export function wouldOrphanOrg(ownerCount: number, targetCurrent: OrgRole, next: OrgRole | null): boolean {
  return targetCurrent === "owner" && next !== "owner" && ownerCount <= 1;
}

// ---------- F-004 domain join ----------
export const DOMAIN_JOIN_MODES = ["off", "auto", "approval"] as const;
export type DomainJoinMode = (typeof DOMAIN_JOIN_MODES)[number];

const PUBLIC_MAIL = new Set(["gmail.com", "naver.com", "daum.net", "hanmail.net", "kakao.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "me.com", "nate.com", "proton.me", "protonmail.com"]);

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const d = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

export function normalizeDomain(d: string): string | null {
  const v = d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^@/, "").replace(/\/.*$/, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null;
}

/** Free webmail domains can never be claimed as an organization domain (would let anyone auto-join). */
export function isClaimableDomain(d: string): boolean {
  const n = normalizeDomain(d);
  return Boolean(n && !PUBLIC_MAIL.has(n));
}

/**
 * Domain ownership proof: the admin registering a domain must themselves hold a verified login email on that domain
 * (OTP/SSO proven). Returns the normalized domain or null.
 */
export function verifyDomainClaim(adminEmail: string | null | undefined, domain: string): string | null {
  const n = normalizeDomain(domain);
  if (!n || !isClaimableDomain(n)) return null;
  const own = emailDomain(adminEmail);
  return own === n ? n : null;
}

export function domainJoinDecision(email: string | null | undefined, verifiedDomains: string[], mode: DomainJoinMode): "join" | "request" | "none" {
  const d = emailDomain(email);
  if (!d || mode === "off" || !verifiedDomains.includes(d)) return "none";
  return mode === "auto" ? "join" : "request";
}

// ---------- F-139 정책 강제 ----------
export interface OrgPolicies {
  /** meetings of members must use all-party recording consent */
  requireAllPartyRecordingConsent?: boolean;
  /** roles that may not export contacts (personal export of org-shared/company data and team export) */
  blockExportRoles?: OrgRole[];
  /** contact fields (email/phone/mobile) on members' cards may not be more open than this */
  minFieldVisibility?: Exclude<Visibility, "private" | "partner">;
  /** fields every member Living Card must have */
  requiredCardFields?: string[];
  /** who-knows-whom exposure of personal contacts: company-level aggregate (default) or shared contacts only */
  graphPersonalExposure?: "company_level" | "shared_only";
}

const VIS_RANK: Record<string, number> = { public: 0, business: 1, trusted: 2, partner: 3, private: 4 };

/** Strictest combination across all of a user's active organizations. */
export function mergePolicies(list: OrgPolicies[]): OrgPolicies {
  const out: OrgPolicies = {};
  for (const p of list) {
    if (p.requireAllPartyRecordingConsent) out.requireAllPartyRecordingConsent = true;
    if (p.blockExportRoles?.length) out.blockExportRoles = [...new Set([...(out.blockExportRoles ?? []), ...p.blockExportRoles])];
    if (p.minFieldVisibility && (!out.minFieldVisibility || VIS_RANK[p.minFieldVisibility]! > VIS_RANK[out.minFieldVisibility]!)) out.minFieldVisibility = p.minFieldVisibility;
    if (p.requiredCardFields?.length) out.requiredCardFields = [...new Set([...(out.requiredCardFields ?? []), ...p.requiredCardFields])];
    if (p.graphPersonalExposure === "shared_only") out.graphPersonalExposure = "shared_only";
  }
  return out;
}

export const POLICY_GUARDED_FIELDS = ["email", "phone", "mobile"];

export interface PolicyViolation {
  code: "field_too_public" | "required_field_missing";
  field: string;
  message: string;
}

export function profilePolicyViolations(fields: { type: string; visibility: string; value?: string }[], policy: OrgPolicies): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  if (policy.minFieldVisibility) {
    const min = VIS_RANK[policy.minFieldVisibility]!;
    for (const f of fields) {
      if (POLICY_GUARDED_FIELDS.includes(f.type) && VIS_RANK[f.visibility]! < min) {
        out.push({ code: "field_too_public", field: f.type, message: `조직 정책상 ${f.type} 공개범위는 최소 '${policy.minFieldVisibility}' 이어야 합니다.` });
      }
    }
  }
  for (const req of policy.requiredCardFields ?? []) {
    if (!fields.some((f) => f.type === req && (f.value ?? "x").trim())) {
      out.push({ code: "required_field_missing", field: req, message: `조직 정책상 '${req}' 항목이 필요합니다.` });
    }
  }
  return out;
}

export function exportAllowed(roles: OrgRole[], policy: OrgPolicies): boolean {
  const blocked = policy.blockExportRoles ?? [];
  return !roles.some((r) => blocked.includes(r));
}

// ---------- F-136 Data Retention ----------
export interface RetentionPolicy {
  /** delete org-scoped contacts with no activity (update/encounter) for N days */
  inactiveContactDays?: number | null;
  /** delete team notes older than N days */
  teamNoteDays?: number | null;
  /** delete org audit logs older than N days (min 365: compliance floor) */
  auditLogDays?: number | null;
}

export const RETENTION_LIMITS = { min: 30, max: 3650, auditMin: 365 } as const;

export function validateRetention(p: RetentionPolicy): string[] {
  const errs: string[] = [];
  const chk = (k: keyof RetentionPolicy, min: number) => {
    const v = p[k];
    if (v == null) return;
    if (!Number.isInteger(v) || v < min || v > RETENTION_LIMITS.max) errs.push(`${k} must be an integer between ${min} and ${RETENTION_LIMITS.max}`);
  };
  chk("inactiveContactDays", RETENTION_LIMITS.min);
  chk("teamNoteDays", RETENTION_LIMITS.min);
  chk("auditLogDays", RETENTION_LIMITS.auditMin);
  return errs;
}

export function retentionCutoff(days: number | null | undefined, now: Date = new Date()): Date | null {
  if (!days) return null;
  return new Date(now.getTime() - days * 864e5);
}

// ---------- F-140 API keys ----------
export const API_KEY_SCOPES = ["contacts:read", "leads:read", "leads:write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Format: lk_<8-char prefix>_<secret>. Only sha256(full key) is stored; the prefix identifies it in the UI/logs. */
export function parseApiKey(raw: string | null | undefined): { prefix: string; key: string } | null {
  if (!raw) return null;
  const v = raw.replace(/^Bearer\s+/i, "").trim();
  const m = v.match(/^lk_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{32,64})$/);
  return m ? { prefix: m[1]!, key: v } : null;
}

export function hasApiScope(scopes: string[], needed: ApiKeyScope): boolean {
  if (scopes.includes(needed)) return true;
  // write implies read on the same resource
  return needed.endsWith(":read") && scopes.includes(needed.replace(":read", ":write"));
}

// ---------- F-138 branding ----------
export interface OrgBranding {
  logoUrl?: string | null;
  primaryColor?: string | null;
  showOnMemberCards?: boolean;
  displayName?: string | null;
}

export function validateBranding(b: OrgBranding): string[] {
  const errs: string[] = [];
  if (b.primaryColor && !/^#[0-9a-fA-F]{6}$/.test(b.primaryColor)) errs.push("primaryColor must be #RRGGBB");
  if (b.logoUrl) {
    const ok = /^https:\/\/[^\s"'<>]+$/.test(b.logoUrl) || /^data:image\/(png|svg\+xml|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(b.logoUrl);
    if (!ok) errs.push("logoUrl must be https:// or a small data:image");
    if (b.logoUrl.length > 60_000) errs.push("logoUrl too large");
  }
  return errs;
}

/** Text color (ink or paper) that keeps AA contrast on a brand color. */
export function contrastText(hex: string): "#0E0E10" | "#F4F1EA" {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  return L > 0.4 ? "#0E0E10" : "#F4F1EA";
}

export function slugifyOrg(name: string): string {
  return (
    name
      .normalize("NFC")
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "org"
  );
}
