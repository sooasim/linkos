// F-121 HubSpot — Company/Deal sync (Contact sync + meeting notes live in ./crm).
//
// Company: contact → companies row → HubSpot company, deduped by domain (company domain → contact website → work email,
//   never a free-mail/Apple relay domain), then by exact name; the contact is upserted first and associated (v4 default).
// Deal: created from a LINKOS meeting outcome as a DRAFT only. Nothing reaches HubSpot until the user approves the exact
//   draft version (CLAUDE.md rule 8). Pipeline/stage mapping and deal/company property mapping are stored on the F-127
//   mapping rows (crm_field_mappings, object_type company|deal, options.pipeline).
// All remote writes run as sync_jobs (per-account serial, idempotency keys, F-128 journal); updates are guarded by
// HubSpot's updatedAt — a remote change is reported as a conflict and never overwritten silently.
import {
  DEAL_STAGES,
  DEAL_STAGE_LABELS,
  DEFAULT_HUBSPOT_PIPELINE,
  type DealPipelineConfig,
  type DealStage,
  type DealStatus,
  HUBSPOT_EXTRA_OBJECTS,
  HUBSPOT_OBJECT_DEFAULTS,
  type HubspotExtraObject,
  type ObjectMapEntry,
  applyObjectMapping,
  buildDealProperties,
  canApproveDeal,
  companyDomain,
  localFieldsFor,
  validateObjectMapping,
  validatePipelineConfig,
} from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, conflict, notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit, log } from "../lib/platform";
import { type Account, failed, hubspotBase, providerAccount, providerFetch, upsertRecord } from "./crm";
import { SyncConflict, processSyncJobs } from "./integration";

const REQUIRED_SCOPES = ["crm.objects.companies.write", "crm.objects.deals.write"];

export function hubspotScopesOk(a: Pick<Account, "scopes">): boolean {
  return REQUIRED_SCOPES.every((s) => a.scopes?.includes(s));
}

async function connectedHubspot(userId: string): Promise<Account> {
  const a = await providerAccount(userId, "hubspot");
  if (!a) throw new ApiError(409, "hubspot_not_connected", "HubSpot 계정을 먼저 연결하세요.");
  if (!hubspotScopesOk(a)) throw new ApiError(409, "hubspot_scope_missing", "HubSpot을 다시 연결해 회사·딜 권한을 허용하세요.");
  return a;
}

function assertHubspot(provider: string) {
  if (provider !== "hubspot") throw new ApiError(422, "deals_unsupported", "회사·딜 동기화는 현재 HubSpot만 지원합니다.");
}

const recordUrl = (a: Account, typeId: string, id: string) => (a.metadata.hubId ? `https://app.hubspot.com/contacts/${a.metadata.hubId}/record/${typeId}/${id}` : null);

