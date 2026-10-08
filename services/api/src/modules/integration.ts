// integration module — Google OAuth/People API 동기화(idempotent, 사용자별 직렬 처리, external etag 매핑) + Export(CSV/vCard/XLSX/TXT/JSON)
import { generateToken, toCsv, toVCard } from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, notFound, unauthorized, unavailable } from "../lib/errors";
import { type Ctx, appOrigin, audit, emit, hmac, log } from "../lib/platform";
import { recordConsents } from "./identity";
import { assertExportAllowed } from "./policy";
import { type ContactDto, type ContactRow, listContacts, toContactDto } from "./relationship";

// ---------- credential vault (AES-256-GCM) — shared with cached idempotent responses ----------
export { seal, unseal } from "../lib/vault";
import { seal, unseal } from "../lib/vault";

// ---------- Google ----------
const GOOGLE_SCOPES_LOGIN = ["openid", "email", "profile"];
export const GOOGLE_SCOPE = {
  contacts: "https://www.googleapis.com/auth/contacts",
  // drive.file: the app can only see files it created (least privilege for F-116/F-117)
  driveFile: "https://www.googleapis.com/auth/drive.file",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
  calendarFreeBusy: "https://www.googleapis.com/auth/calendar.freebusy",
} as const;
const GOOGLE_SCOPES_CONTACTS = [GOOGLE_SCOPE.contacts];
const GOOGLE_SCOPES_SHEETS = [GOOGLE_SCOPE.driveFile];
const PURPOSE_SCOPES: Record<GooglePurpose, string[]> = {
  login: [],
  contacts: GOOGLE_SCOPES_CONTACTS,
  sheets: GOOGLE_SCOPES_SHEETS,
  drive: GOOGLE_SCOPES_SHEETS,
  gmail: [GOOGLE_SCOPE.gmailSend, GOOGLE_SCOPE.gmailCompose],
  calendar: [GOOGLE_SCOPE.calendarEvents, GOOGLE_SCOPE.calendarFreeBusy],
};
export type GooglePurpose = "login" | "contacts" | "sheets" | "drive" | "gmail" | "calendar";
export const GOOGLE_PURPOSES = ["contacts", "sheets", "drive", "gmail", "calendar"] as const;

/** Endpoint bases are overridable so integration tests can run against a local fake Google (GOOGLE_API_BASE). */
export function gurl(kind: "auth" | "token" | "userinfo" | "people" | "sheets" | "gmail" | "calendar" | "drive" | "driveUpload", path = ""): string {
  const fake = process.env.GOOGLE_API_BASE?.replace(/\/$/, "");
  if (fake) return `${fake}/${kind}${path}`;
  const base = {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    people: "https://people.googleapis.com/v1",
    sheets: "https://sheets.googleapis.com/v4",
    gmail: "https://gmail.googleapis.com/gmail/v1",
    calendar: "https://www.googleapis.com/calendar/v3",
    drive: "https://www.googleapis.com/drive/v3",
    driveUpload: "https://www.googleapis.com/upload/drive/v3",
  }[kind];
  return `${base}${path}`;
}

