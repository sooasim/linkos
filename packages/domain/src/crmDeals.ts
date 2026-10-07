// F-121 HubSpot Company/Deal sync — pure helpers (no I/O): company domain dedupe key, company/deal property
// mapping on top of the F-127 field-mapping model, deal pipeline/stage mapping, and the deal draft→approve gate.
// F-001/F-060 Sign in with Apple — display-name formatting for Apple's first-login `user` payload.

/** Objects beyond contact/lead that only HubSpot supports in LINKOS today. */
export const HUBSPOT_EXTRA_OBJECTS = ["company", "deal"] as const;
export type HubspotExtraObject = (typeof HUBSPOT_EXTRA_OBJECTS)[number];

export const COMPANY_LOCAL_FIELDS = ["companyName", "domain", "website"] as const;
export type CompanyLocalField = (typeof COMPANY_LOCAL_FIELDS)[number];
export const DEAL_LOCAL_FIELDS = ["dealName", "amount", "closeDate", "description"] as const;
export type DealLocalField = (typeof DEAL_LOCAL_FIELDS)[number];

export interface ObjectMapEntry {
  local: string;
  remote: string;
}

export const HUBSPOT_OBJECT_DEFAULTS: Record<HubspotExtraObject, ObjectMapEntry[]> = {
  company: [
    { local: "companyName", remote: "name" },
    { local: "domain", remote: "domain" },
    { local: "website", remote: "website" },
  ],
  deal: [
    { local: "dealName", remote: "dealname" },
    { local: "amount", remote: "amount" },
    { local: "closeDate", remote: "closedate" },
    { local: "description", remote: "description" },
  ],
};

/** HubSpot rejects a create without these. */
const REQUIRED_REMOTE: Record<HubspotExtraObject, string[]> = { company: ["name"], deal: ["dealname"] };
/** Remote properties LINKOS sets itself; a user mapping must not target them. */
const RESERVED_REMOTE: Record<HubspotExtraObject, string[]> = { company: [], deal: ["pipeline", "dealstage"] };

const REMOTE_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

export function localFieldsFor(object: HubspotExtraObject): readonly string[] {
  return object === "company" ? COMPANY_LOCAL_FIELDS : DEAL_LOCAL_FIELDS;
}

export function validateObjectMapping(object: HubspotExtraObject, entries: ObjectMapEntry[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const locals = localFieldsFor(object);
  const seen = new Set<string>();
  for (const e of entries) {
    if (!locals.includes(e.local)) errors.push(`unknown_local:${e.local}`);
    if (!REMOTE_RE.test(e.remote)) errors.push(`invalid_remote:${e.remote}`);
    else if (RESERVED_REMOTE[object].includes(e.remote.toLowerCase())) errors.push(`reserved_remote:${e.remote}`);
    if (seen.has(e.remote.toLowerCase())) errors.push(`duplicate_remote:${e.remote}`);
    seen.add(e.remote.toLowerCase());
  }
  for (const req of REQUIRED_REMOTE[object]) if (!entries.some((e) => e.remote === req)) errors.push(`missing_required:${req}`);
  return { ok: errors.length === 0, errors };
}

/** Apply a mapping; empty values are omitted so a sync never blanks a field someone filled in HubSpot. */
export function applyObjectMapping(object: HubspotExtraObject, entries: ObjectMapEntry[], local: Record<string, string | number | null | undefined>) {
  const values: Record<string, string> = {};
  for (const e of entries) {
    const v = local[e.local];
    if (v != null && String(v).trim() !== "") values[e.remote] = String(v).slice(0, e.local === "description" ? 5000 : 255);
  }
  const missingRequired = REQUIRED_REMOTE[object].filter((r) => !values[r]);
  return { values, missingRequired };
}

// ---------- company domain (dedupe key) ----------
/** Consumer mailbox domains never identify a company; deduping on them would merge unrelated people. */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "naver.com", "hanmail.net", "daum.net", "kakao.com", "nate.com", "hotmail.com", "outlook.com", "live.com",
  "msn.com", "yahoo.com", "yahoo.co.kr", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com",
  "privaterelay.appleid.com", "qq.com", "163.com",
]);

export function hostDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("@")) s = s.slice(s.lastIndexOf("@") + 1);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#:]/)[0] ?? "";
  s = s.replace(/^www\./, "").replace(/\.$/, "");
  if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s)) return null;
  return s;
}

/** Company domain for dedupe: explicit company domain → contact website → work email domain (never a free-mail domain). */
export function companyDomain(src: { domain?: string | null; website?: string | null; email?: string | null }): string | null {
  for (const cand of [src.domain, src.website, src.email]) {
    const d = hostDomain(cand);
    if (d && !FREE_MAIL_DOMAINS.has(d)) return d;
  }
  return null;
}