// ---------- F-127 settings: company/deal property mapping + deal pipeline/stage mapping ----------
async function loadObjectMapping(userId: string, object: HubspotExtraObject, db: Db = pool()) {
  const row = await one<{ mapping: ObjectMapEntry[]; options: { pipeline?: DealPipelineConfig }; updated_at: Date }>(
    "SELECT mapping, options, updated_at FROM crm_field_mappings WHERE owner_user_id=$1 AND provider='hubspot' AND object_type=$2",
    [userId, object],
    db,
  );
  return {
    entries: row?.mapping ?? HUBSPOT_OBJECT_DEFAULTS[object],
    isDefault: !row,
    pipeline: row?.options?.pipeline ?? DEFAULT_HUBSPOT_PIPELINE,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function getHubspotSettings(userId: string) {
  const company = await loadObjectMapping(userId, "company");
  const deal = await loadObjectMapping(userId, "deal");
  return {
    provider: "hubspot" as const,
    company: { entries: company.entries, defaults: HUBSPOT_OBJECT_DEFAULTS.company, isDefault: company.isDefault, localFields: localFieldsFor("company") },
    deal: {
      entries: deal.entries,
      defaults: HUBSPOT_OBJECT_DEFAULTS.deal,
      isDefault: deal.isDefault,
      localFields: localFieldsFor("deal"),
      pipeline: deal.pipeline,
      defaultPipeline: DEFAULT_HUBSPOT_PIPELINE,
    },
    stages: DEAL_STAGES.map((s) => ({ id: s, label: DEAL_STAGE_LABELS[s] })),
  };
}

export const settingsInput = z.object({
  object: z.enum(HUBSPOT_EXTRA_OBJECTS),
  entries: z.array(z.object({ local: z.string().max(40), remote: z.string().trim().min(1).max(80) })).min(1).max(20),
  pipeline: z.object({ pipeline: z.string().max(100), stages: z.record(z.string(), z.string().max(100)) }).optional(),
});

export async function saveHubspotSettings(ctx: Ctx, provider: string, input: z.infer<typeof settingsInput>) {
  if (!ctx.userId) throw unauthorized();
  assertHubspot(provider);
  const v = validateObjectMapping(input.object, input.entries);
  const errors = [...v.errors];
  let pipeline: DealPipelineConfig | undefined;
  if (input.object === "deal" && input.pipeline) {
    const p = validatePipelineConfig(input.pipeline);
    errors.push(...p.errors);
    pipeline = p.config;
  }
  if (input.object === "company" && input.pipeline) errors.push("pipeline_only_for_deal");
  if (errors.length) throw badRequest("invalid_mapping", "필드 매핑을 확인하세요.", errors);
  const userId = ctx.userId;
  await tx(async (c) => {
    const prev = await loadObjectMapping(userId, input.object, c);
    const options = input.object === "deal" ? { pipeline: pipeline ?? prev.pipeline } : {};
    await c.query(
      `INSERT INTO crm_field_mappings (owner_user_id, provider, object_type, mapping, options) VALUES ($1,'hubspot',$2,$3,$4)
       ON CONFLICT (owner_user_id, provider, object_type) DO UPDATE SET mapping=EXCLUDED.mapping, options=EXCLUDED.options, updated_at=now()`,
      [userId, input.object, JSON.stringify(input.entries), JSON.stringify(options)],
    );
    await audit(c, ctx, "integration.mapping.saved", null, null, { provider: "hubspot", object: input.object, fields: input.entries.length, pipeline: Boolean(pipeline) });
  });
  return getHubspotSettings(userId);
}

// ---------- companies ----------
interface RemoteObject {
  id: string;
  properties: Record<string, string | null>;
  updatedAt: string;
}

async function searchCompany(a: Account, propertyName: "domain" | "name", value: string, props: string[]): Promise<RemoteObject | null> {
  const res = await providerFetch(a, `${hubspotBase()}/crm/v3/objects/companies/search`, {
    method: "POST",
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName, operator: "EQ", value }] }], properties: props, limit: 2 }),
  });
  if (!res.ok) await failed(res, "hubspot", "HubSpot company search");
  const j = (await res.json()) as { results?: RemoteObject[] };
  return j.results?.[0] ?? null;
}

async function remoteContactId(a: Account, contactId: string): Promise<string> {
  const m = await one<{ external_id: string }>("SELECT external_id FROM external_mappings WHERE integration_account_id=$1 AND entity_type='contact' AND local_id=$2", [a.id, contactId]);
  return m?.external_id ?? (await upsertRecord(a, "contact", contactId, {})).externalId;
}

async function saveMapping(a: Account, entity: string, localId: string, externalId: string, etag: string | null, url: string | null) {
  await q(
    `INSERT INTO external_mappings (integration_account_id, entity_type, local_id, external_id, external_etag, remote_url, last_synced_at) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (integration_account_id, entity_type, local_id) DO UPDATE SET external_id=EXCLUDED.external_id, external_etag=EXCLUDED.external_etag, remote_url=COALESCE(EXCLUDED.remote_url, external_mappings.remote_url), last_synced_at=now()`,
    [a.id, entity, localId, externalId, etag, url],
  );
}