export function googleEnabled() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleAuthUrl(purpose: GooglePurpose, userId: string | null): { url: string; state: string } {
  if (!googleEnabled()) throw unavailable("google_not_configured", "Google 연동이 설정되지 않았습니다(GOOGLE_CLIENT_ID).");
  const nonce = generateToken(16);
  const payload = `${purpose}.${userId ?? "-"}.${Date.now()}.${nonce}`;
  const state = `${Buffer.from(payload).toString("base64url")}.${hmac(payload).slice(0, 32)}`;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${appOrigin()}/api/v1/integrations/google/callback`,
    response_type: "code",
    scope: [...GOOGLE_SCOPES_LOGIN, ...PURPOSE_SCOPES[purpose]].join(" "),
    state,
    access_type: purpose === "login" ? "online" : "offline",
    prompt: purpose === "login" ? "select_account" : "consent",
    include_granted_scopes: "true",
  });
  return { url: `${gurl("auth")}?${params}`, state };
}

export function verifyState(state: string): { purpose: GooglePurpose; userId: string | null } {
  const [b64, sig] = state.split(".");
  if (!b64 || !sig) throw badRequest("invalid_state");
  const payload = Buffer.from(b64, "base64url").toString();
  if (hmac(payload).slice(0, 32) !== sig) throw badRequest("invalid_state");
  const [purpose, uid, ts] = payload.split(".");
  if (Date.now() - Number(ts) > 10 * 60 * 1000) throw badRequest("state_expired");
  if (!(purpose === "login" || (GOOGLE_PURPOSES as readonly string[]).includes(purpose!))) throw badRequest("invalid_state");
  return { purpose: purpose as GooglePurpose, userId: uid === "-" ? null : uid! };
}

export async function exchangeGoogleCode(code: string) {
  const res = await fetch(gurl("token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${appOrigin()}/api/v1/integrations/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new ApiError(502, "google_token_failed", "Google 인증에 실패했습니다.");
  const tok = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string; id_token?: string };
  const info = await fetch(gurl("userinfo"), { headers: { authorization: `Bearer ${tok.access_token}` } });
  if (!info.ok) throw new ApiError(502, "google_userinfo_failed");
  const user = (await info.json()) as { sub: string; email: string; email_verified: boolean; name?: string };
  if (!user.email_verified) throw badRequest("google_email_unverified", "Google 이메일이 확인되지 않았습니다.");
  return { tok, user };
}

export async function storeGoogleAccount(userId: string, tok: { access_token: string; refresh_token?: string; expires_in: number; scope: string }) {
  await tx(async (c) => {
    const prev = await one<{ encrypted_credentials: Buffer | null }>("SELECT encrypted_credentials FROM integration_accounts WHERE user_id=$1 AND provider='google'", [userId], c);
    const prevCreds = prev?.encrypted_credentials ? unseal<{ refresh_token?: string }>(prev.encrypted_credentials) : {};
    const creds = { access_token: tok.access_token, refresh_token: tok.refresh_token ?? prevCreds.refresh_token, expires_at: Date.now() + tok.expires_in * 1000 };
    await c.query(
      `INSERT INTO integration_accounts (user_id, provider, scopes, encrypted_credentials, status) VALUES ($1,'google',$2,$3,'active')
       ON CONFLICT (user_id, provider) DO UPDATE SET scopes=EXCLUDED.scopes, encrypted_credentials=EXCLUDED.encrypted_credentials, status='active', updated_at=now()`,
      [userId, tok.scope.split(" "), seal(creds)],
    );
    await recordConsents(c, userId, [{ type: "integration_google", granted: true }], { scopes: tok.scope });
  });
}

export async function googleAccessToken(accountId: string, db: Db = pool()): Promise<string> {
  const a = await one<{ encrypted_credentials: Buffer }>("SELECT encrypted_credentials FROM integration_accounts WHERE id=$1 AND status='active'", [accountId], db);
  if (!a) throw notFound("integration");
  const creds = unseal<{ access_token: string; refresh_token?: string; expires_at: number }>(a.encrypted_credentials);
  if (creds.expires_at - 60_000 > Date.now()) return creds.access_token;
  if (!creds.refresh_token) throw new ApiError(401, "google_reauth_required");
  const res = await fetch(gurl("token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, refresh_token: creds.refresh_token, grant_type: "refresh_token" }),
  });
  if (!res.ok) {
    await q("UPDATE integration_accounts SET status='reauth_required', updated_at=now() WHERE id=$1", [accountId]);
    throw new ApiError(401, "google_reauth_required");
  }
  const t = (await res.json()) as { access_token: string; expires_in: number };
  await q("UPDATE integration_accounts SET encrypted_credentials=$2, updated_at=now() WHERE id=$1", [accountId, seal({ ...creds, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 })]);
  return t.access_token;
}

/** Active Google account with the given scope (null when not connected or scope not granted). */
export async function googleAccountWithScope(userId: string, scope: string, db: Db = pool()): Promise<{ id: string; scopes: string[] } | null> {
  const a = await one<{ id: string; status: string; scopes: string[] }>("SELECT id, status, scopes FROM integration_accounts WHERE user_id=$1 AND provider='google'", [userId], db);
  return a && a.status === "active" && hasScope(a.scopes, scope) ? { id: a.id, scopes: a.scopes } : null;
}

export async function integrationStatus(userId: string) {
  const accounts = await q<any>("SELECT id, provider, scopes, status, metadata, updated_at FROM integration_accounts WHERE user_id=$1", [userId]);
  const jobs = await q<any>(
    `SELECT j.id, j.job_type, j.provider, j.status, j.attempt_count, j.last_error, j.scheduled_at, j.finished_at FROM sync_jobs j JOIN integration_accounts a ON a.id=j.integration_account_id
     WHERE a.user_id=$1 ORDER BY j.scheduled_at DESC LIMIT 20`,
    [userId],
  );
  const sheets = await sheetsStatus(userId);
  const g = accounts.find((a) => a.provider === "google" && a.status === "active");
  const has = (sc: string) => Boolean(g && hasScope(g.scopes, sc));
  return {
    googleConfigured: googleEnabled(),
    accounts,
    jobs,
    sheetsConnected: sheets.connected,
    google: {
      contacts: has(GOOGLE_SCOPE.contacts),
      drive: has(GOOGLE_SCOPE.driveFile),
      gmailSend: has(GOOGLE_SCOPE.gmailSend),
      gmailDrafts: has(GOOGLE_SCOPE.gmailCompose),
      calendar: has(GOOGLE_SCOPE.calendarEvents),
      freeBusy: has(GOOGLE_SCOPE.calendarFreeBusy) || has(GOOGLE_SCOPE.calendarEvents),
    },
  };
}

/** POST /integrations/google/contacts/sync — enqueue one idempotent job per contact (version-keyed). */
export async function enqueueGoogleContactSync(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  const acct = await one<{ id: string; status: string; scopes: string[] }>("SELECT id, status, scopes FROM integration_accounts WHERE user_id=$1 AND provider='google'", [ctx.userId]);
  if (!acct || acct.status !== "active" || !hasScope(acct.scopes, GOOGLE_SCOPE.contacts)) throw new ApiError(409, "google_not_connected", "Google 연락처 권한을 먼저 연결하세요.");
  const contacts = await q<{ id: string; version: number }>("SELECT id, version FROM contacts WHERE owner_user_id=$1 AND deleted_at IS NULL AND merged_into_id IS NULL", [ctx.userId]);
  let queued = 0;
  for (const c of contacts) {
    const r = await q(
      `INSERT INTO sync_jobs (integration_account_id, job_type, payload, idempotency_key, provider) VALUES ($1,'google.contact.upsert',$2,$3,'google')
       ON CONFLICT (integration_account_id, idempotency_key) DO NOTHING RETURNING id`,
      [acct.id, JSON.stringify({ contactId: c.id }), `contact:${c.id}:v${c.version}`],
    );
    queued += r.length;
  }
  await audit(pool(), ctx, "integration.google.sync_requested", "integration_account", acct.id, { queued });
  return { queued, total: contacts.length };
}

/** Job outcome classes for the Sync Journal (F-128): conflicts are never retried automatically or overwritten silently. */
export class SyncConflict extends ApiError {
  constructor(message: string, public readonly remote?: { externalId?: string; etag?: string | null }) {
    super(409, "sync_conflict", message, remote);
  }
}

function classify(e: unknown): "conflict" | "dead" | "retry" {
  if (e instanceof SyncConflict) return "conflict";
  const status = (e as ApiError)?.status;
  if (status === 401 || status === 403 || status === 404 || status === 400 || status === 422) return "dead";
  return "retry";
}

async function runJob(accountId: string, job: { id: string; job_type: string; payload: any }) {
  if (job.job_type === "google.contact.upsert") return runGoogleUpsert(accountId, job.payload.contactId, Boolean(job.payload.force));
  // other providers/kinds live in their own modules (dynamic import avoids a module cycle)
  const { runSyncJob } = await import("./crm");
  return runSyncJob(accountId, job);
}

/** Process due jobs of one account while holding its advisory lock on a dedicated connection. */
async function processAccount(accountId: string, limit: number): Promise<number> {
  const lockClient = await pool().connect();
  let done = 0;
  try {
    const lock = await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [accountId]);
    if (!lock.rows[0]?.ok) return 0;
    try {
      const jobs = await q<any>("SELECT * FROM sync_jobs WHERE integration_account_id=$1 AND status IN ('queued','retry') AND scheduled_at <= now() ORDER BY scheduled_at LIMIT $2", [accountId, limit]);
      for (const job of jobs) {
        try {
          const out = (await runJob(accountId, job)) as { externalId?: string } | void;
          await q("UPDATE sync_jobs SET status='done', finished_at=now(), attempt_count=attempt_count+1, last_error=NULL, external_id=COALESCE($2, external_id) WHERE id=$1", [job.id, out?.externalId ?? null]);
          done++;
        } catch (e) {
          const attempts = job.attempt_count + 1;
          const kind = classify(e);
          const dead = kind === "dead" || (kind === "retry" && attempts >= 6);
          const status = kind === "conflict" ? "conflict" : dead ? "dead" : "retry";
          // audit G-14: the terminal status and its `integration.sync.failed` event are written in ONE transaction (outbox rule)
          await tx(async (c) => {
            await c.query("UPDATE sync_jobs SET status=$2, attempt_count=$3, last_error=$4, scheduled_at = CASE WHEN $2='retry' THEN now() + ($5 || ' seconds')::interval ELSE scheduled_at END, finished_at = CASE WHEN $2='retry' THEN NULL ELSE now() END, external_id=COALESCE($6, external_id) WHERE id=$1", [
              job.id,
              status,
              attempts,
              (e as Error).message.slice(0, 300),
              String(2 ** attempts * 15),
              e instanceof SyncConflict ? (e.remote?.externalId ?? null) : null,
            ]);
            if (status !== "retry") {
              const provider = job.provider ?? String(job.job_type).split(".")[0];
              await emit(c, "integration.sync.failed", "sync_job", job.id, { provider, job_id: job.id, error_class: status === "conflict" ? "conflict" : ((e as ApiError).code ?? "error") });
            }
          });
          log("warn", "sync.job_failed", { job: job.id, attempts, status });
        }
      }
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [accountId]);
    }
  } finally {
    lockClient.release();
  }
  return done;
}

/** Worker: process queued jobs. Jobs of the same account run serially (People API / CRM mutation guidance). */
export async function processSyncJobs(limit = 20, onlyAccountId?: string): Promise<number> {
  const accounts = onlyAccountId
    ? [{ integration_account_id: onlyAccountId }]
    : await q<{ integration_account_id: string }>("SELECT DISTINCT integration_account_id FROM sync_jobs WHERE status IN ('queued','retry') AND scheduled_at <= now() LIMIT 10");
  let done = 0;
  for (const { integration_account_id } of accounts) done += await processAccount(integration_account_id, limit);
  return done;
}

async function runGoogleUpsert(accountId: string, contactId: string, force = false) {
  const c = await one<any>(
    `SELECT c.*, co.name AS company FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE c.id=$1 AND c.deleted_at IS NULL`,
    [contactId],
  );
  if (!c) return;
  const token = await googleAccessToken(accountId);
  const person = {
    names: [{ unstructuredName: c.full_name }],
    organizations: c.company || c.job_title ? [{ name: c.company ?? undefined, title: c.job_title ?? undefined }] : undefined,
    emailAddresses: c.email ? [{ value: c.email }] : undefined,
    phoneNumbers: c.phone ? [{ value: c.phone }] : undefined,
    urls: c.website ? [{ value: c.website }] : undefined,
  };
  const map = await one<{ external_id: string; external_etag: string }>("SELECT external_id, external_etag FROM external_mappings WHERE integration_account_id=$1 AND entity_type='contact' AND local_id=$2", [accountId, contactId]);
  let res: Response;
  if (map) {
    // never blindly overwrite: send the stored etag; Google rejects if the remote changed (conflict surfaced to user).
    // force=true only after the user explicitly chose "overwrite" in the Sync Journal: re-read the current etag first.
    let etag = map.external_etag;
    if (force) {
      const cur = await fetch(`${gurl("people")}/${map.external_id}?personFields=metadata`, { headers: { authorization: `Bearer ${token}` } });
      if (cur.ok) etag = ((await cur.json()) as { etag: string }).etag;
    }
    res = await fetch(`${gurl("people")}/${map.external_id}:updateContact?updatePersonFields=names,organizations,emailAddresses,phoneNumbers,urls`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...person, etag }),
    });
    if (res.status === 400 || res.status === 412) {
      const text = await res.text();
      if (/etag|FAILED_PRECONDITION/i.test(text) || res.status === 412) throw new SyncConflict("Google 연락처가 다른 곳에서 변경되어 덮어쓰지 않았습니다.", { externalId: map.external_id, etag: map.external_etag });
      throw new ApiError(400, "google_400", `People API 400`);
    }
  } else {
    res = await fetch(gurl("people", "/people:createContact?personFields=names,metadata"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(person),
    });
  }
  if (!res.ok) throw new ApiError(res.status, `google_${res.status}`, `People API ${res.status}`);
  const out = (await res.json()) as { resourceName: string; etag: string };
  await q(
    `INSERT INTO external_mappings (integration_account_id, entity_type, local_id, external_id, external_etag, last_synced_at) VALUES ($1,'contact',$2,$3,$4,now())
     ON CONFLICT (integration_account_id, entity_type, local_id) DO UPDATE SET external_id=EXCLUDED.external_id, external_etag=EXCLUDED.external_etag, last_synced_at=now()`,
    [accountId, contactId, out.resourceName, out.etag],
  );
  return { externalId: out.resourceName };
}

export async function disconnectGoogle(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  await q("UPDATE integration_accounts SET status='revoked', encrypted_credentials=NULL, updated_at=now() WHERE user_id=$1 AND provider='google'", [ctx.userId]);
  await recordConsents(pool(), ctx.userId, [{ type: "integration_google", granted: false }]);
  await audit(pool(), ctx, "integration.google.disconnected", "integration_account", null);
}

// ---------- Export (F-125 / UX-023) ----------
export const EXPORT_FORMATS = ["csv", "xlsx", "docx", "vcard", "txt", "json", "pdf"] as const;
const FIELD_LABELS: Record<string, string> = { fullName: "이름", company: "회사", jobTitle: "직책", department: "부서", email: "이메일", phone: "전화", address: "주소", website: "웹사이트", tags: "태그", lastContactAt: "최근 연락", source: "출처" };
export const EXPORT_FIELDS = ["fullName", "company", "jobTitle", "department", "email", "phone", "address", "website", "tags", "lastContactAt", "source"] as const;
/** contacts = the address book (field selection); meetings / relationships = fact-only reports with fixed columns (no AI text). */
export const EXPORT_REPORTS = ["contacts", "meetings", "relationships"] as const;
/** Report files are tabular; vCard/TXT/DOCX/PDF stay contact-only. */
export const REPORT_FORMATS = ["csv", "xlsx", "json"] as const;
const isoDate = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), "날짜 형식이 올바르지 않습니다.");
export const exportBaseInput = z.object({
  format: z.enum(EXPORT_FORMATS),
  fields: z.array(z.enum(EXPORT_FIELDS)).min(1).default(["fullName", "company", "jobTitle", "email", "phone"]),
  tag: z.string().max(40).optional(),
  report: z.enum(EXPORT_REPORTS).default("contacts"),
  /** period (inclusive). Contacts/relationships: added OR met (encounter) within the period; meetings: meeting date. */
  since: isoDate.optional(),
  until: isoDate.optional(),
});
export const exportInput = exportBaseInput
  .refine((v) => !v.since || !v.until || Date.parse(v.since) <= Date.parse(v.until), { message: "시작일이 종료일보다 늦습니다.", path: ["since"] })
  .refine((v) => v.report === "contacts" || (REPORT_FORMATS as readonly string[]).includes(v.format), { message: "보고서는 CSV · Excel · JSON으로만 내보낼 수 있습니다.", path: ["format"] });
// callers may omit `report` (defaults to "contacts")
export type ExportInput = Omit<z.infer<typeof exportInput>, "report"> & { report?: (typeof EXPORT_REPORTS)[number] };

interface ExportPeriod {
  since?: string | null;
  until?: string | null;
}

/** A date-only `until` (YYYY-MM-DD) includes that whole day. */
function periodBounds(p: ExportPeriod): { since: Date | null; until: Date | null } {
  const since = p.since ? new Date(p.since) : null;
  let until = p.until ? new Date(p.until) : null;
  if (until && p.until && /^\d{4}-\d{2}-\d{2}$/.test(p.until)) until = new Date(until.getTime() + 864e5 - 1);
  return { since, until };
}

export async function createExport(ctx: Ctx, input: ExportInput) {
  if (!ctx.userId) throw unauthorized();
  await assertExportAllowed(ctx.userId); // F-139
  const report = input.report ?? "contacts";
  const kind = report !== "contacts" ? `report:${report}` : input.tag ? `contacts:tag:${input.tag}` : "contacts";
  const params = { ...(input.since ? { since: input.since } : {}), ...(input.until ? { until: input.until } : {}) };
  const r = await one<{ id: string }>("INSERT INTO export_jobs (user_id, format, fields, kind, params) VALUES ($1,$2,$3,$4,$5) RETURNING id", [ctx.userId, input.format, input.fields, kind, JSON.stringify(params)]);
  // dates are not kept in audit metadata (redact() would mask them); the job row holds the exact period
  await audit(pool(), ctx, "export.created", "export_job", r!.id, { format: input.format, fields: input.fields, report, period: Boolean(input.since || input.until) });
  return { id: r!.id, status: "ready", downloadUrl: `/api/v1/exports/${r!.id}/download` };
}

/**
 * Contacts for an export. Without a period this is the address book as listed (unchanged behavior); with a period it is
 * every live contact that was added OR met (an encounter occurred) within it.
 */
export async function contactsForExport(userId: string, opts: { tag?: string } & ExportPeriod): Promise<ContactDto[]> {
  if (!opts.since && !opts.until) return listContacts(userId, { limit: 200, tag: opts.tag });
  const { since, until } = periodBounds(opts);
  const params: unknown[] = [userId, since, until];
  let where = "c.owner_user_id=$1 AND c.deleted_at IS NULL AND c.merged_into_id IS NULL";
  where += ` AND ((($2::timestamptz IS NULL OR c.created_at >= $2) AND ($3::timestamptz IS NULL OR c.created_at <= $3))
    OR EXISTS (SELECT 1 FROM encounters e WHERE e.owner_user_id=$1 AND e.contact_id=c.id AND ($2::timestamptz IS NULL OR e.occurred_at >= $2) AND ($3::timestamptz IS NULL OR e.occurred_at <= $3)))`;
  if (opts.tag) {
    params.push(opts.tag);
    where += ` AND EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.contact_id=c.id AND t.owner_user_id=$1 AND t.name=$${params.length})`;
  }
  const rows = await q<ContactRow>(
    `SELECT c.id, c.owner_user_id, c.linked_user_id, c.full_name, co.name AS company, c.job_title, c.department, c.email, c.phone,
       c.address, c.website, c.source, c.field_provenance, c.version, c.created_at, c.updated_at, rel.last_contact_at, rel.next_followup_at,
       COALESCE((SELECT array_agg(t.name ORDER BY t.name) FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id), '{}') AS tags
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
     LEFT JOIN relationships rel ON rel.owner_user_id = $1 AND rel.contact_id = c.id
     WHERE ${where}
     ORDER BY COALESCE(rel.last_contact_at, c.created_at) DESC
     LIMIT 2000`,
    params,
  );
  return rows.map(toContactDto);
}

const MEETING_COLUMNS = ["제목", "날짜", "상대", "회사", "목적", "다음 미팅"] as const;
/** Meetings report — only what the user recorded (title/date/participants/purpose). No AI summary text. */
export async function meetingReportRows(userId: string, period: ExportPeriod): Promise<Record<string, string>[]> {
  const { since, until } = periodBounds(period);
  const rows = await q<{ title: string | null; at: Date; purpose: string | null; next_meeting_at: Date | null; names: string[] | null; companies: string[] | null }>(
    `SELECT m.title, COALESCE(m.started_at, m.created_at) AS at, m.purpose, m.next_meeting_at,
       array_remove(array_agg(c.full_name ORDER BY c.full_name), NULL) AS names,
       array_remove(array_agg(DISTINCT co.name), NULL) AS companies
     FROM meetings m
     LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id
     LEFT JOIN contacts c ON c.id = mp.contact_id AND c.owner_user_id = $1 AND c.deleted_at IS NULL
     LEFT JOIN companies co ON co.id = c.company_id
     WHERE m.owner_user_id=$1 AND ($2::timestamptz IS NULL OR COALESCE(m.started_at, m.created_at) >= $2) AND ($3::timestamptz IS NULL OR COALESCE(m.started_at, m.created_at) <= $3)
     GROUP BY m.id ORDER BY at DESC LIMIT 2000`,
    [userId, since, until],
  );
  return rows.map((r) => ({
    제목: r.title ?? "",
    날짜: new Date(r.at).toISOString(),
    상대: (r.names ?? []).join("; "),
    회사: (r.companies ?? []).join("; "),
    목적: r.purpose ?? "",
    "다음 미팅": r.next_meeting_at ? new Date(r.next_meeting_at).toISOString() : "",
  }));
}

const RELATIONSHIP_COLUMNS = ["이름", "회사", "직책", "관계 강도", "만남 횟수", "마지막 만남", "최근 연락", "다음 후속", "상태"] as const;
/** Relationships report — stored facts (computed strength score, encounter count/last, follow-up date). */
export async function relationshipReportRows(userId: string, period: ExportPeriod): Promise<Record<string, string>[]> {
  const contacts = await contactsForExport(userId, period);
  if (!contacts.length) return [];
  const stats = await q<{ contact_id: string; strength: string | null; status: string | null; n: number; last: Date | null }>(
    `SELECT c.id AS contact_id, rel.strength, rel.status,
       (SELECT count(*)::int FROM encounters e WHERE e.owner_user_id=$1 AND e.contact_id=c.id) AS n,
       (SELECT max(e.occurred_at) FROM encounters e WHERE e.owner_user_id=$1 AND e.contact_id=c.id) AS last
     FROM contacts c LEFT JOIN relationships rel ON rel.owner_user_id=$1 AND rel.contact_id=c.id
     WHERE c.owner_user_id=$1 AND c.id = ANY($2::uuid[])`,
    [userId, contacts.map((c) => c.id)],
  );
  const by = new Map(stats.map((s) => [s.contact_id, s]));
  const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : "");
  return contacts.map((c) => {
    const s = by.get(c.id);
    return {
      이름: c.fullName,
      회사: c.company ?? "",
      직책: c.jobTitle ?? "",
      "관계 강도": s?.strength == null ? "" : String(Math.round(Number(s.strength))),
      "만남 횟수": String(s?.n ?? 0),
      "마지막 만남": iso(s?.last),
      "최근 연락": iso(c.lastContactAt),
      "다음 후속": iso(c.nextFollowupAt),
      상태: s?.status ?? "",
    };
  });
}

async function renderTable(format: (typeof EXPORT_FORMATS)[number], name: string, columns: readonly string[], rows: Record<string, unknown>[], stamp: string) {
  switch (format) {
    case "csv":
      return { body: toCsv(rows, [...columns]), contentType: "text/csv; charset=utf-8", filename: `linkos-${name}-${stamp}.csv` };
    case "json":
      return { body: JSON.stringify(rows, null, 2), contentType: "application/json", filename: `linkos-${name}-${stamp}.json` };
    case "xlsx": {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = "LINKOS";
      const ws = wb.addWorksheet(name);
      ws.columns = columns.map((f) => ({ header: f, key: f, width: 24 }));
      for (const r of rows) ws.addRow(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^[=+\-@]/.test(v) ? `'${v}` : v])));
      ws.getRow(1).font = { bold: true };
      return { body: Buffer.from(await wb.xlsx.writeBuffer()), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: `linkos-${name}-${stamp}.xlsx` };
    }
    default:
      throw badRequest("report_format", "보고서는 CSV · Excel · JSON으로만 내보낼 수 있습니다.");
  }
}

