// crm module — F-119 Outlook/Microsoft, F-120 Salesforce, F-121 HubSpot, F-122 Dynamics 365, F-127 필드 매핑, F-128 Sync Journal, F-088 CRM 연결.
// OAuth(서명된 state) → 자격증명은 vault(seal)로 암호화 저장 → 변경은 sync_jobs 로 직렬 처리(계정별 advisory lock, integration.processSyncJobs).
// 원칙: 외부 레코드는 etag/If-Match/If-Unmodified-Since 로만 갱신하고, 충돌 시 조용히 덮어쓰지 않는다(status=conflict → 사용자 결정).
import {
  CRM_OBJECTS,
  CRM_PROVIDERS,
  type ConsentType,
  type CrmObject,
  type CrmProvider,
  DEFAULT_MAPPINGS,
  type FieldMapEntry,
  LOCAL_FIELDS,
  applyMapping,
  generateToken,
  supportsObject,
  validateMapping,
} from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, conflict, notFound, unauthorized, unavailable } from "../lib/errors";
import { type Ctx, appOrigin, audit, hmac, log } from "../lib/platform";
import { recordConsents } from "./identity";
import { SyncConflict, processSyncJobs, seal, unseal } from "./integration";
import { getContactRow } from "./relationship";

export { CRM_PROVIDERS };
export type { CrmProvider };

// ---------- endpoints (overridable for tests: <PROVIDER>_API_BASE points at a local fake) ----------
const ENV = { microsoft: "MICROSOFT", salesforce: "SALESFORCE", hubspot: "HUBSPOT", dynamics: "DYNAMICS" } as const;

function fake(p: CrmProvider): string | undefined {
  return process.env[`${ENV[p]}_API_BASE`]?.replace(/\/$/, "");
}

function clientId(p: CrmProvider): string | undefined {
  return process.env[`${ENV[p]}_CLIENT_ID`] || (p === "dynamics" ? process.env.MICROSOFT_CLIENT_ID : undefined);
}
function clientSecret(p: CrmProvider): string | undefined {
  return process.env[`${ENV[p]}_CLIENT_SECRET`] || (p === "dynamics" ? process.env.MICROSOFT_CLIENT_SECRET : undefined);
}
export function providerConfigured(p: CrmProvider): boolean {
  return Boolean(clientId(p) && clientSecret(p));
}

function msTenant(p: CrmProvider) {
  return (p === "dynamics" ? process.env.DYNAMICS_TENANT : undefined) || process.env.MICROSOFT_TENANT || "common";
}

function sfLogin(): string {
  return fake("salesforce") ? `${fake("salesforce")}/sf` : (process.env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com").replace(/\/$/, "");
}
const SF_VERSION = () => process.env.SALESFORCE_API_VERSION || "v61.0";

function authUrl(p: CrmProvider): string {
  const f = fake(p);
  switch (p) {
    case "microsoft":
    case "dynamics":
      return f ? `${f}/ms/authorize` : `https://login.microsoftonline.com/${msTenant(p)}/oauth2/v2.0/authorize`;
    case "salesforce":
      return `${sfLogin()}/services/oauth2/authorize`;
    case "hubspot":
      return f ? `${f}/hs/oauth/authorize` : "https://app.hubspot.com/oauth/authorize";
  }
}
function tokenUrl(p: CrmProvider): string {
  const f = fake(p);
  switch (p) {
    case "microsoft":
    case "dynamics":
      return f ? `${f}/ms/token` : `https://login.microsoftonline.com/${msTenant(p)}/oauth2/v2.0/token`;
    case "salesforce":
      return `${sfLogin()}/services/oauth2/token`;
    case "hubspot":
      return f ? `${f}/hs/oauth/v1/token` : "https://api.hubapi.com/oauth/v1/token";
  }
}
export function graphBase(): string {
  return fake("microsoft") ? `${fake("microsoft")}/graph/v1.0` : "https://graph.microsoft.com/v1.0";
}
function hubspotBase(): string {
  return fake("hubspot") ? `${fake("hubspot")}/hs` : "https://api.hubapi.com";
}

function scopesFor(p: CrmProvider, meta: AccountMeta): string[] {
  switch (p) {
    case "microsoft":
      return ["openid", "email", "offline_access", "User.Read", "Contacts.ReadWrite", "Calendars.ReadWrite", "Mail.Send"];
    case "salesforce":
      return ["api", "refresh_token"];
    case "hubspot":
      return ["oauth", "crm.objects.contacts.read", "crm.objects.contacts.write"];
    case "dynamics":
      return [`${meta.orgUrl}/user_impersonation`, "offline_access"];
  }
}

export interface AccountMeta {
  instanceUrl?: string;
  orgUrl?: string;
  accountEmail?: string | null;
  remoteUserId?: string | null;
  hubId?: number | null;
}

interface Creds {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

// ---------- OAuth ----------
function signState(obj: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${payload}.${hmac(`crm:${payload}`).slice(0, 32)}`;
}
export function verifyCrmState(state: string): { p: CrmProvider; u: string; t: number; m: AccountMeta } {
  const [payload, sig] = state.split(".");
  if (!payload || !sig || hmac(`crm:${payload}`).slice(0, 32) !== sig) throw badRequest("invalid_state");
  const obj = JSON.parse(Buffer.from(payload, "base64url").toString()) as { p: CrmProvider; u: string; t: number; m: AccountMeta };
  if (Date.now() - obj.t > 10 * 60 * 1000) throw badRequest("state_expired");
  if (!(CRM_PROVIDERS as readonly string[]).includes(obj.p)) throw badRequest("invalid_state");
  return obj;
}

function redirectUri(p: CrmProvider) {
  return `${appOrigin()}/api/v1/integrations/${p}/callback`;
}

/** Dynamics org URLs are tenant specific; accept only Dynamics hosts (or the configured fake in tests). */
export function validateOrgUrl(raw: string | undefined): string {
  if (!raw) throw badRequest("org_url_required", "Dynamics 365 조직 URL을 입력하세요 (예: https://contoso.crm5.dynamics.com).");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest("invalid_org_url");
  }
  const f = fake("dynamics");
  if (f && raw.startsWith(f)) return raw.replace(/\/$/, "");
  if (u.protocol !== "https:" || !/^[a-z0-9-]+\.crm\d*\.dynamics\.com$/i.test(u.hostname)) throw badRequest("invalid_org_url", "Dynamics 365 조직 URL 형식이 아닙니다.");
  return `https://${u.hostname}`;
}

export const connectInput = z.object({ orgUrl: z.string().max(300).optional() });

export function crmAuthUrl(p: CrmProvider, userId: string, input: z.infer<typeof connectInput> = {}): { url: string } {
  if (!providerConfigured(p)) throw unavailable(`${p}_not_configured`, `${p} 연동이 서버에 설정되지 않았습니다(${ENV[p]}_CLIENT_ID).`);
  const meta: AccountMeta = p === "dynamics" ? { orgUrl: validateOrgUrl(input.orgUrl) } : {};
  const state = signState({ p, u: userId, t: Date.now(), n: generateToken(16), m: meta });
  const params = new URLSearchParams({ client_id: clientId(p)!, redirect_uri: redirectUri(p), response_type: "code", state });
  params.set("scope", scopesFor(p, meta).join(" "));
  if (p === "microsoft" || p === "dynamics") {
    params.set("response_mode", "query");
    params.set("prompt", "select_account");
  }
  return { url: `${authUrl(p)}?${params}` };
}

async function tokenRequest(p: CrmProvider, body: Record<string, string>) {
  const res = await fetch(tokenUrl(p), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId(p)!, client_secret: clientSecret(p)!, ...body }),
  });
  return res;
}