/** Upsert the HubSpot company of a contact's company (dedupe: mapping → domain → exact name). Returns the HubSpot company id. */
async function ensureCompany(a: Account, contactId: string, force = false): Promise<{ companyExternalId: string; companyId: string } | null> {
  const row = await one<{ company_id: string | null; name: string | null; domain: string | null; website: string | null; email: string | null }>(
    `SELECT c.company_id, co.name, co.domain, c.website, c.email FROM contacts c LEFT JOIN companies co ON co.id=c.company_id
     WHERE c.id=$1 AND c.owner_user_id=$2 AND c.deleted_at IS NULL`,
    [contactId, a.user_id],
  );
  if (!row) throw notFound("contact");
  if (!row.company_id || !row.name) return null;
  const domain = companyDomain({ domain: row.domain, website: row.website, email: row.email });
  const { entries } = await loadObjectMapping(a.user_id, "company");
  const { values, missingRequired } = applyObjectMapping("company", entries, { companyName: row.name, domain, website: row.website });
  if (missingRequired.length) throw new ApiError(422, "missing_required_fields", `필수 필드 누락: ${missingRequired.join(", ")}`);
  const base = `${hubspotBase()}/crm/v3/objects/companies`;
  const props = [...new Set([...Object.keys(values), "hs_lastmodifieddate"])];
  const map = await one<{ external_id: string; external_etag: string | null }>("SELECT external_id, external_etag FROM external_mappings WHERE integration_account_id=$1 AND entity_type='company' AND local_id=$2", [a.id, row.company_id]);
  let out: { id: string; updatedAt: string | null };
  if (map) {
    const cur = await providerFetch(a, `${base}/${encodeURIComponent(map.external_id)}?properties=${props.join(",")}`);
    if (cur.status === 404 && !force) throw new SyncConflict("HubSpot 회사가 삭제되었거나 병합되었습니다.", { externalId: map.external_id });
    if (!cur.ok && cur.status !== 404) await failed(cur, "hubspot", "HubSpot company read");
    const remote = cur.ok ? ((await cur.json()) as RemoteObject) : null;
    if (remote && !force && map.external_etag && remote.updatedAt !== map.external_etag) {
      throw new SyncConflict("HubSpot 회사가 마지막 동기화 이후 변경되어 덮어쓰지 않았습니다.", { externalId: map.external_id, etag: remote.updatedAt });
    }
    const changed = !remote || Object.entries(values).some(([k, v]) => (remote.properties[k] ?? "") !== v);
    if (changed) {
      const res = await providerFetch(a, `${base}/${encodeURIComponent(map.external_id)}`, { method: "PATCH", body: JSON.stringify({ properties: values }) });
      if (!res.ok) await failed(res, "hubspot", "HubSpot company update");
      const j = (await res.json()) as RemoteObject;
      out = { id: j.id, updatedAt: j.updatedAt };
    } else out = { id: remote!.id, updatedAt: remote!.updatedAt }; // nothing to write
  } else {
    // dedupe before creating: an existing HubSpot company is linked as-is (its values are not overwritten)
    const existing = (domain ? await searchCompany(a, "domain", domain, props) : null) ?? (await searchCompany(a, "name", row.name, props));
    if (existing) out = { id: existing.id, updatedAt: existing.updatedAt };
    else {
      const res = await providerFetch(a, base, { method: "POST", body: JSON.stringify({ properties: values }) });
      if (!res.ok) await failed(res, "hubspot", "HubSpot company create");
      const j = (await res.json()) as RemoteObject;
      out = { id: j.id, updatedAt: j.updatedAt };
    }
  }
  await saveMapping(a, "company", row.company_id, out.id, out.updatedAt, recordUrl(a, "0-2", out.id));
  return { companyExternalId: out.id, companyId: row.company_id };
}