export async function renderExport(ctx: Ctx, id: string): Promise<{ body: Buffer | string; contentType: string; filename: string }> {
  if (!ctx.userId) throw unauthorized();
  const job = await one<{ format: (typeof EXPORT_FORMATS)[number]; fields: string[]; kind: string; params: ExportPeriod | null; expires_at: Date }>("SELECT format, fields, kind, params, expires_at FROM export_jobs WHERE id=$1 AND user_id=$2", [id, ctx.userId]);
  if (!job) throw notFound("export");
  if (job.expires_at.getTime() < Date.now()) throw new ApiError(410, "export_expired");
  const period: ExportPeriod = { since: job.params?.since ?? null, until: job.params?.until ?? null };
  const stamp = new Date().toISOString().slice(0, 10);
  if (job.kind === "report:meetings" || job.kind === "report:relationships") {
    const meetings = job.kind === "report:meetings";
    const rows = meetings ? await meetingReportRows(ctx.userId, period) : await relationshipReportRows(ctx.userId, period);
    await audit(pool(), ctx, "export.downloaded", "export_job", id, { rows: rows.length, report: meetings ? "meetings" : "relationships" });
    return renderTable(job.format, meetings ? "meetings" : "relationships", meetings ? MEETING_COLUMNS : RELATIONSHIP_COLUMNS, rows, stamp);
  }
  const tag = job.kind.startsWith("contacts:tag:") ? job.kind.slice(13) : undefined;
  const contacts = await contactsForExport(ctx.userId, { tag, ...period });
  const rows = contacts.map((c) => {
    const r: Record<string, unknown> = {};
    for (const f of job.fields) r[f] = f === "tags" ? c.tags.join(";") : f === "lastContactAt" ? (c.lastContactAt ? new Date(c.lastContactAt).toISOString() : "") : (c as Record<string, unknown>)[f];
    return r;
  });
  await audit(pool(), ctx, "export.downloaded", "export_job", id, { rows: rows.length });
  switch (job.format) {
    case "csv":
      return { body: toCsv(rows, job.fields), contentType: "text/csv; charset=utf-8", filename: `linkos-contacts-${stamp}.csv` };
    case "vcard":
      return {
        body: contacts.map((c) => toVCard({ fullName: c.fullName, company: job.fields.includes("company") ? c.company : null, jobTitle: job.fields.includes("jobTitle") ? c.jobTitle : null, email: job.fields.includes("email") ? c.email : null, phone: job.fields.includes("phone") ? c.phone : null, address: job.fields.includes("address") ? c.address : null, website: job.fields.includes("website") ? c.website : null })).join(""),
        contentType: "text/vcard; charset=utf-8",
        filename: `linkos-contacts-${stamp}.vcf`,
      };
    case "txt":
      return { body: rows.map((r) => job.fields.map((f) => `${f}: ${r[f] ?? ""}`).join("\n")).join("\n\n---\n\n"), contentType: "text/plain; charset=utf-8", filename: `linkos-contacts-${stamp}.txt` };
    case "json":
      return { body: JSON.stringify(rows, null, 2), contentType: "application/json", filename: `linkos-contacts-${stamp}.json` };
    case "docx": {
      const { buildDocx } = await import("../lib/docx");
      const body = await buildDocx(`LINKOS 연락처 (${stamp})`, job.fields, rows.map((r) => job.fields.map((f) => (r[f] == null ? "" : String(r[f])))));
      return { body, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: `linkos-contacts-${stamp}.docx` };
    }
    case "pdf": {
      const { buildTablePdf } = await import("../lib/pdf");
      const body = await buildTablePdf(`LINKOS 연락처 (${stamp})`, job.fields.map((f) => FIELD_LABELS[f] ?? f), rows.map((r) => job.fields.map((f) => (r[f] == null ? "" : String(r[f])))));
      return { body, contentType: "application/pdf", filename: `linkos-contacts-${stamp}.pdf` };
    }
    case "xlsx": {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = "LINKOS";
      const ws = wb.addWorksheet("Contacts");
      ws.columns = job.fields.map((f) => ({ header: f, key: f, width: 24 }));
      // formula-injection guard
      for (const r of rows) ws.addRow(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^[=+\-@]/.test(v) ? `'${v}` : v])));
      ws.getRow(1).font = { bold: true };
      return { body: Buffer.from(await wb.xlsx.writeBuffer()), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: `linkos-contacts-${stamp}.xlsx` };
    }
  }
}

