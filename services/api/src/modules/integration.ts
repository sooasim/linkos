// integration module — Google OAuth/People API 동기화(idempotent, 사용자별 직렬 처리, external etag 매핑) + Export(CSV/vCard/XLSX/TXT/JSON)
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generateToken, toCsv, toVCard } from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, notFound, unauthorized, unavailable } from "../lib/errors";
import { type Ctx, appOrigin, audit, emit, hmac, log } from "../lib/platform";
import { recordConsents } from "./identity";
import { listContacts } from "./relationship";

// ---------- credential vault (AES-256-GCM) ----------
function key(): Buffer {
  const k = process.env.CREDENTIALS_KEY;
  if (!k) {
    if (process.env.NODE_ENV === "production") throw unavailable("vault_not_configured", "CREDENTIALS_KEY 가 설정되지 않았습니다.");
    return Buffer.alloc(32, 7);
  }
  const b = Buffer.from(k, "base64");
  if (b.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes base64");
  return b;
}
export function seal(obj: unknown): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
export function unseal<T>(buf: Buffer): T {
  const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")) as T;
}

// ---------- Google ----------
const GOOGLE_SCOPES_LOGIN = ["openid", "email", "profile"];
const GOOGLE_SCOPES_CONTACTS = ["https://www.googleapis.com/auth/contacts"];
// drive.file: the app can only see spreadsheets it created (least privilege for F-116/F-117)
const GOOGLE_SCOPES_SHEETS = ["https://www.googleapis.com/auth/drive.file"];
export type GooglePurpose = "login" | "contacts" | "sheets";

/** Endpoint bases are overridable so integration tests can run against a local fake Google (GOOGLE_API_BASE). */
export function gurl(kind: "auth" | "token" | "userinfo" | "people" | "sheets", path = ""): string {
  const fake = process.env.GOOGLE_API_BASE?.replace(/\/$/, "");
  if (fake) return `${fake}/${kind}${path}`;
  const base = {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    people: "https://people.googleapis.com/v1",
    sheets: "https://sheets.googleapis.com/v4",
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
    scope: [...GOOGLE_SCOPES_LOGIN, ...(purpose === "contacts" ? GOOGLE_SCOPES_CONTACTS : purpose === "sheets" ? GOOGLE_SCOPES_SHEETS : [])].join(" "),
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

async function googleAccessToken(accountId: string, db: Db = pool()): Promise<string> {
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

export async function integrationStatus(userId: string) {
  const accounts = await q<any>("SELECT id, provider, scopes, status, updated_at FROM integration_accounts WHERE user_id=$1", [userId]);
  const jobs = await q<any>(
    `SELECT j.id, j.job_type, j.status, j.attempt_count, j.last_error, j.scheduled_at, j.finished_at FROM sync_jobs j JOIN integration_accounts a ON a.id=j.integration_account_id
     WHERE a.user_id=$1 ORDER BY j.scheduled_at DESC LIMIT 20`,
    [userId],
  );
  const sheets = await sheetsStatus(userId);
  return { googleConfigured: googleEnabled(), accounts, jobs, sheetsConnected: sheets.connected };
}

/** POST /integrations/google/contacts/sync — enqueue one idempotent job per contact (version-keyed). */
export async function enqueueGoogleContactSync(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  const acct = await one<{ id: string; status: string }>("SELECT id, status FROM integration_accounts WHERE user_id=$1 AND provider='google'", [ctx.userId]);
  if (!acct || acct.status !== "active") throw new ApiError(409, "google_not_connected", "Google 계정을 먼저 연결하세요.");
  const contacts = await q<{ id: string; version: number }>("SELECT id, version FROM contacts WHERE owner_user_id=$1 AND deleted_at IS NULL AND merged_into_id IS NULL", [ctx.userId]);
  let queued = 0;
  for (const c of contacts) {
    const r = await q(
      `INSERT INTO sync_jobs (integration_account_id, job_type, payload, idempotency_key) VALUES ($1,'google.contact.upsert',$2,$3)
       ON CONFLICT (integration_account_id, idempotency_key) DO NOTHING RETURNING id`,
      [acct.id, JSON.stringify({ contactId: c.id }), `contact:${c.id}:v${c.version}`],
    );
    queued += r.length;
  }
  await audit(pool(), ctx, "integration.google.sync_requested", "integration_account", acct.id, { queued });
  return { queued, total: contacts.length };
}

/** Worker: process queued jobs. Jobs of the same account run serially (People API mutation guidance). */
export async function processSyncJobs(limit = 20): Promise<number> {
  const accounts = await q<{ integration_account_id: string }>(
    "SELECT DISTINCT integration_account_id FROM sync_jobs WHERE status IN ('queued','retry') AND scheduled_at <= now() LIMIT 10",
  );
  let done = 0;
  for (const { integration_account_id } of accounts) {
    const lock = await one<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [integration_account_id]);
    if (!lock?.ok) continue;
    try {
      const jobs = await q<any>("SELECT * FROM sync_jobs WHERE integration_account_id=$1 AND status IN ('queued','retry') AND scheduled_at <= now() ORDER BY scheduled_at LIMIT $2", [integration_account_id, limit]);
      for (const job of jobs) {
        try {
          await runGoogleUpsert(integration_account_id, job.payload.contactId);
          await q("UPDATE sync_jobs SET status='done', finished_at=now(), attempt_count=attempt_count+1 WHERE id=$1", [job.id]);
          done++;
        } catch (e) {
          const attempts = job.attempt_count + 1;
          const dead = attempts >= 6;
          await q("UPDATE sync_jobs SET status=$2, attempt_count=$3, last_error=$4, scheduled_at = now() + ($5 || ' seconds')::interval WHERE id=$1", [
            job.id,
            dead ? "dead" : "retry",
            attempts,
            (e as Error).message.slice(0, 300),
            String(2 ** attempts * 15),
          ]);
          if (dead) await emit(pool(), "integration.sync.failed", "sync_job", job.id, { provider: "google", job_id: job.id, error_class: (e as ApiError).code ?? "error" });
          log("warn", "sync.job_failed", { job: job.id, attempts });
        }
      }
    } finally {
      await q("SELECT pg_advisory_unlock(hashtext($1))", [integration_account_id]);
    }
  }
  return done;
}

async function runGoogleUpsert(accountId: string, contactId: string) {
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
    // never blindly overwrite: send the stored etag; Google rejects if the remote changed (conflict surfaced to user)
    res = await fetch(`${gurl("people")}/${map.external_id}:updateContact?updatePersonFields=names,organizations,emailAddresses,phoneNumbers,urls`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...person, etag: map.external_etag }),
    });
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
    `INSERT INTO external_mappings (integration_account_id, entity_type, local_id, external_id, external_etag) VALUES ($1,'contact',$2,$3,$4)
     ON CONFLICT (integration_account_id, entity_type, local_id) DO UPDATE SET external_id=EXCLUDED.external_id, external_etag=EXCLUDED.external_etag`,
    [accountId, contactId, out.resourceName, out.etag],
  );
}