async function associateDefault(a: Account, from: "contacts" | "deals", fromId: string, to: "companies" | "contacts", toId: string) {
  // v4 "default" association: idempotent PUT (creates HubSpot's primary/unlabeled association)
  const res = await providerFetch(a, `${hubspotBase()}/crm/v4/objects/${from}/${encodeURIComponent(fromId)}/associations/default/${to}/${encodeURIComponent(toId)}`, { method: "PUT" });
  if (!res.ok) await failed(res, "hubspot", "HubSpot association");
}

/** Job: crm.company.upsert {contactId, force?} */
export async function runCompanyJob(a: Account, payload: { contactId: string; force?: boolean }) {
  if (a.provider !== "hubspot") throw badRequest("unsupported_object");
  const company = await ensureCompany(a, payload.contactId, Boolean(payload.force));
  if (!company) throw new ApiError(422, "no_company", "연락처에 회사 정보가 없습니다.");
  const contactExt = await remoteContactId(a, payload.contactId);
  await associateDefault(a, "contacts", contactExt, "companies", company.companyExternalId);
  return { externalId: company.companyExternalId };
}

export const companySyncInput = z.object({ contactIds: z.array(z.string().uuid()).max(500).optional() });

/** POST /integrations/hubspot/companies/sync — queue one idempotent company upsert+association per contact (version-keyed). */
export async function syncCompanies(ctx: Ctx, provider: string, input: z.infer<typeof companySyncInput>) {
  if (!ctx.userId) throw unauthorized();
  assertHubspot(provider);
  const a = await connectedHubspot(ctx.userId);
  const contacts = await q<{ id: string; version: number }>(
    `SELECT id, version FROM contacts WHERE owner_user_id=$1 AND deleted_at IS NULL AND merged_into_id IS NULL AND company_id IS NOT NULL
     ${input.contactIds ? "AND id = ANY($2::uuid[])" : ""} LIMIT 1000`,
    input.contactIds ? [ctx.userId, input.contactIds] : [ctx.userId],
  );
  let queued = 0;
  for (const c of contacts) {
    const r = await q(
      `INSERT INTO sync_jobs (integration_account_id, job_type, payload, idempotency_key, provider) VALUES ($1,'crm.company.upsert',$2,$3,'hubspot')
       ON CONFLICT (integration_account_id, idempotency_key) DO NOTHING RETURNING id`,
      [a.id, JSON.stringify({ contactId: c.id }), `company:${c.id}:v${c.version}`],
    );
    queued += r.length;
  }
  await audit(pool(), ctx, "integration.hubspot.companies_requested", "integration_account", a.id, { queued });
  if (queued) await processSyncJobs(50, a.id).catch((e) => log("warn", "crm.inline_process_failed", { error: (e as Error).message }));
  const counts = await q<{ status: string; n: number }>(
    "SELECT status, count(*)::int AS n FROM sync_jobs WHERE integration_account_id=$1 AND job_type='crm.company.upsert' AND payload->>'contactId' = ANY($2::text[]) GROUP BY 1",
    [a.id, contacts.map((c) => c.id)],
  );
  const companies = await one<{ n: number }>("SELECT count(*)::int AS n FROM external_mappings WHERE integration_account_id=$1 AND entity_type='company'", [a.id]);
  return { queued, total: contacts.length, companies: companies?.n ?? 0, statuses: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
}

// ---------- deals (draft → explicit approval → sync job) ----------
interface DealRow {
  id: string;
  owner_user_id: string;
  provider: string;
  meeting_id: string | null;
  contact_ids: string[];
  name: string;
  amount: string | null;
  currency: string | null;
  close_date: string | null;
  stage: DealStage;
  description: string | null;
  status: DealStatus;
  version: number;
  approved_at: Date | null;
  approved_version: number | null;
  sync_job_id: string | null;
  external_id: string | null;
  remote_url: string | null;
  created_at: Date;
  updated_at: Date;
  job_status?: string | null;
  job_error?: string | null;
}

const DEAL_SELECT = `SELECT d.id, d.owner_user_id, d.provider, d.meeting_id, d.contact_ids, d.name, d.amount::text AS amount, d.currency,
  to_char(d.close_date, 'YYYY-MM-DD') AS close_date, d.stage, d.description, d.status, d.version, d.approved_at, d.approved_version,
  d.sync_job_id, d.external_id, d.remote_url, d.created_at, d.updated_at, j.status AS job_status, j.last_error AS job_error
  FROM crm_deals d LEFT JOIN sync_jobs j ON j.id = d.sync_job_id`;

function dealDto(d: DealRow) {
  return {
    id: d.id,
    provider: d.provider,
    meetingId: d.meeting_id,
    contactIds: d.contact_ids,
    name: d.name,
    amount: d.amount == null ? null : Number(d.amount),
    currency: d.currency,
    closeDate: d.close_date,
    stage: d.stage,
    stageLabel: DEAL_STAGE_LABELS[d.stage],
    description: d.description,
    status: d.status,
    version: d.version,
    approvedAt: d.approved_at,
    approvedVersion: d.approved_version,
    sync: d.sync_job_id ? { jobId: d.sync_job_id, status: d.job_status ?? null, error: d.job_error ?? null } : null,
    external: d.external_id ? { id: d.external_id, url: d.remote_url } : null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}
export type DealDto = ReturnType<typeof dealDto>;

async function ownedDeal(userId: string, id: string, db: Db = pool(), lock = false): Promise<DealRow> {
  const d = lock
    ? await one<DealRow>("SELECT *, amount::text AS amount, to_char(close_date,'YYYY-MM-DD') AS close_date FROM crm_deals WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [id, userId], db)
    : await one<DealRow>(`${DEAL_SELECT} WHERE d.id=$1 AND d.owner_user_id=$2`, [id, userId], db);
  if (!d) throw notFound("deal");
  return d;
}

export async function getDeal(userId: string, id: string) {
  return dealDto(await ownedDeal(userId, id));
}

export const dealListQuery = z.object({ meetingId: z.string().uuid().optional() });
export async function listDeals(userId: string, f: z.infer<typeof dealListQuery>) {
  const rows = await q<DealRow>(
    `${DEAL_SELECT} WHERE d.owner_user_id=$1 AND d.status <> 'discarded' ${f.meetingId ? "AND d.meeting_id=$2" : ""} ORDER BY d.updated_at DESC LIMIT 100`,
    f.meetingId ? [userId, f.meetingId] : [userId],
  );
  return { deals: rows.map(dealDto) };
}

const dealFields = {
  name: z.string().trim().min(1).max(200),
  amount: z.number().nonnegative().max(1e13).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  closeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  stage: z.enum(DEAL_STAGES),
  description: z.string().max(5000).nullable(),
};
export const dealDraftInput = z.object({
  meetingId: z.string().uuid().optional(),
  contactIds: z.array(z.string().uuid()).max(20).optional(),
  name: dealFields.name.optional(),
  amount: dealFields.amount.optional(),
  currency: dealFields.currency.optional(),
  closeDate: dealFields.closeDate.optional(),
  stage: dealFields.stage.default("discovery"),
  description: dealFields.description.optional(),
});
export const dealPatchInput = z.object({
  name: dealFields.name.optional(),
  amount: dealFields.amount.optional(),
  currency: dealFields.currency.optional(),
  closeDate: dealFields.closeDate.optional(),
  stage: dealFields.stage.optional(),
  description: dealFields.description.optional(),
  contactIds: z.array(z.string().uuid()).max(20).optional(),
});

async function assertOwnContacts(userId: string, ids: string[], db: Db) {
  if (!ids.length) return;
  const r = await q<{ id: string }>("SELECT id FROM contacts WHERE owner_user_id=$1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL", [userId, ids], db);
  if (r.length !== new Set(ids).size) throw notFound("contact");
}

/**
 * Create a deal DRAFT from a meeting outcome (or contacts). Defaults come only from the user's own records: the
 * name from company/participant + meeting title, the description from the meeting's recorded decisions. Amount and
 * close date are never guessed — the user fills them in. Nothing is sent to HubSpot here.
 */
export async function createDealDraft(ctx: Ctx, provider: string, input: z.infer<typeof dealDraftInput>) {
  if (!ctx.userId) throw unauthorized();
  assertHubspot(provider);
  await connectedHubspot(ctx.userId);
  const userId = ctx.userId;
  return tx(async (c) => {
    let contactIds = input.contactIds ?? [];
    let name = input.name;
    let description = input.description ?? null;
    if (input.meetingId) {
      const m = await one<{ title: string | null; started_at: Date | null; summary: { decisions?: string[] } | null }>("SELECT title, started_at, summary FROM meetings WHERE id=$1 AND owner_user_id=$2", [input.meetingId, userId], c);
      if (!m) throw notFound("meeting");
      if (!input.contactIds) contactIds = (await q<{ contact_id: string }>("SELECT contact_id FROM meeting_participants WHERE meeting_id=$1", [input.meetingId], c)).map((r) => r.contact_id);
      if (!name) {
        const lead = contactIds.length
          ? await one<{ company: string | null; full_name: string }>("SELECT co.name AS company, c.full_name FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE c.id = ANY($1::uuid[]) AND c.owner_user_id=$2 ORDER BY (co.name IS NULL), c.full_name LIMIT 1", [contactIds, userId], c)
          : null;
        name = [lead?.company ?? lead?.full_name, m.title].filter(Boolean).join(" · ") || "LINKOS 딜";
      }
      if (input.description === undefined) {
        const decisions = (m.summary?.decisions ?? []).filter((d) => typeof d === "string" && d.trim());
        const head = `[LINKOS] ${m.title ?? "미팅"}${m.started_at ? ` (${new Date(m.started_at).toISOString().slice(0, 10)})` : ""}`;
        description = [head, ...decisions.map((d) => `- 결정: ${d}`)].join("\n").slice(0, 5000);
      }
    }
    if (!name) throw badRequest("name_required", "딜 이름을 입력하세요.");
    await assertOwnContacts(userId, contactIds, c);
    const row = await one<{ id: string }>(
      `INSERT INTO crm_deals (owner_user_id, provider, meeting_id, contact_ids, name, amount, currency, close_date, stage, description)
       VALUES ($1,'hubspot',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [userId, input.meetingId ?? null, [...new Set(contactIds)], name.slice(0, 200), input.amount ?? null, input.currency ?? null, input.closeDate ?? null, input.stage, description],
      c,
    );
    await audit(c, ctx, "integration.hubspot.deal_drafted", "crm_deal", row!.id, { meeting: Boolean(input.meetingId), contacts: contactIds.length });
    return dealDto(await ownedDeal(userId, row!.id, c));
  });
}

const IN_FLIGHT = new Set(["queued", "retry"]);

/** Edit a draft (or a synced deal → becomes a draft again; a new approval is needed to push the change). */
export async function updateDeal(ctx: Ctx, id: string, patch: z.infer<typeof dealPatchInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  return tx(async (c) => {
    const d = await ownedDeal(userId, id, c, true);
    if (d.status === "discarded") throw conflict("deal_discarded", "삭제된 딜입니다.");
    if (d.status === "approved" && d.sync_job_id) {
      const j = await one<{ status: string }>("SELECT status FROM sync_jobs WHERE id=$1", [d.sync_job_id], c);
      if (j && IN_FLIGHT.has(j.status)) throw conflict("deal_sync_in_progress", "HubSpot 전송 중에는 수정할 수 없습니다.");
    }
    if (patch.contactIds) await assertOwnContacts(userId, patch.contactIds, c);
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col}=$${vals.length}`);
    };
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.amount !== undefined) set("amount", patch.amount);
    if (patch.currency !== undefined) set("currency", patch.currency);
    if (patch.closeDate !== undefined) set("close_date", patch.closeDate);
    if (patch.stage !== undefined) set("stage", patch.stage);
    if (patch.description !== undefined) set("description", patch.description);
    if (patch.contactIds !== undefined) set("contact_ids", [...new Set(patch.contactIds)]);
    if (!sets.length) return dealDto(await ownedDeal(userId, id, c));
    await c.query(`UPDATE crm_deals SET ${sets.join(", ")}, status='draft', version=version+1, updated_at=now() WHERE id=$1`, vals);
    await audit(c, ctx, "integration.hubspot.deal_edited", "crm_deal", id, { fields: Object.keys(patch) });
    return dealDto(await ownedDeal(userId, id, c));
  });
}

export async function discardDeal(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  return tx(async (c) => {
    const d = await ownedDeal(userId, id, c, true);
    if (d.external_id) throw conflict("deal_already_synced", "이미 HubSpot에 만들어진 딜은 HubSpot에서 정리하세요.");
    await c.query("UPDATE crm_deals SET status='discarded', updated_at=now() WHERE id=$1", [id]);
    await audit(c, ctx, "integration.hubspot.deal_discarded", "crm_deal", id);
    return { ok: true };
  });
}

export const approveInput = z.object({ version: z.number().int().positive() });

/** The only path to HubSpot: the user approves the exact version they reviewed → one idempotent sync job. */
export async function approveDeal(ctx: Ctx, id: string, input: z.infer<typeof approveInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const a = await connectedHubspot(userId);
  await tx(async (c) => {
    const d = await ownedDeal(userId, id, c, true);
    const gate = canApproveDeal(d, input.version);
    if (!gate.ok) {
      const msg = {
        discarded: "삭제된 딜입니다.",
        stale_version: "딜이 변경되었습니다. 최신 내용을 확인한 뒤 다시 승인하세요.",
        already_approved: "이미 승인되었습니다. 결과는 Sync Journal에서 확인하세요.",
        already_synced: "변경 사항이 없어 다시 보낼 내용이 없습니다.",
      }[gate.reason];
      throw conflict(gate.reason === "stale_version" ? "stale_version" : `deal_${gate.reason}`, msg);
    }
    if (!d.name.trim()) throw badRequest("name_required");
    const job = await one<{ id: string }>(
      `INSERT INTO sync_jobs (integration_account_id, job_type, payload, idempotency_key, provider) VALUES ($1,'crm.deal.upsert',$2,$3,'hubspot')
       ON CONFLICT (integration_account_id, idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id`,
      [a.id, JSON.stringify({ dealId: id, version: d.version }), `deal:${id}:v${d.version}`],
      c,
    );
    await c.query("UPDATE crm_deals SET status='approved', approved_by=$2, approved_at=now(), approved_version=version, sync_job_id=$3, updated_at=now() WHERE id=$1", [id, userId, job!.id]);
    await audit(c, ctx, "integration.hubspot.deal_approved", "crm_deal", id, { version: d.version, update: Boolean(d.external_id) });
  });
  await processSyncJobs(20, a.id).catch((e) => log("warn", "crm.inline_process_failed", { error: (e as Error).message }));
  return getDeal(userId, id);
}

/** Job: crm.deal.upsert {dealId, version, force?} — refuses anything but the approved version. */
export async function runDealJob(a: Account, payload: { dealId: string; version: number; force?: boolean }) {
  if (a.provider !== "hubspot") throw badRequest("unsupported_object");
  const d = await one<DealRow>("SELECT *, amount::text AS amount, to_char(close_date,'YYYY-MM-DD') AS close_date FROM crm_deals WHERE id=$1 AND owner_user_id=$2", [payload.dealId, a.user_id]);
  if (!d || d.status === "discarded") throw notFound("deal");
  if (d.status !== "approved" || d.version !== payload.version || d.approved_version !== payload.version) {
    throw new ApiError(422, "deal_not_approved", "승인된 버전이 아니어서 HubSpot에 보내지 않았습니다.");
  }
  const { entries, pipeline } = await loadObjectMapping(a.user_id, "deal");
  const { properties, missingRequired } = buildDealProperties(entries, pipeline, {
    name: d.name,
    amount: d.amount,
    closeDate: d.close_date,
    stage: d.stage,
    description: d.description,
  });
  if (missingRequired.length) throw new ApiError(422, "missing_required_fields", `필수 필드 누락: ${missingRequired.join(", ")}`);
  if (d.currency) properties.deal_currency_code = d.currency;

  // associated records must exist remotely first (idempotent upserts)
  const contactExt: string[] = [];
  for (const cid of d.contact_ids) contactExt.push(await remoteContactId(a, cid));
  // the first participant with a company: reuse its existing HubSpot company as-is (a pending company conflict must not
  // block the deal), otherwise create/dedupe it now
  let companyExt: string | null = null;
  for (const cid of d.contact_ids) {
    const mapped = await one<{ external_id: string }>(
      `SELECT em.external_id FROM contacts c JOIN external_mappings em ON em.integration_account_id=$1 AND em.entity_type='company' AND em.local_id=c.company_id
       WHERE c.id=$2 AND c.owner_user_id=$3`,
      [a.id, cid, a.user_id],
    );
    const co = mapped ? { companyExternalId: mapped.external_id } : await ensureCompany(a, cid);
    if (co) {
      companyExt = co.companyExternalId;
      if (!mapped) await associateDefault(a, "contacts", contactExt[d.contact_ids.indexOf(cid)]!, "companies", co.companyExternalId);
      break;
    }
  }

  const base = `${hubspotBase()}/crm/v3/objects/deals`;
  const map = await one<{ external_id: string; external_etag: string | null }>("SELECT external_id, external_etag FROM external_mappings WHERE integration_account_id=$1 AND entity_type='deal' AND local_id=$2", [a.id, d.id]);
  let out: RemoteObject;
  if (map) {
    if (!payload.force && map.external_etag) {
      const cur = await providerFetch(a, `${base}/${encodeURIComponent(map.external_id)}?properties=hs_lastmodifieddate`);
      if (cur.status === 404) throw new SyncConflict("HubSpot 딜이 삭제되었거나 병합되었습니다.", { externalId: map.external_id });
      if (!cur.ok) await failed(cur, "hubspot", "HubSpot deal read");
      const j = (await cur.json()) as RemoteObject;
      if (j.updatedAt !== map.external_etag) throw new SyncConflict("HubSpot 딜이 마지막 동기화 이후 변경되어 덮어쓰지 않았습니다.", { externalId: map.external_id, etag: j.updatedAt });
    }
    const res = await providerFetch(a, `${base}/${encodeURIComponent(map.external_id)}`, { method: "PATCH", body: JSON.stringify({ properties }) });
    if (!res.ok) await failed(res, "hubspot", "HubSpot deal update");
    out = (await res.json()) as RemoteObject;
    for (const id of contactExt) await associateDefault(a, "deals", out.id, "contacts", id);
    if (companyExt) await associateDefault(a, "deals", out.id, "companies", companyExt);
  } else {
    const associations = [
      ...contactExt.map((id) => ({ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 } ] })), // deal → contact
      ...(companyExt ? [{ to: { id: companyExt }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 }] }] : []), // deal → company (primary)
    ];
    const res = await providerFetch(a, base, { method: "POST", body: JSON.stringify({ properties, associations }) });
    if (!res.ok) await failed(res, "hubspot", "HubSpot deal create");
    out = (await res.json()) as RemoteObject;
  }
  const url = recordUrl(a, "0-3", out.id);
  await saveMapping(a, "deal", d.id, out.id, out.updatedAt, url);
  await q("UPDATE crm_deals SET status='synced', external_id=$2, remote_url=COALESCE($3, remote_url), updated_at=now() WHERE id=$1 AND version=$4", [d.id, out.id, url, payload.version]);
  return { externalId: out.id };
}