// ---------- Google Sheets export (F-117) ----------
export function hasScope(scopes: string[] | null | undefined, scope: string): boolean {
  return (scopes ?? []).includes(scope);
}

export async function sheetsStatus(userId: string) {
  const a = await one<{ id: string; status: string; scopes: string[] }>("SELECT id, status, scopes FROM integration_accounts WHERE user_id=$1 AND provider='google'", [userId]);
  return { connected: a?.status === "active" && hasScope(a.scopes, GOOGLE_SCOPES_SHEETS[0]!), accountId: a?.id ?? null };
}

/** Creates a new spreadsheet (drive.file scope) and writes the selected contact fields as RAW values (no formula evaluation). */
export const sheetsExportInput = exportBaseInput.omit({ format: true, report: true });
export async function exportToGoogleSheets(ctx: Ctx, input: z.infer<typeof sheetsExportInput>) {
  if (!ctx.userId) throw unauthorized();
  await assertExportAllowed(ctx.userId); // F-139
  const st = await sheetsStatus(ctx.userId);
  if (!st.connected || !st.accountId) throw new ApiError(409, "google_sheets_not_connected", "Google Sheets 권한을 먼저 연결하세요.");
  const contacts = await contactsForExport(ctx.userId, { tag: input.tag, since: input.since, until: input.until });
  const header = input.fields;
  const rows = contacts.map((c) =>
    header.map((f) => {
      if (f === "tags") return c.tags.join(";");
      if (f === "lastContactAt") return c.lastContactAt ? new Date(c.lastContactAt).toISOString() : "";
      const v = (c as Record<string, unknown>)[f];
      return v == null ? "" : String(v);
    }),
  );
  const token = await googleAccessToken(st.accountId);
  const title = `LINKOS 연락처 ${new Date().toISOString().slice(0, 10)}`;
  const created = await fetch(gurl("sheets", "/spreadsheets"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ properties: { title, locale: "ko_KR" }, sheets: [{ properties: { title: "Contacts", gridProperties: { frozenRowCount: 1 } } }] }),
  });
  if (!created.ok) throw new ApiError(created.status === 401 || created.status === 403 ? 409 : 502, `google_sheets_${created.status}`, "Google Sheets 파일을 만들지 못했습니다.");
  const sheet = (await created.json()) as { spreadsheetId: string; spreadsheetUrl: string };
  const write = await fetch(gurl("sheets", `/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values/Contacts!A1?valueInputOption=RAW`), {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ range: "Contacts!A1", majorDimension: "ROWS", values: [header, ...rows] }),
  });
  if (!write.ok) throw new ApiError(502, `google_sheets_${write.status}`, "Google Sheets에 데이터를 쓰지 못했습니다.");
  const job = await one<{ id: string }>("INSERT INTO export_jobs (user_id, format, fields, kind, status) VALUES ($1,'google_sheets',$2,$3,'done') RETURNING id", [ctx.userId, header, `sheets:${sheet.spreadsheetId}`]);
  await q(
    `INSERT INTO external_mappings (integration_account_id, entity_type, local_id, external_id) VALUES ($1,'export_sheet',$2,$3)
     ON CONFLICT (integration_account_id, entity_type, local_id) DO NOTHING`,
    [st.accountId, job!.id, sheet.spreadsheetId],
  );
  await audit(pool(), ctx, "export.google_sheets", "export_job", job!.id, { rows: rows.length, fields: header });
  return { id: job!.id, spreadsheetId: sheet.spreadsheetId, url: sheet.spreadsheetUrl, rows: rows.length };
}