/** OAuth callback: code exchange → identity lookup → sealed credentials + consent record. */
export async function completeCrmOAuth(p: CrmProvider, ctx: Ctx, code: string, state: string) {
  if (!ctx.userId) throw unauthorized();
  const st = verifyCrmState(state);
  if (st.p !== p || st.u !== ctx.userId) throw badRequest("invalid_state");
  const res = await tokenRequest(p, { grant_type: "authorization_code", code, redirect_uri: redirectUri(p), ...(p === "microsoft" || p === "dynamics" ? { scope: scopesFor(p, st.m).join(" ") } : {}) });
  if (!res.ok) throw new ApiError(502, `${p}_token_failed`, "외부 서비스 인증에 실패했습니다.");
  const tok = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number | string; scope?: string; instance_url?: string; id?: string };
  const meta: AccountMeta = { ...st.m };
  if (p === "salesforce") {
    if (!tok.instance_url) throw new ApiError(502, "salesforce_instance_missing");
    meta.instanceUrl = tok.instance_url.replace(/\/$/, "");
    meta.remoteUserId = tok.id ?? null;
  }
  if (p === "microsoft") {
    const me = await fetch(`${graphBase()}/me?$select=id,mail,userPrincipalName`, { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (me.ok) {
      const j = (await me.json()) as { id: string; mail?: string; userPrincipalName?: string };
      meta.accountEmail = j.mail ?? j.userPrincipalName ?? null;
      meta.remoteUserId = j.id;
    }
  }
  if (p === "hubspot") {
    const info = await fetch(`${hubspotBase()}/oauth/v1/access-tokens/${encodeURIComponent(tok.access_token)}`);
    if (info.ok) {
      const j = (await info.json()) as { hub_id?: number; user?: string };
      meta.hubId = j.hub_id ?? null;
      meta.accountEmail = j.user ?? null;
    }
  }
  if (p === "dynamics") {
    const who = await fetch(`${meta.orgUrl}/api/data/v9.2/WhoAmI`, { headers: { authorization: `Bearer ${tok.access_token}`, accept: "application/json", "OData-Version": "4.0" } });
    if (!who.ok) throw new ApiError(502, "dynamics_whoami_failed", "Dynamics 365 조직에 접근할 수 없습니다.");
    meta.remoteUserId = ((await who.json()) as { UserId: string }).UserId;
  }
  const expiresIn = Number(tok.expires_in ?? 7200);
  const creds: Creds = { access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: Date.now() + expiresIn * 1000 };
  const scopes = (tok.scope ?? scopesFor(p, meta).join(" ")).split(/[ ,]+/).filter(Boolean);
  const userId = ctx.userId;
  await tx(async (c) => {
    const prev = await one<{ encrypted_credentials: Buffer | null }>("SELECT encrypted_credentials FROM integration_accounts WHERE user_id=$1 AND provider=$2", [userId, p], c);
    if (!creds.refresh_token && prev?.encrypted_credentials) creds.refresh_token = unseal<Creds>(prev.encrypted_credentials).refresh_token;
    await c.query(
      `INSERT INTO integration_accounts (user_id, provider, scopes, encrypted_credentials, status, metadata) VALUES ($1,$2,$3,$4,'active',$5)
       ON CONFLICT (user_id, provider) DO UPDATE SET scopes=EXCLUDED.scopes, encrypted_credentials=EXCLUDED.encrypted_credentials, status='active', metadata=EXCLUDED.metadata, updated_at=now()`,
      [userId, p, scopes, seal(creds), JSON.stringify(meta)],
    );
    await recordConsents(c, userId, [{ type: `integration_${p}` as ConsentType, granted: true }], { scopes: scopes.join(" ") });
    await audit(c, ctx, `integration.${p}.connected`, "integration_account", null, { scopes: scopes.length });
  });
  return { provider: p };
}

// ---------- accounts & authenticated calls ----------
export interface Account {
  id: string;
  user_id: string;
  provider: CrmProvider;
  status: string;
  scopes: string[];
  metadata: AccountMeta;
}

export async function providerAccount(userId: string, p: CrmProvider, db: Db = pool()): Promise<Account | null> {
  const a = await one<Account>("SELECT id, user_id, provider, status, scopes, metadata FROM integration_accounts WHERE user_id=$1 AND provider=$2", [userId, p], db);
  return a && a.status === "active" ? a : null;
}

async function accountById(id: string): Promise<Account> {
  const a = await one<Account>("SELECT id, user_id, provider, status, scopes, metadata FROM integration_accounts WHERE id=$1", [id]);
  if (!a) throw notFound("integration");
  return a;
}

async function accessToken(a: Account, forceRefresh = false): Promise<string> {
  const row = await one<{ encrypted_credentials: Buffer | null; status: string }>("SELECT encrypted_credentials, status FROM integration_accounts WHERE id=$1", [a.id]);
  if (!row?.encrypted_credentials || row.status !== "active") throw new ApiError(401, `${a.provider}_reauth_required`, "다시 연결이 필요합니다.");
  const creds = unseal<Creds>(row.encrypted_credentials);
  if (!forceRefresh && creds.expires_at - 60_000 > Date.now()) return creds.access_token;
  if (!creds.refresh_token) throw new ApiError(401, `${a.provider}_reauth_required`);
  const res = await tokenRequest(a.provider, {
    grant_type: "refresh_token",
    refresh_token: creds.refresh_token,
    ...(a.provider === "microsoft" || a.provider === "dynamics" ? { scope: scopesFor(a.provider, a.metadata).join(" ") } : {}),
  });
  if (!res.ok) {
    await q("UPDATE integration_accounts SET status='reauth_required', updated_at=now() WHERE id=$1", [a.id]);
    throw new ApiError(401, `${a.provider}_reauth_required`, "외부 계정 인증이 만료되어 다시 연결이 필요합니다.");
  }
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number | string; instance_url?: string };
  const next: Creds = { access_token: t.access_token, refresh_token: t.refresh_token ?? creds.refresh_token, expires_at: Date.now() + Number(t.expires_in ?? 7200) * 1000 };
  await q("UPDATE integration_accounts SET encrypted_credentials=$2, updated_at=now() WHERE id=$1", [a.id, seal(next)]);
  return next.access_token;
}