export async function disconnectGoogle(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  await q("UPDATE integration_accounts SET status='revoked', encrypted_credentials=NULL, updated_at=now() WHERE user_id=$1 AND provider='google'", [ctx.userId]);
  await recordConsents(pool(), ctx.userId, [{ type: "integration_google", granted: false }]);
  await audit(pool(), ctx, "integration.google.disconnected", "integration_account", null);
}

// ---------- Export ----------
export const EXPORT_FORMATS = ["csv", "xlsx", "docx", "vcard", "txt", "json"] as const;
export const EXPORT_FIELDS = ["fullName", "company", "jobTitle", "department", "email", "phone", "address", "website", "tags", "lastContactAt", "source"] as const;
export const exportInput = z.object({
  format: z.enum(EXPORT_FORMATS),
  fields: z.array(z.enum(EXPORT_FIELDS)).min(1).default(["fullName", "company", "jobTitle", "email", "phone"]),
  tag: z.string().max(40).optional(),
});

export async function createExport(ctx: Ctx, input: z.infer<typeof exportInput>) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<{ id: string }>("INSERT INTO export_jobs (user_id, format, fields, kind) VALUES ($1,$2,$3,$4) RETURNING id", [ctx.userId, input.format, input.fields, input.tag ? `contacts:tag:${input.tag}` : "contacts"]);
  await audit(pool(), ctx, "export.created", "export_job", r!.id, { format: input.format, fields: input.fields });
  return { id: r!.id, status: "ready", downloadUrl: `/api/v1/exports/${r!.id}/download` };
}

export async function renderExport(ctx: Ctx, id: string): Promise<{ body: Buffer | string; contentType: string; filename: string }> {
  if (!ctx.userId) throw unauthorized();
  const job = await one<{ format: (typeof EXPORT_FORMATS)[number]; fields: string[]; kind: string; expires_at: Date }>("SELECT format, fields, kind, expires_at FROM export_jobs WHERE id=$1 AND user_id=$2", [id, ctx.userId]);
  if (!job) throw notFound("export");
  if (job.expires_at.getTime() < Date.now()) throw new ApiError(410, "export_expired");
  const tag = job.kind.startsWith("contacts:tag:") ? job.kind.slice(13) : undefined;
  const contacts = await listContacts(ctx.userId, { limit: 200, tag });
  const rows = contacts.map((c) => {
    const r: Record<string, unknown> = {};
    for (const f of job.fields) r[f] = f === "tags" ? c.tags.join(";") : f === "lastContactAt" ? (c.lastContactAt ? new Date(c.lastContactAt).toISOString() : "") : (c as Record<string, unknown>)[f];
    return r;
  });
  await audit(pool(), ctx, "export.downloaded", "export_job", id, { rows: rows.length });
  const stamp = new Date().toISOString().slice(0, 10);
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
export const sheetsExportInput = exportInput.omit({ format: true });
export async function exportToGoogleSheets(ctx: Ctx, input: z.infer<typeof sheetsExportInput>) {
  if (!ctx.userId) throw unauthorized();
  const st = await sheetsStatus(ctx.userId);
  if (!st.connected || !st.accountId) throw new ApiError(409, "google_sheets_not_connected", "Google Sheets 권한을 먼저 연결하세요.");
  const contacts = await listContacts(ctx.userId, { limit: 200, tag: input.tag });
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