// ---------- Google Drive (F-116) ----------
/** Finds (or creates) the app-owned "LINKOS" folder. drive.file only sees files/folders this app created. */
async function driveFolder(accountId: string, token: string): Promise<string> {
  const map = await one<{ external_id: string }>("SELECT external_id FROM external_mappings WHERE integration_account_id=$1 AND entity_type='drive_folder' AND local_id=$1", [accountId]);
  if (map) {
    const chk = await fetch(gurl("drive", `/files/${encodeURIComponent(map.external_id)}?fields=id,trashed`), { headers: { authorization: `Bearer ${token}` } });
    if (chk.ok && !((await chk.json()) as { trashed?: boolean }).trashed) return map.external_id;
  }
  const created = await fetch(gurl("drive", "/files?fields=id"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "LINKOS", mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!created.ok) throw new ApiError(created.status === 401 || created.status === 403 ? 409 : 502, `google_drive_${created.status}`, "Google Drive 폴더를 만들지 못했습니다.");
  const { id } = (await created.json()) as { id: string };
  await q(
    `INSERT INTO external_mappings (integration_account_id, entity_type, local_id, external_id, last_synced_at) VALUES ($1,'drive_folder',$1,$2,now())
     ON CONFLICT (integration_account_id, entity_type, local_id) DO UPDATE SET external_id=EXCLUDED.external_id, last_synced_at=now()`,
    [accountId, id],
  );
  return id;
}

export const driveSaveInput = exportInput;
/** Render an export (any file format) and upload it into the user's LINKOS folder in Google Drive (multipart upload). */
export async function saveExportToDrive(ctx: Ctx, input: ExportInput) {
  if (!ctx.userId) throw unauthorized();
  const acct = await googleAccountWithScope(ctx.userId, GOOGLE_SCOPE.driveFile);
  if (!acct) throw new ApiError(409, "google_drive_not_connected", "Google Drive 권한을 먼저 연결하세요.");
  const job = await createExport(ctx, input);
  const file = await renderExport(ctx, job.id);
  const token = await googleAccessToken(acct.id);
  const folderId = await driveFolder(acct.id, token);
  const boundary = `linkos-${generateToken(16)}`;
  const meta = JSON.stringify({ name: file.filename, parents: [folderId], mimeType: file.contentType.split(";")[0] });
  const content = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, "utf8");
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${file.contentType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await fetch(gurl("driveUpload", "/files?uploadType=multipart&fields=id,name,webViewLink"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!up.ok) throw new ApiError(up.status === 401 || up.status === 403 ? 409 : 502, `google_drive_${up.status}`, "Google Drive에 파일을 저장하지 못했습니다.");
  const out = (await up.json()) as { id: string; name: string; webViewLink?: string };
  await q("UPDATE export_jobs SET status='done' WHERE id=$1", [job.id]);
  await q(
    `INSERT INTO external_mappings (integration_account_id, entity_type, local_id, external_id, remote_url, last_synced_at) VALUES ($1,'export_drive_file',$2,$3,$4,now())
     ON CONFLICT (integration_account_id, entity_type, local_id) DO NOTHING`,
    [acct.id, job.id, out.id, out.webViewLink ?? null],
  );
  await audit(pool(), ctx, "export.google_drive", "export_job", job.id, { format: input.format, fields: input.fields, bytes: content.length });
  return { id: job.id, fileId: out.id, name: out.name, url: out.webViewLink ?? `https://drive.google.com/file/d/${out.id}/view`, folderId };
}