/** Authenticated fetch; on 401 refreshes the token once and retries (Salesforce tokens carry no expiry). */
export async function providerFetch(a: Account, url: string, init: RequestInit = {}): Promise<Response> {
  const go = (token: string) => fetch(url, { ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
  let res = await go(await accessToken(a));
  if (res.status === 401) res = await go(await accessToken(a, true));
  return res;
}

async function failed(res: Response, p: CrmProvider, what: string): Promise<never> {
  const text = (await res.text().catch(() => "")).slice(0, 200);
  throw new ApiError(res.status, `${p}_${res.status}`, `${what} ${res.status}${text ? `: ${text}` : ""}`);
}

function apiBase(a: Account): string {
  switch (a.provider) {
    case "microsoft":
      return graphBase();
    case "salesforce":
      return `${a.metadata.instanceUrl}/services/data/${SF_VERSION()}`;
    case "hubspot":
      return hubspotBase();
    case "dynamics":
      return `${a.metadata.orgUrl}/api/data/v9.2`;
  }
}

// ---------- F-127 field mappings ----------
export const mappingInput = z.object({
  object: z.enum(CRM_OBJECTS).default("contact"),
  entries: z.array(z.object({ local: z.enum(LOCAL_FIELDS), remote: z.string().trim().min(1).max(80) })).min(1).max(40),
  externalIdField: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/).nullish(),
});

export async function getFieldMapping(userId: string, p: CrmProvider, object: CrmObject) {
  const row = await one<{ mapping: FieldMapEntry[]; external_id_field: string | null; updated_at: Date }>("SELECT mapping, external_id_field, updated_at FROM crm_field_mappings WHERE owner_user_id=$1 AND provider=$2 AND object_type=$3", [userId, p, object]);
  return {
    provider: p,
    object,
    supported: supportsObject(p, object),
    isDefault: !row,
    entries: row?.mapping ?? DEFAULT_MAPPINGS[p][object] ?? [],
    defaults: DEFAULT_MAPPINGS[p][object] ?? [],
    externalIdField: row?.external_id_field ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function saveFieldMapping(ctx: Ctx, p: CrmProvider, input: z.infer<typeof mappingInput>) {
  if (!ctx.userId) throw unauthorized();
  const v = validateMapping(p, input.object, input.entries);
  if (!v.ok) throw badRequest("invalid_mapping", "필드 매핑을 확인하세요.", v.errors);
  if (input.externalIdField && p !== "salesforce" && p !== "dynamics") throw badRequest("external_id_unsupported", "외부 ID 필드 upsert는 Salesforce/Dynamics에서만 지원합니다.");
  await q(
    `INSERT INTO crm_field_mappings (owner_user_id, provider, object_type, mapping, external_id_field) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (owner_user_id, provider, object_type) DO UPDATE SET mapping=EXCLUDED.mapping, external_id_field=EXCLUDED.external_id_field, updated_at=now()`,
    [ctx.userId, p, input.object, JSON.stringify(input.entries), input.externalIdField ?? null],
  );
  await audit(pool(), ctx, "integration.mapping.saved", null, null, { provider: p, object: input.object, fields: input.entries.length });
  return getFieldMapping(ctx.userId, p, input.object);
}

// ---------- push contacts / leads (F-119~F-122) ----------
export const pushInput = z.object({ object: z.enum(CRM_OBJECTS).default("contact"), contactIds: z.array(z.string().uuid()).max(500).optional() });

export async function enqueueCrmPush(ctx: Ctx, p: CrmProvider, input: z.infer<typeof pushInput>) {
  if (!ctx.userId) throw unauthorized();
  const a = await providerAccount(ctx.userId, p);
  if (!a) throw new ApiError(409, `${p}_not_connected`, "계정을 먼저 연결하세요.");
  if (!supportsObject(p, input.object)) throw badRequest("unsupported_object", `${p}는 ${input.object} 동기화를 지원하지 않습니다.`);
  const contacts = await q<{ id: string; version: number }>(
    `SELECT id, version FROM contacts WHERE owner_user_id=$1 AND deleted_at IS NULL AND merged_into_id IS NULL ${input.contactIds ? "AND id = ANY($2::uuid[])" : ""} LIMIT 1000`,
    input.contactIds ? [ctx.userId, input.contactIds] : [ctx.userId],
  );
  let queued = 0;
  for (const c of contacts) {
    const r = await q(
      `INSERT INTO sync_jobs (integration_account_id, job_type, payload, idempotency_key, provider) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (integration_account_id, idempotency_key) DO NOTHING RETURNING id`,
      [a.id, `crm.${input.object}.upsert`, JSON.stringify({ contactId: c.id }), `${input.object}:${c.id}:v${c.version}`, p],
    );
    queued += r.length;
  }
  await audit(pool(), ctx, `integration.${p}.push_requested`, "integration_account", a.id, { queued, object: input.object });
  return { queued, total: contacts.length };
}

interface Upserted {
  externalId: string;
  etag: string | null;
  url?: string | null;
}

async function loadMapping(userId: string, p: CrmProvider, object: CrmObject) {
  const m = await getFieldMapping(userId, p, object);
  return { entries: m.entries, externalIdField: m.externalIdField };
}

function httpDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toUTCString();
}

async function upsertRecord(a: Account, object: CrmObject, contactId: string, payload: { force?: boolean; linkExternalId?: string }): Promise<Upserted> {
  const contact = await getContactRow(a.user_id, contactId); // ownership: the contact must belong to the account owner
  const { entries, externalIdField } = await loadMapping(a.user_id, a.provider, object);
  const { values, missingRequired } = applyMapping(a.provider, object, entries, contact);
  if (missingRequired.length) throw new ApiError(422, "missing_required_fields", `필수 필드 누락: ${missingRequired.join(", ")}`);
  const entity = object;
  let map = await one<{ external_id: string; external_etag: string | null }>("SELECT external_id, external_etag FROM external_mappings WHERE integration_account_id=$1 AND entity_type=$2 AND local_id=$3", [a.id, entity, contactId]);
  if (!map && payload.force && payload.linkExternalId) map = { external_id: payload.linkExternalId, external_etag: null }; // user chose to link to the existing remote record
  const base = apiBase(a);
  let out: Upserted;

  switch (a.provider) {
    case "microsoft": {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) {
        if (k === "emailAddresses") body.emailAddresses = [{ address: v, name: contact.fullName }];
        else if (k === "businessPhones" || k === "homePhones") body[k] = [v];
        else body[k] = v;
      }
      let res: Response;
      if (map) {
        let etag = map.external_etag;
        if (payload.force) {
          const cur = await providerFetch(a, `${base}/me/contacts/${encodeURIComponent(map.external_id)}?$select=id`);
          if (cur.ok) etag = ((await cur.json()) as { "@odata.etag": string })["@odata.etag"];
        }
        res = await providerFetch(a, `${base}/me/contacts/${encodeURIComponent(map.external_id)}`, { method: "PATCH", headers: etag ? { "If-Match": etag } : {}, body: JSON.stringify(body) });
        if (res.status === 412) throw new SyncConflict("Outlook 연락처가 다른 곳에서 변경되어 덮어쓰지 않았습니다.", { externalId: map.external_id, etag });
      } else {
        res = await providerFetch(a, `${base}/me/contacts`, { method: "POST", body: JSON.stringify(body) });
      }
      if (!res.ok) await failed(res, a.provider, "Graph contacts");
      const j = (await res.json()) as { id: string; "@odata.etag"?: string };
      out = { externalId: j.id, etag: j["@odata.etag"] ?? null };
      break;
    }
    case "salesforce": {
      const sobject = object === "lead" ? "Lead" : "Contact";
      let id: string;
      if (externalIdField) {
        // idempotent upsert by external id (custom unique field, e.g. LINKOS_Id__c)
        const { [externalIdField]: _drop, ...rest } = values;
        const res = await providerFetch(a, `${base}/sobjects/${sobject}/${externalIdField}/${encodeURIComponent(contact.id)}`, { method: "PATCH", body: JSON.stringify(rest) });
        if (!res.ok) await failed(res, a.provider, "Salesforce upsert");
        const j = res.status === 204 ? null : ((await res.json().catch(() => null)) as { id?: string } | null);
        id = j?.id ?? map?.external_id ?? "";
        if (!id) {
          const look = await providerFetch(a, `${base}/sobjects/${sobject}/${externalIdField}/${encodeURIComponent(contact.id)}?fields=Id`);
          if (!look.ok) await failed(look, a.provider, "Salesforce lookup");
          id = ((await look.json()) as { Id: string }).Id;
        }
      } else if (map) {
        const since = payload.force ? null : httpDate(map.external_etag);
        const res = await providerFetch(a, `${base}/sobjects/${sobject}/${encodeURIComponent(map.external_id)}`, { method: "PATCH", headers: since ? { "If-Unmodified-Since": since } : {}, body: JSON.stringify(values) });
        if (res.status === 412) throw new SyncConflict("Salesforce 레코드가 마지막 동기화 이후 변경되어 덮어쓰지 않았습니다.", { externalId: map.external_id, etag: map.external_etag });
        if (!res.ok) await failed(res, a.provider, "Salesforce update");
        id = map.external_id;
      } else {
        const res = await providerFetch(a, `${base}/sobjects/${sobject}`, { method: "POST", body: JSON.stringify(values) });
        if (res.status === 400 || res.status === 300) {
          const err = (await res.json().catch(() => [])) as { errorCode?: string; duplicateResult?: { matchResults?: { matchRecords?: { record?: { Id?: string } }[] }[] } }[];
          const dup = Array.isArray(err) ? err.find((e) => e.errorCode === "DUPLICATES_DETECTED") : undefined;
          if (dup) throw new SyncConflict("Salesforce 중복 규칙에 걸려 새 레코드를 만들지 않았습니다.", { externalId: dup.duplicateResult?.matchResults?.[0]?.matchRecords?.[0]?.record?.Id });
          throw new ApiError(400, "salesforce_400", `Salesforce create 400: ${JSON.stringify(err).slice(0, 200)}`);
        }
        if (!res.ok) await failed(res, a.provider, "Salesforce create");
        id = ((await res.json()) as { id: string }).id;
      }
      const meta = await providerFetch(a, `${base}/sobjects/${sobject}/${encodeURIComponent(id)}?fields=LastModifiedDate`);
      const lm = meta.ok ? ((await meta.json()) as { LastModifiedDate?: string }).LastModifiedDate ?? null : null;
      out = { externalId: id, etag: lm, url: `${a.metadata.instanceUrl}/${id}` };
      break;
    }
    case "hubspot": {
      if (map) {
        if (!payload.force && map.external_etag) {
          const cur = await providerFetch(a, `${base}/crm/v3/objects/contacts/${encodeURIComponent(map.external_id)}?properties=hs_lastmodifieddate`);
          if (cur.status === 404) throw new SyncConflict("HubSpot 연락처가 삭제되었거나 병합되었습니다.", { externalId: map.external_id });
          if (!cur.ok) await failed(cur, a.provider, "HubSpot read");
          const j = (await cur.json()) as { updatedAt: string };
          if (j.updatedAt !== map.external_etag) throw new SyncConflict("HubSpot 연락처가 마지막 동기화 이후 변경되어 덮어쓰지 않았습니다.", { externalId: map.external_id, etag: j.updatedAt });
        }
        const res = await providerFetch(a, `${base}/crm/v3/objects/contacts/${encodeURIComponent(map.external_id)}`, { method: "PATCH", body: JSON.stringify({ properties: values }) });
        if (!res.ok) await failed(res, a.provider, "HubSpot update");
        const j = (await res.json()) as { id: string; updatedAt: string };
        out = { externalId: j.id, etag: j.updatedAt };
      } else {
        const res = await providerFetch(a, `${base}/crm/v3/objects/contacts`, { method: "POST", body: JSON.stringify({ properties: values }) });
        if (res.status === 409) {
          const j = (await res.json().catch(() => ({}))) as { message?: string };
          const existing = j.message?.match(/Existing ID:\s*(\d+)/)?.[1];
          throw new SyncConflict("같은 이메일의 HubSpot 연락처가 이미 있어 덮어쓰지 않았습니다.", { externalId: existing });
        }
        if (!res.ok) await failed(res, a.provider, "HubSpot create");
        const j = (await res.json()) as { id: string; updatedAt: string };
        out = { externalId: j.id, etag: j.updatedAt };
      }
      if (a.metadata.hubId) out.url = `https://app.hubspot.com/contacts/${a.metadata.hubId}/record/0-1/${out.externalId}`;
      break;
    }
    case "dynamics": {
      const set = object === "lead" ? "leads" : "contacts";
      const key = object === "lead" ? "leadid" : "contactid";
      const headers = { "OData-Version": "4.0", "OData-MaxVersion": "4.0", Prefer: "return=representation" };
      let res: Response;
      if (externalIdField && !map) {
        // upsert by alternate key; If-None-Match:* would block updates, so plain PATCH = create-or-update
        res = await providerFetch(a, `${base}/${set}(${externalIdField}='${encodeURIComponent(contact.id)}')`, { method: "PATCH", headers, body: JSON.stringify(values) });
      } else if (map) {
        const ifMatch = payload.force ? "*" : (map.external_etag ?? "*");
        res = await providerFetch(a, `${base}/${set}(${encodeURIComponent(map.external_id)})`, { method: "PATCH", headers: { ...headers, "If-Match": ifMatch }, body: JSON.stringify(values) });
        if (res.status === 412) throw new SyncConflict("Dynamics 레코드가 다른 곳에서 변경되어 덮어쓰지 않았습니다.", { externalId: map.external_id, etag: map.external_etag });
      } else {
        res = await providerFetch(a, `${base}/${set}`, { method: "POST", headers: { ...headers, "MSCRM.SuppressDuplicateDetection": "false" }, body: JSON.stringify(values) });
        if (res.status === 412) throw new SyncConflict("Dynamics 중복 감지 규칙에 걸려 새 레코드를 만들지 않았습니다.");
      }
      if (!res.ok) await failed(res, a.provider, "Dynamics");
      const j = (await res.json()) as Record<string, string>;
      out = { externalId: j[key]!, etag: j["@odata.etag"] ?? null, url: `${a.metadata.orgUrl}/main.aspx?pagetype=entityrecord&etn=${object}&id=${j[key]}` };
      break;
    }
  }
  await q(
    `INSERT INTO external_mappings (integration_account_id, entity_type, local_id, external_id, external_etag, remote_url, last_synced_at) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (integration_account_id, entity_type, local_id) DO UPDATE SET external_id=EXCLUDED.external_id, external_etag=EXCLUDED.external_etag, remote_url=COALESCE(EXCLUDED.remote_url, external_mappings.remote_url), last_synced_at=now()`,
    [a.id, entity, contactId, out.externalId, out.etag, out.url ?? null],
  );
  return out;
}

// ---------- F-088 meeting summary → CRM activity/note ----------
function meetingNoteText(m: { title: string | null; purpose: string | null; started_at: Date | null; summary: any }, actions: { description: string; due_at: Date | null; status: string }[]): string {
  const s = m.summary ?? {};
  const lines = [`[LINKOS] ${m.title ?? "미팅"}${m.started_at ? ` (${new Date(m.started_at).toISOString().slice(0, 10)})` : ""}`];
  if (m.purpose) lines.push(`목적: ${m.purpose}`);
  for (const d of s.discussion ?? []) lines.push(`- 논의: ${d}`);
  for (const d of s.decisions ?? []) lines.push(`- 결정: ${d}`);
  for (const p of s.promises ?? []) lines.push(`- 약속(${p.by === "them" ? "상대" : "나"}): ${p.text}`);
  for (const a of actions) lines.push(`- To-do${a.status === "done" ? "(완료)" : ""}: ${a.description}${a.due_at ? ` ~${new Date(a.due_at).toISOString().slice(0, 10)}` : ""}`);
  return lines.join("\n").slice(0, 30000);
}

async function upsertMeetingNote(a: Account, meetingId: string, contactId: string): Promise<Upserted> {
  const m = await one<any>("SELECT id, title, purpose, started_at, summary FROM meetings WHERE id=$1 AND owner_user_id=$2", [meetingId, a.user_id]);
  if (!m) throw notFound("meeting");
  const part = await one("SELECT 1 FROM meeting_participants WHERE meeting_id=$1 AND contact_id=$2", [meetingId, contactId]);
  if (!part) throw notFound("participant");
  const actions = await q<any>("SELECT description, due_at, status FROM action_items WHERE meeting_id=$1 ORDER BY due_at NULLS LAST", [meetingId]);
  const text = meetingNoteText(m, actions);
  const subject = `LINKOS 미팅: ${m.title ?? ""}`.slice(0, 250);
  // the contact must exist remotely first (idempotent upsert); prefer an existing lead/contact mapping
  let target = await one<{ entity_type: string; external_id: string }>("SELECT entity_type, external_id FROM external_mappings WHERE integration_account_id=$1 AND local_id=$2 AND entity_type IN ('contact','lead') ORDER BY entity_type LIMIT 1", [a.id, contactId]);
  if (!target) target = { entity_type: "contact", external_id: (await upsertRecord(a, "contact", contactId, {})).externalId };
  const entity = `meeting_note:${contactId}`;
  const existing = await one<{ external_id: string }>("SELECT external_id FROM external_mappings WHERE integration_account_id=$1 AND entity_type=$2 AND local_id=$3", [a.id, entity, meetingId]);
  const base = apiBase(a);
  let id: string;
  switch (a.provider) {
    case "salesforce": {
      const body = { Subject: subject, Description: text, Status: "Completed", ActivityDate: (m.started_at ? new Date(m.started_at) : new Date()).toISOString().slice(0, 10), WhoId: target.external_id };
      const res = existing
        ? await providerFetch(a, `${base}/sobjects/Task/${encodeURIComponent(existing.external_id)}`, { method: "PATCH", body: JSON.stringify(body) })
        : await providerFetch(a, `${base}/sobjects/Task`, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) await failed(res, a.provider, "Salesforce Task");
      id = existing?.external_id ?? ((await res.json()) as { id: string }).id;
      break;
    }
    case "hubspot": {
      const props = { hs_timestamp: (m.started_at ? new Date(m.started_at) : new Date()).toISOString(), hs_note_body: text };
      const res = existing
        ? await providerFetch(a, `${base}/crm/v3/objects/notes/${encodeURIComponent(existing.external_id)}`, { method: "PATCH", body: JSON.stringify({ properties: props }) })
        : await providerFetch(a, `${base}/crm/v3/objects/notes`, { method: "POST", body: JSON.stringify({ properties: props, associations: [{ to: { id: target.external_id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }] }) });
      if (!res.ok) await failed(res, a.provider, "HubSpot note");
      id = ((await res.json()) as { id: string }).id;
      break;
    }
    case "dynamics": {
      const set = target.entity_type === "lead" ? "leads" : "contacts";
      const body: Record<string, string> = { subject, notetext: text };
      if (!existing) body[`objectid_${target.entity_type}@odata.bind`] = `/${set}(${target.external_id})`;
      const headers = { "OData-Version": "4.0", Prefer: "return=representation" };
      const res = existing
        ? await providerFetch(a, `${base}/annotations(${encodeURIComponent(existing.external_id)})`, { method: "PATCH", headers, body: JSON.stringify(body) })
        : await providerFetch(a, `${base}/annotations`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!res.ok) await failed(res, a.provider, "Dynamics annotation");
      id = existing?.external_id ?? ((await res.json()) as { annotationid: string }).annotationid;
      break;
    }
    case "microsoft":
      throw new ApiError(422, "notes_unsupported", "Outlook 연락처에는 미팅 노트를 첨부할 수 없습니다.");
  }
  await q(
    `INSERT INTO external_mappings (integration_account_id, entity_type, local_id, external_id, last_synced_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (integration_account_id, entity_type, local_id) DO UPDATE SET external_id=EXCLUDED.external_id, last_synced_at=now()`,
    [a.id, entity, meetingId, id],
  );
  return { externalId: id, etag: null };
}

/** F-088: attach a meeting's summary to each participant's CRM record (user-initiated, queued + processed now). */
export async function attachMeetingToCrm(ctx: Ctx, meetingId: string, p: CrmProvider) {
  if (!ctx.userId) throw unauthorized();
  const a = await providerAccount(ctx.userId, p);
  if (!a) throw new ApiError(409, `${p}_not_connected`, "CRM 계정을 먼저 연결하세요.");
  if (p === "microsoft") throw badRequest("notes_unsupported", "Outlook은 미팅 노트 첨부를 지원하지 않습니다.");
  const m = await one<{ id: string }>("SELECT id FROM meetings WHERE id=$1 AND owner_user_id=$2", [meetingId, ctx.userId]);
  if (!m) throw notFound("meeting");
  const parts = await q<{ contact_id: string }>("SELECT contact_id FROM meeting_participants WHERE meeting_id=$1", [meetingId]);
  if (!parts.length) throw badRequest("no_participants", "참석자를 먼저 추가하세요.");
  const stamp = Date.now();
  for (const part of parts) {
    await q(
      `INSERT INTO sync_jobs (integration_account_id, job_type, payload, idempotency_key, provider) VALUES ($1,'crm.note.upsert',$2,$3,$4)
       ON CONFLICT (integration_account_id, idempotency_key) DO NOTHING`,
      [a.id, JSON.stringify({ meetingId, contactId: part.contact_id }), `note:${meetingId}:${part.contact_id}:${stamp}`, p],
    );
  }
  await audit(pool(), ctx, `integration.${p}.meeting_attached`, "meeting", meetingId, { contacts: parts.length });
  await processSyncJobs(20, a.id).catch((e) => log("warn", "crm.inline_process_failed", { error: (e as Error).message }));
  const jobs = await q<{ status: string; last_error: string | null }>("SELECT status, last_error FROM sync_jobs WHERE integration_account_id=$1 AND job_type='crm.note.upsert' AND payload->>'meetingId'=$2 AND idempotency_key LIKE $3", [a.id, meetingId, `note:${meetingId}:%:${stamp}`]);
  return { queued: parts.length, done: jobs.filter((j) => j.status === "done").length, pending: jobs.filter((j) => j.status !== "done").map((j) => ({ status: j.status, error: j.last_error })) };
}

// ---------- job runner (called from integration.processSyncJobs) ----------
export async function runSyncJob(accountId: string, job: { id: string; job_type: string; payload: any }): Promise<{ externalId?: string } | void> {
  const a = await accountById(accountId);
  if (a.status !== "active") throw new ApiError(401, `${a.provider}_reauth_required`);
  switch (job.job_type) {
    case "crm.contact.upsert":
      return upsertRecord(a, "contact", job.payload.contactId, job.payload);
    case "crm.lead.upsert":
      return upsertRecord(a, "lead", job.payload.contactId, job.payload);
    case "crm.note.upsert":
      return upsertMeetingNote(a, job.payload.meetingId, job.payload.contactId);
    case "calendar.event.upsert": {
      const { runCalendarJob } = await import("./calendar");
      return runCalendarJob(a.id, a.provider as string, job.payload);
    }
    default:
      throw new ApiError(400, "unknown_job_type", job.job_type);
  }
}

// ---------- status / disconnect ----------
export async function crmStatus(userId: string) {
  const rows = await q<{ provider: string; status: string; metadata: AccountMeta; updated_at: Date; scopes: string[] }>("SELECT provider, status, metadata, updated_at, scopes FROM integration_accounts WHERE user_id=$1 AND provider = ANY($2::text[])", [userId, [...CRM_PROVIDERS]]);
  return CRM_PROVIDERS.map((p) => {
    const r = rows.find((x) => x.provider === p);
    return {
      provider: p,
      configured: providerConfigured(p),
      status: r?.status ?? "disconnected",
      account: r ? { email: r.metadata?.accountEmail ?? null, instanceUrl: r.metadata?.instanceUrl ?? r.metadata?.orgUrl ?? null } : null,
      objects: CRM_OBJECTS.filter((o) => supportsObject(p, o)),
      capabilities: { contacts: true, notes: p !== "microsoft", calendar: p === "microsoft", mail: p === "microsoft" && Boolean(r?.scopes?.includes("Mail.Send")) },
      updatedAt: r?.updated_at ?? null,
    };
  });
}

export async function disconnectProvider(ctx: Ctx, p: CrmProvider) {
  if (!ctx.userId) throw unauthorized();
  await q("UPDATE integration_accounts SET status='revoked', encrypted_credentials=NULL, updated_at=now() WHERE user_id=$1 AND provider=$2", [ctx.userId, p]);
  await recordConsents(pool(), ctx.userId, [{ type: `integration_${p}` as ConsentType, granted: false }]);
  await audit(pool(), ctx, `integration.${p}.disconnected`, "integration_account", null);
  return { ok: true };
}

// ---------- F-128 Sync Journal ----------
export const journalQuery = z.object({
  provider: z.string().max(20).optional(),
  status: z.enum(["queued", "retry", "done", "dead", "conflict", "skipped"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function syncJournal(userId: string, f: z.infer<typeof journalQuery>) {
  const params: unknown[] = [userId, f.limit];
  let jobFilter = "";
  let acctFilter = "";
  if (f.status) {
    params.push(f.status);
    jobFilter = `AND j.status = $${params.length}`;
  }
  if (f.provider) {
    params.push(f.provider);
    acctFilter = `AND a.provider = $${params.length}`;
  }
  const rows = await q<any>(
    `SELECT j.id, j.job_type, j.status, j.attempt_count, j.last_error, j.scheduled_at, j.finished_at, j.external_id AS job_external_id, j.resolution, j.payload,
       a.provider, em.external_id, em.external_etag, em.remote_url, em.last_synced_at, c.full_name
     FROM integration_accounts a
     JOIN LATERAL (SELECT * FROM sync_jobs j WHERE j.integration_account_id = a.id ${jobFilter} ORDER BY j.scheduled_at DESC LIMIT $2) j ON true
     LEFT JOIN contacts c ON c.id = NULLIF(j.payload->>'contactId','')::uuid AND c.owner_user_id = a.user_id
     LEFT JOIN external_mappings em ON em.integration_account_id = a.id AND em.local_id = NULLIF(j.payload->>'contactId','')::uuid
       AND em.entity_type = CASE j.job_type WHEN 'crm.lead.upsert' THEN 'lead' ELSE 'contact' END
     WHERE a.user_id = $1 ${acctFilter}
     ORDER BY j.scheduled_at DESC LIMIT $2`,
    params,
  );
  const counts = await q<{ provider: string; status: string; n: number }>(
    "SELECT a.provider, j.status, count(*)::int AS n FROM sync_jobs j JOIN integration_accounts a ON a.id=j.integration_account_id WHERE a.user_id=$1 GROUP BY 1,2",
    [userId],
  );
  return {
    counts,
    entries: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      jobType: r.job_type,
      status: r.status,
      attempts: r.attempt_count,
      error: r.last_error,
      scheduledAt: r.scheduled_at,
      finishedAt: r.finished_at,
      resolution: r.resolution,
      contact: r.payload?.contactId ? { id: r.payload.contactId, fullName: r.full_name } : null,
      meetingId: r.payload?.meetingId ?? null,
      external: r.external_id || r.job_external_id ? { id: r.external_id ?? r.job_external_id, etag: r.external_etag, url: r.remote_url, lastSyncedAt: r.last_synced_at } : null,
      canRetry: r.status === "dead",
      canResolve: r.status === "conflict",
    })),
  };
}

async function ownedJob(userId: string, jobId: string) {
  const j = await one<{ id: string; status: string; payload: any; external_id: string | null; integration_account_id: string; provider: string }>(
    "SELECT j.id, j.status, j.payload, j.external_id, j.integration_account_id, a.provider FROM sync_jobs j JOIN integration_accounts a ON a.id=j.integration_account_id WHERE j.id=$1 AND a.user_id=$2",
    [jobId, userId],
  );
  if (!j) throw notFound("sync_job");
  return j;
}

/** Retry a dead job (e.g. after reconnecting). Conflicts need an explicit resolution instead. */
export async function retryJob(ctx: Ctx, jobId: string) {
  if (!ctx.userId) throw unauthorized();
  const j = await ownedJob(ctx.userId, jobId);
  if (j.status !== "dead") throw conflict("not_retryable", "실패(dead) 상태의 작업만 다시 시도할 수 있습니다.");
  await q("UPDATE sync_jobs SET status='queued', attempt_count=0, last_error=NULL, scheduled_at=now(), finished_at=NULL WHERE id=$1", [jobId]);
  await audit(pool(), ctx, "integration.job.retried", "sync_job", jobId, { provider: j.provider });
  await processSyncJobs(20, j.integration_account_id).catch(() => 0);
  return one("SELECT id, status, attempt_count, last_error FROM sync_jobs WHERE id=$1", [jobId]);
}

export const resolveInput = z.object({ strategy: z.enum(["overwrite", "skip"]) });

/** Conflict resolution is always a user decision: overwrite the remote record with LINKOS data, or keep the remote version. */
export async function resolveConflict(ctx: Ctx, jobId: string, strategy: "overwrite" | "skip") {
  if (!ctx.userId) throw unauthorized();
  const j = await ownedJob(ctx.userId, jobId);
  if (j.status !== "conflict") throw conflict("not_in_conflict");
  if (strategy === "skip") {
    await q("UPDATE sync_jobs SET status='skipped', resolution='kept_remote', finished_at=now() WHERE id=$1", [jobId]);
  } else {
    const payload = { ...j.payload, force: true, ...(j.external_id ? { linkExternalId: j.external_id } : {}) };
    await q("UPDATE sync_jobs SET status='queued', resolution='overwrite_approved', payload=$2, attempt_count=0, scheduled_at=now(), finished_at=NULL WHERE id=$1", [jobId, JSON.stringify(payload)]);
  }
  await audit(pool(), ctx, `integration.conflict.${strategy}`, "sync_job", jobId, { provider: j.provider });
  if (strategy === "overwrite") await processSyncJobs(20, j.integration_account_id).catch(() => 0);
  return one("SELECT id, status, resolution, last_error FROM sync_jobs WHERE id=$1", [jobId]);
}