// ---------- deals ----------
export const DEAL_STAGES = ["discovery", "qualified", "proposal", "negotiation", "won", "lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
export const DEAL_STAGE_LABELS: Record<DealStage, string> = { discovery: "발굴", qualified: "검증", proposal: "제안", negotiation: "협상", won: "성사", lost: "실패" };

export interface DealPipelineConfig {
  pipeline: string;
  stages: Record<DealStage, string>;
}

/** HubSpot's built-in "Sales Pipeline" (id `default`) stage ids. */
export const DEFAULT_HUBSPOT_PIPELINE: DealPipelineConfig = {
  pipeline: "default",
  stages: { discovery: "appointmentscheduled", qualified: "qualifiedtobuy", proposal: "presentationscheduled", negotiation: "contractsent", won: "closedwon", lost: "closedlost" },
};

const STAGE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export function validatePipelineConfig(cfg: { pipeline?: unknown; stages?: unknown }): { ok: boolean; errors: string[]; config?: DealPipelineConfig } {
  const errors: string[] = [];
  const pipeline = typeof cfg.pipeline === "string" ? cfg.pipeline.trim() : "";
  if (!STAGE_ID_RE.test(pipeline)) errors.push("invalid_pipeline");
  const stagesIn = (cfg.stages && typeof cfg.stages === "object" ? cfg.stages : {}) as Record<string, unknown>;
  const stages = {} as Record<DealStage, string>;
  for (const s of DEAL_STAGES) {
    const v = typeof stagesIn[s] === "string" ? (stagesIn[s] as string).trim() : "";
    if (!STAGE_ID_RE.test(v)) errors.push(`invalid_stage:${s}`);
    stages[s] = v;
  }
  for (const k of Object.keys(stagesIn)) if (!(DEAL_STAGES as readonly string[]).includes(k)) errors.push(`unknown_stage:${k}`);
  return errors.length ? { ok: false, errors } : { ok: true, errors, config: { pipeline, stages } };
}

export interface DealDraftValues {
  name: string;
  amount?: number | string | null;
  closeDate?: string | null; // YYYY-MM-DD
  stage: DealStage;
  description?: string | null;
}

/** HubSpot deal properties: mapped fields + pipeline/dealstage from the pipeline config. closedate is sent as midnight UTC ISO. */
export function buildDealProperties(entries: ObjectMapEntry[], cfg: DealPipelineConfig, d: DealDraftValues) {
  const amount = d.amount == null || d.amount === "" ? null : Number(d.amount);
  const { values, missingRequired } = applyObjectMapping("deal", entries, {
    dealName: d.name,
    amount: amount != null && Number.isFinite(amount) ? String(amount) : null,
    closeDate: d.closeDate && /^\d{4}-\d{2}-\d{2}$/.test(d.closeDate) ? `${d.closeDate}T00:00:00.000Z` : null,
    description: d.description ?? null,
  });
  const properties: Record<string, string> = { ...values, pipeline: cfg.pipeline, dealstage: cfg.stages[d.stage] };
  return { properties, missingRequired };
}

export type DealStatus = "draft" | "approved" | "synced" | "discarded";

/**
 * CLAUDE.md rule 8: a CRM write is never automatic. A deal can be pushed only from an explicit approval of the
 * exact version the user saw; edits after approval require a new approval.
 */
export function canApproveDeal(d: { status: DealStatus; version: number }, seenVersion: number): { ok: true } | { ok: false; reason: "discarded" | "stale_version" | "already_approved" | "already_synced" } {
  if (d.status === "discarded") return { ok: false, reason: "discarded" };
  if (d.version !== seenVersion) return { ok: false, reason: "stale_version" };
  if (d.status === "approved") return { ok: false, reason: "already_approved" };
  if (d.status === "synced") return { ok: false, reason: "already_synced" }; // unchanged since the last push; edit → draft first
  return { ok: true };
}

// ---------- Apple display name ----------
const HANGUL = /[ㄱ-ㆎ가-힣]/;

/** Apple's `user.name` → display name. Korean names read family-name first without a space ("박민지"). */
export function formatAppleName(name: { firstName?: unknown; lastName?: unknown } | null | undefined): string | null {
  if (!name || typeof name !== "object") return null;
  const clean = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 60) : "");
  const first = clean(name.firstName);
  const last = clean(name.lastName);
  if (!first && !last) return null;
  if (HANGUL.test(first + last)) return `${last}${first}`;
  return [first, last].filter(Boolean).join(" ");
}

/** Apple "Hide My Email" relay addresses: deliverable, verified, but never a company domain. */
export function isApplePrivateRelay(email: string | null | undefined): boolean {
  return Boolean(email && /@privaterelay\.appleid\.com$/i.test(email.trim()));
}
