// comms module — communication-service: F-111 템플릿, F-104 AI 초안 → 메시지 초안, F-106 이메일 발송(명시적 승인 후에만),
// F-115 Gmail 초안, F-105 후속 시퀀스(초안만 생성), F-112 번역. 기본값은 항상 초안(draft) — 자동 발송 없음.
import {
  DEFAULT_SEQUENCE,
  TEMPLATE_VARIABLES,
  base64Url,
  buildMimeMessage,
  isSafeEmail,
  isValidTimeZone,
  renderTemplate,
  sequenceDueDates,
  shortMessage,
  splitName,
  templateVariables,
  validateTemplate,
} from "@linkos/domain";
import { z } from "zod";
import { one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized, unavailable } from "../lib/errors";
import { structured } from "../lib/llm";
import { sendMail } from "../lib/mail";
import { type Ctx, audit, log, rateLimit } from "../lib/platform";
import { draftFollowup } from "./assist";
import { loadProfile, primaryProfileId } from "./card";
import { graphBase, providerAccount, providerFetch } from "./crm";
import { GOOGLE_SCOPE, googleAccessToken, googleAccountWithScope, gurl } from "./integration";
import { getContactRow } from "./relationship";

// ---------- F-111 templates ----------
export const templateInput = z.object({
  name: z.string().trim().min(1).max(80),
  channel: z.enum(["email", "sms"]).default("email"),
  language: z.string().min(2).max(10).default("ko"),
  subject: z.string().max(200).nullish(),
  body: z.string().trim().min(1).max(5000),
  scope: z.enum(["user", "org"]).default("user"),
  organizationId: z.string().uuid().nullish(),
});

function templateDto(r: any, userId: string) {
  return { id: r.id, name: r.name, channel: r.channel, language: r.language, subject: r.subject, body: r.body, variables: r.variables, scope: r.scope, organizationId: r.organization_id, editable: r.owner_user_id === userId, updatedAt: r.updated_at };
}

async function assertOrgMember(userId: string, orgId: string) {
  const m = await one("SELECT 1 FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND status='active'", [orgId, userId]);
  if (!m) throw forbidden("조직 구성원만 팀 템플릿을 사용할 수 있습니다.");
}

export async function listTemplates(userId: string) {
  const rows = await q<any>(
    `SELECT t.* FROM message_templates t WHERE t.owner_user_id=$1
     UNION ALL
     SELECT t.* FROM message_templates t JOIN organization_members om ON om.organization_id=t.organization_id AND om.user_id=$1 AND om.status='active'
     WHERE t.scope='org' AND t.owner_user_id<>$1
     ORDER BY updated_at DESC LIMIT 200`,
    [userId],
  );
  return { variables: TEMPLATE_VARIABLES, templates: rows.map((r) => templateDto(r, userId)) };
}

export async function saveTemplate(ctx: Ctx, input: z.infer<typeof templateInput>, id?: string) {
  if (!ctx.userId) throw unauthorized();
  const v = validateTemplate([input.subject ?? "", input.body]);
  if (!v.ok) throw badRequest("unknown_variables", `알 수 없는 변수: ${v.unknown.join(", ")}`, v.unknown);
  if (input.scope === "org") {
    if (!input.organizationId) throw badRequest("organization_required");
    await assertOrgMember(ctx.userId, input.organizationId);
  }
  const vars = [...new Set([...templateVariables(input.subject ?? ""), ...templateVariables(input.body)])];
  const params = [ctx.userId, input.scope === "org" ? input.organizationId : null, input.scope, input.name, input.channel, input.language, input.subject ?? null, input.body, vars];
  const r = id
    ? await one<any>("UPDATE message_templates SET organization_id=$2, scope=$3, name=$4, channel=$5, language=$6, subject=$7, body=$8, variables=$9, updated_at=now() WHERE id=$10 AND owner_user_id=$1 RETURNING *", [...params, id])
    : await one<any>("INSERT INTO message_templates (owner_user_id, organization_id, scope, name, channel, language, subject, body, variables) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *", params);
  if (!r) throw notFound("template");
  await audit(pool(), ctx, id ? "template.updated" : "template.created", null, r.id, { scope: input.scope });
  return templateDto(r, ctx.userId);
}

export async function deleteTemplate(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one("DELETE FROM message_templates WHERE id=$1 AND owner_user_id=$2 RETURNING id", [id, ctx.userId]);
  if (!r) throw notFound("template");
  await audit(pool(), ctx, "template.deleted", null, id);
  return { ok: true };
}

async function templateFor(userId: string, id: string) {
  const t = await one<any>(
    `SELECT t.* FROM message_templates t WHERE t.id=$1 AND (t.owner_user_id=$2 OR (t.scope='org' AND EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id=t.organization_id AND om.user_id=$2 AND om.status='active')))`,
    [id, userId],
  );
  if (!t) throw notFound("template");
  return t;
}

/** Variables come only from the user's own records; unknown values stay empty and are reported as missing. */
async function variablesFor(userId: string, contactId: string | null) {
  const pid = await primaryProfileId(userId);
  const me = pid ? await loadProfile(pid) : null;
  const vars: Record<string, string | null> = { myName: me?.name ?? null, myCompany: me?.company ?? null, myTitle: me?.jobTitle ?? null, date: new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" }).format(new Date()) };
  if (contactId) {
    const c = await getContactRow(userId, contactId);
    const enc = await one<{ place_label: string | null }>("SELECT place_label FROM encounters WHERE owner_user_id=$1 AND contact_id=$2 ORDER BY occurred_at DESC LIMIT 1", [userId, contactId]);
    Object.assign(vars, { name: c.fullName, firstName: splitName(c.fullName).first || c.fullName, company: c.company, jobTitle: c.jobTitle, place: enc?.place_label ?? null });
  }
  return vars;
}

export const renderInput = z.object({ contactId: z.string().uuid().nullish(), extra: z.record(z.string(), z.string().max(200)).optional() });

export async function renderTemplateFor(ctx: Ctx, templateId: string, input: z.infer<typeof renderInput>) {
  if (!ctx.userId) throw unauthorized();
  const t = await templateFor(ctx.userId, templateId);
  const vars = { ...(await variablesFor(ctx.userId, input.contactId ?? null)), ...(input.extra ?? {}) };
  const s = renderTemplate(t.subject ?? "", vars);
  const b = renderTemplate(t.body, vars);
  return { templateId, channel: t.channel, language: t.language, subject: t.subject ? s.text : null, body: b.text, missing: [...new Set([...s.missing, ...b.missing])] };
}

// ---------- messages (drafts) ----------
export const messageInput = z.object({
  contactId: z.string().uuid().nullish(),
  followupId: z.string().uuid().nullish(),
  templateId: z.string().uuid().nullish(),
  channel: z.enum(["email", "sms"]).default("email"),
  toAddress: z.string().trim().max(254).nullish(),
  toName: z.string().trim().max(120).nullish(),
  subject: z.string().max(300).nullish(),
  body: z.string().trim().min(1).max(20000),
  language: z.string().min(2).max(10).default("ko"),
  provenance: z.enum(["user", "ai_inferred", "rules", "template"]).default("user"),
});

function messageDto(r: any) {
  return {
    id: r.id,
    contactId: r.contact_id,
    followupId: r.followup_id,
    templateId: r.template_id,
    channel: r.channel,
    toAddress: r.to_address,
    toName: r.to_name,
    subject: r.subject,
    body: r.body,
    language: r.language,
    provenance: r.provenance,
    status: r.status,
    provider: r.provider,
    providerMessageId: r.provider_message_id,
    gmailDraftId: r.provider === "gmail" ? r.provider_draft_id : null,
    error: r.error,
    approvedAt: r.approved_at,
    sentAt: r.sent_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    smsLink: r.channel === "sms" && r.to_address ? `sms:${encodeURIComponent(r.to_address)}?body=${encodeURIComponent(r.body)}` : null,
  };
}

export async function createMessage(ctx: Ctx, input: z.infer<typeof messageInput>) {
  if (!ctx.userId) throw unauthorized();
  let to = input.toAddress ?? null;
  let toName = input.toName ?? null;
  if (input.contactId) {
    const c = await getContactRow(ctx.userId, input.contactId);
    to ??= input.channel === "email" ? c.email : c.phone;
    toName ??= c.fullName;
  }
  if (input.templateId) await templateFor(ctx.userId, input.templateId);
  if (input.followupId && !(await one("SELECT 1 FROM followups WHERE id=$1 AND owner_user_id=$2", [input.followupId, ctx.userId]))) throw notFound("followup");
  if (to && input.channel === "email" && !isSafeEmail(to)) throw badRequest("invalid_recipient", "받는 사람 이메일 형식이 올바르지 않습니다.");
  const r = await one<any>(
    `INSERT INTO messages (owner_user_id, contact_id, followup_id, template_id, channel, to_address, to_name, subject, body, language, provenance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [ctx.userId, input.contactId ?? null, input.followupId ?? null, input.templateId ?? null, input.channel, to, toName, input.subject ?? null, input.body, input.language, input.provenance],
  );
  await audit(pool(), ctx, "message.draft_created", "message", r.id, { channel: input.channel, provenance: input.provenance });
  return messageDto(r);
}

/** F-104 → draft: AI(or rule) thank-you/check-in draft saved as a message draft (never sent automatically). */
export async function createAiDraft(ctx: Ctx, contactId: string, kind: "thank_you" | "check_in" | "send_material") {
  if (!ctx.userId) throw unauthorized();
  await rateLimit(`ai:draft:${ctx.userId}`, 30, 60);
  const d = await draftFollowup(ctx, contactId, kind);
  const msg = await createMessage(ctx, { contactId, channel: "email", subject: d.result.subject, body: d.result.body, language: "ko", provenance: d.provenance });
  return { ...msg, model: d.model, needsConfirmation: true };
}

export const messagePatch = z.object({ toAddress: z.string().trim().max(254).nullish(), subject: z.string().max(300).nullish(), body: z.string().trim().min(1).max(20000).optional() });

export async function updateMessage(ctx: Ctx, id: string, patch: z.infer<typeof messagePatch>) {
  if (!ctx.userId) throw unauthorized();
  if (patch.toAddress && !isSafeEmail(patch.toAddress) && !/^[+\d\s()-]{6,20}$/.test(patch.toAddress)) throw badRequest("invalid_recipient");
  const r = await one<any>(
    `UPDATE messages SET to_address=COALESCE($3,to_address), subject=COALESCE($4,subject), body=COALESCE($5,body), provenance = CASE WHEN $5::text IS NOT NULL AND provenance <> 'user' THEN 'user_edited' ELSE provenance END, updated_at=now()
     WHERE id=$1 AND owner_user_id=$2 AND status IN ('draft','failed') RETURNING *`,
    [id, ctx.userId, patch.toAddress ?? null, patch.subject ?? null, patch.body ?? null],
  );
  if (!r) throw conflict("not_editable", "보낸 메시지는 수정할 수 없습니다.");
  return messageDto(r);
}

export async function listMessages(userId: string, f: { contactId?: string; status?: string } = {}) {
  const params: unknown[] = [userId];
  let where = "owner_user_id=$1";
  if (f.contactId) {
    params.push(f.contactId);
    where += ` AND contact_id=$${params.length}`;
  }
  if (f.status) {
    params.push(f.status);
    where += ` AND status=$${params.length}`;
  }
  const rows = await q<any>(`SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT 100`, params);
  return rows.map(messageDto);
}

export async function getMessage(userId: string, id: string) {
  const r = await one<any>("SELECT * FROM messages WHERE id=$1 AND owner_user_id=$2", [id, userId]);
  if (!r) throw notFound("message");
  return messageDto(r);
}

export async function cancelMessage(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<any>("UPDATE messages SET status='cancelled', updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND status IN ('draft','failed') RETURNING *", [id, ctx.userId]);
  if (!r) throw conflict("not_cancellable");
  return messageDto(r);
}

// ---------- F-106 send (explicit approval) ----------
export const sendInput = z.object({
  approved: z.literal(true, { message: "발송하려면 사용자의 명시적 승인이 필요합니다." }),
  via: z.enum(["auto", "gmail", "outlook", "smtp"]).default("auto"),
});

export async function sendOptions(userId: string) {
  const gmail = await googleAccountWithScope(userId, GOOGLE_SCOPE.gmailSend);
  const gmailDrafts = await googleAccountWithScope(userId, GOOGLE_SCOPE.gmailCompose);
  const ms = await providerAccount(userId, "microsoft");
  return { gmail: Boolean(gmail), gmailDrafts: Boolean(gmailDrafts), outlook: Boolean(ms?.scopes.some((s) => /Mail\.Send/i.test(s))), smtp: Boolean(process.env.SMTP_URL) };
}

async function gmailSend(userId: string, raw: string): Promise<string> {
  const acct = await googleAccountWithScope(userId, GOOGLE_SCOPE.gmailSend);
  if (!acct) throw new ApiError(409, "gmail_not_connected", "Gmail 발송 권한을 먼저 연결하세요.");
  const token = await googleAccessToken(acct.id);
  const res = await fetch(gurl("gmail", "/users/me/messages/send"), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ raw: base64Url(raw) }) });
  if (!res.ok) throw new ApiError(res.status === 401 || res.status === 403 ? 409 : 502, `gmail_${res.status}`, `Gmail 발송 실패 (${res.status})`);
  return ((await res.json()) as { id: string }).id;
}

async function outlookSend(userId: string, m: { to: string; toName: string | null; subject: string; body: string }): Promise<string | null> {
  const a = await providerAccount(userId, "microsoft");
  if (!a || !a.scopes.some((s) => /Mail\.Send/i.test(s))) throw new ApiError(409, "outlook_not_connected", "Outlook 메일 권한을 먼저 연결하세요.");
  const res = await providerFetch(a, `${graphBase()}/me/sendMail`, {
    method: "POST",
    body: JSON.stringify({ message: { subject: m.subject, body: { contentType: "Text", content: m.body }, toRecipients: [{ emailAddress: { address: m.to, name: m.toName ?? m.to } }] }, saveToSentItems: true }),
  });
  if (res.status !== 202 && !res.ok) throw new ApiError(502, `graph_${res.status}`, `Outlook 발송 실패 (${res.status})`);
  return res.headers.get("request-id");
}

export async function sendMessage(ctx: Ctx, id: string, input: z.infer<typeof sendInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await rateLimit(`mail:send:${userId}`, 30, 3600);
  const pre = await one<any>("SELECT * FROM messages WHERE id=$1 AND owner_user_id=$2", [id, userId]);
  if (!pre) throw notFound("message");
  if (pre.status === "sent") return messageDto(pre); // idempotent: a second click never sends twice
  if (pre.channel !== "email") throw badRequest("channel_not_sendable", "SMS/메신저 초안은 휴대폰 앱에서 직접 보내세요.");
  if (!pre.to_address || !isSafeEmail(pre.to_address)) throw badRequest("invalid_recipient", "받는 사람 이메일을 확인하세요.");
  if (!pre.subject?.trim()) throw badRequest("subject_required", "제목을 입력하세요.");
  const opts = await sendOptions(userId);
  const via = input.via === "auto" ? (opts.gmail ? "gmail" : opts.outlook ? "outlook" : opts.smtp ? "smtp" : null) : input.via;
  if (!via) throw unavailable("no_mail_channel", "메일을 보낼 수 있는 연동(Gmail/Outlook)이나 SMTP가 없습니다. 초안을 메일 앱에서 열어 보내세요.");
  // claim: draft/failed → sending (concurrent approvals cannot both send)
  const m = await one<any>("UPDATE messages SET status='sending', approved_at=now(), approved_by=$2, provider=$3, updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND status IN ('draft','failed') RETURNING *", [id, userId, via]);
  if (!m) throw conflict("message_not_sendable", "이미 발송 중이거나 취소된 메시지입니다.");
  try {
    let providerId: string | null = null;
    const me = await one<{ email: string | null; name: string | null }>("SELECT u.email, (SELECT name FROM profiles WHERE user_id=u.id ORDER BY is_primary DESC LIMIT 1) AS name FROM users u WHERE u.id=$1", [userId]);
    if (via === "gmail") providerId = await gmailSend(userId, buildMimeMessage({ to: m.to_address, toName: m.to_name, subject: m.subject, body: m.body, messageId: `${m.id}@linkos.app` }));
    else if (via === "outlook") providerId = await outlookSend(userId, { to: m.to_address, toName: m.to_name, subject: m.subject, body: m.body });
    else {
      const ok = await sendMail(m.to_address, m.subject, m.body, { replyTo: me?.email ?? null, fromName: me?.name ?? null, messageId: `<${m.id}@linkos.app>` });
      if (!ok) throw unavailable("mail_not_configured", "SMTP가 설정되지 않았습니다.");
      providerId = `${m.id}@linkos.app`;
    }
    const sent = await tx(async (c) => {
      const r = await one<any>("UPDATE messages SET status='sent', provider_message_id=$2, sent_at=now(), error=NULL, updated_at=now() WHERE id=$1 RETURNING *", [id, providerId], c);
      if (m.contact_id) await c.query("UPDATE relationships SET last_contact_at=now() WHERE owner_user_id=$1 AND contact_id=$2", [userId, m.contact_id]);
      if (m.followup_id) await c.query("UPDATE followups SET status='done', completed_at=now() WHERE id=$1 AND owner_user_id=$2 AND status='open'", [m.followup_id, userId]);
      await audit(c, ctx, "message.sent", "message", id, { provider: via, approved: true, channel: "email" });
      return r;
    });
    if (via === "gmail" && m.provider_draft_id) await deleteGmailDraft(userId, m.provider_draft_id).catch(() => undefined);
    log("info", "message.sent", { message: id, provider: via });
    return messageDto(sent);
  } catch (e) {
    await q("UPDATE messages SET status='failed', error=$2, updated_at=now() WHERE id=$1", [id, (e as Error).message.slice(0, 300)]);
    await audit(pool(), ctx, "message.send_failed", "message", id, { provider: via, code: (e as ApiError).code ?? "error" });
    throw e instanceof ApiError ? e : new ApiError(502, "send_failed", "메일을 보내지 못했습니다. 잠시 후 다시 시도하세요.");
  }
}

// ---------- F-115 Gmail drafts ----------
async function deleteGmailDraft(userId: string, draftId: string) {
  const acct = await googleAccountWithScope(userId, GOOGLE_SCOPE.gmailCompose);
  if (!acct) return;
  const token = await googleAccessToken(acct.id);
  await fetch(gurl("gmail", `/users/me/drafts/${encodeURIComponent(draftId)}`), { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
}

/** Creates (or updates) the draft in the user's Gmail Drafts folder. Nothing is sent. */
export async function saveGmailDraft(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const m = await one<any>("SELECT * FROM messages WHERE id=$1 AND owner_user_id=$2", [id, ctx.userId]);
  if (!m) throw notFound("message");
  if (m.status !== "draft") throw conflict("not_draft");
  if (m.channel !== "email" || !m.to_address || !isSafeEmail(m.to_address)) throw badRequest("invalid_recipient", "받는 사람 이메일을 확인하세요.");
  const acct = await googleAccountWithScope(ctx.userId, GOOGLE_SCOPE.gmailCompose);
  if (!acct) throw new ApiError(409, "gmail_not_connected", "Gmail 초안 권한을 먼저 연결하세요.");
  const token = await googleAccessToken(acct.id);
  const raw = base64Url(buildMimeMessage({ to: m.to_address, toName: m.to_name, subject: m.subject ?? "", body: m.body }));
  const existing = m.provider === "gmail" ? m.provider_draft_id : null;
  const res = await fetch(gurl("gmail", existing ? `/users/me/drafts/${encodeURIComponent(existing)}` : "/users/me/drafts"), {
    method: existing ? "PUT" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...(existing ? { id: existing } : {}), message: { raw } }),
  });
  if (!res.ok) throw new ApiError(res.status === 401 || res.status === 403 ? 409 : 502, `gmail_${res.status}`, `Gmail 초안 저장 실패 (${res.status})`);
  const d = (await res.json()) as { id: string };
  const r = await one<any>("UPDATE messages SET provider='gmail', provider_draft_id=$2, updated_at=now() WHERE id=$1 RETURNING *", [id, d.id]);
  await audit(pool(), ctx, "message.gmail_draft_saved", "message", id, {});
  return { ...messageDto(r), gmailUrl: `https://mail.google.com/mail/u/0/#drafts` };
}

// ---------- F-105 follow-up sequences ----------
export const sequenceInput = z.object({
  contactId: z.string().uuid(),
  name: z.string().trim().max(80).default("후속 시퀀스"),
  timezone: z.string().max(60).refine(isValidTimeZone).default("Asia/Seoul"),
  steps: z
    .array(z.object({ dayOffset: z.number().int().min(0).max(180), kind: z.enum(["thank_you", "check_in", "send_material", "meeting_request", "custom"]), channel: z.enum(["email", "sms"]), templateId: z.string().uuid().optional() }))
    .min(1)
    .max(6)
    .default(DEFAULT_SEQUENCE),
});

const KIND_TITLES: Record<string, string> = { thank_you: "감사 인사", check_in: "안부 연락", send_material: "자료 전달", meeting_request: "미팅 제안", custom: "후속 연락" };

/** Creates follow-up reminders + drafts for every step. Nothing is ever sent automatically; each step needs approval. */
export async function createSequence(ctx: Ctx, input: z.infer<typeof sequenceInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const contact = await getContactRow(userId, input.contactId);
  const dues = sequenceDueDates(new Date(), input.steps.map((s) => s.dayOffset), input.timezone);
  // drafts are generated before the transaction (LLM/network work must not hold a DB transaction open)
  const drafts: { subject: string; body: string; provenance: string }[] = [];
  for (const s of input.steps) {
    if (s.templateId) {
      const t = await renderTemplateFor(ctx, s.templateId, { contactId: input.contactId });
      drafts.push({ subject: t.subject ?? KIND_TITLES[s.kind]!, body: t.body, provenance: "template" });
    } else if (s.kind === "thank_you" || s.kind === "check_in" || s.kind === "send_material") {
      const d = await draftFollowup(ctx, input.contactId, s.kind);
      drafts.push({ subject: d.result.subject, body: d.result.body, provenance: d.provenance });
    } else {
      const me = await variablesFor(userId, input.contactId);
      drafts.push({ subject: KIND_TITLES[s.kind]!, body: `${contact.fullName}님, 안녕하세요.\n편하신 시간에 짧게 이야기 나눌 수 있을까요?${me.myName ? `\n\n${me.myName} 드림` : ""}`, provenance: "rules" });
    }
  }
  return tx(async (c) => {
    const seq = await one<{ id: string }>("INSERT INTO followup_sequences (owner_user_id, contact_id, name) VALUES ($1,$2,$3) RETURNING id", [userId, input.contactId, input.name], c);
    const steps = [];
    for (let i = 0; i < input.steps.length; i++) {
      const s = input.steps[i]!;
      const d = drafts[i]!;
      const body = s.channel === "sms" ? shortMessage(d.body.replace(/\n+/g, " "), 90) : d.body;
      const f = await one<{ id: string }>(
        "INSERT INTO followups (owner_user_id, contact_id, kind, title, body_draft, due_at, source, sequence_id, sequence_step, channel) VALUES ($1,$2,$3,$4,$5,$6,'sequence',$7,$8,$9) RETURNING id",
        [userId, input.contactId, s.kind === "meeting_request" ? "meeting_request" : s.kind, `${KIND_TITLES[s.kind]} · ${contact.fullName}`, body, dues[i], seq!.id, i, s.channel],
        c,
      );
      const msg = await one<any>(
        `INSERT INTO messages (owner_user_id, contact_id, followup_id, template_id, channel, to_address, to_name, subject, body, provenance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [userId, input.contactId, f!.id, s.templateId ?? null, s.channel, s.channel === "email" ? contact.email : contact.phone, contact.fullName, s.channel === "email" ? d.subject : null, body, d.provenance],
        c,
      );
      steps.push({ step: i, dueAt: dues[i], channel: s.channel, kind: s.kind, followupId: f!.id, message: messageDto(msg) });
    }
    if (dues[0]) await c.query("UPDATE relationships SET next_followup_at=$3 WHERE owner_user_id=$1 AND contact_id=$2", [userId, input.contactId, dues.find((d) => d > new Date()) ?? dues[0]]);
    await audit(c, ctx, "followup.sequence_created", "contact", input.contactId, { steps: steps.length });
    return { id: seq!.id, name: input.name, status: "active", steps };
  });
}

export async function listSequences(userId: string, contactId?: string) {
  const rows = await q<any>(
    `SELECT s.id, s.name, s.status, s.contact_id, s.created_at, c.full_name,
       (SELECT json_agg(json_build_object('followupId', f.id, 'step', f.sequence_step, 'dueAt', f.due_at, 'status', f.status, 'channel', f.channel, 'title', f.title) ORDER BY f.sequence_step) FROM followups f WHERE f.sequence_id=s.id) AS steps
     FROM followup_sequences s JOIN contacts c ON c.id=s.contact_id WHERE s.owner_user_id=$1 ${contactId ? "AND s.contact_id=$2" : ""} ORDER BY s.created_at DESC LIMIT 50`,
    contactId ? [userId, contactId] : [userId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, contact: { id: r.contact_id, fullName: r.full_name }, steps: r.steps ?? [], createdAt: r.created_at }));
}

export async function cancelSequence(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  return tx(async (c) => {
    const s = await one("UPDATE followup_sequences SET status='cancelled' WHERE id=$1 AND owner_user_id=$2 AND status='active' RETURNING id", [id, userId], c);
    if (!s) throw notFound("sequence");
    await c.query("UPDATE followups SET status='dismissed', completed_at=now() WHERE sequence_id=$1 AND status='open'", [id]);
    await c.query("UPDATE messages SET status='cancelled', updated_at=now() WHERE followup_id IN (SELECT id FROM followups WHERE sequence_id=$1) AND status IN ('draft','failed')", [id]);
    await audit(c, ctx, "followup.sequence_cancelled", null, id);
    return { id, status: "cancelled" };
  });
}

// ---------- F-112 translation ----------
export const LANGS = { ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese (Simplified)", vi: "Vietnamese", es: "Spanish", fr: "French", de: "German" } as const;
export const translateInput = z
  .object({
    target: z.enum(Object.keys(LANGS) as [keyof typeof LANGS, ...(keyof typeof LANGS)[]]),
    text: z.string().max(10000).optional(),
    messageId: z.string().uuid().optional(),
    profileId: z.string().uuid().optional(),
    saveAsDraft: z.boolean().default(false),
  })
  .refine((v) => [v.text, v.messageId, v.profileId].filter(Boolean).length === 1, "text, messageId, profileId 중 하나만 지정하세요.");

const TranslateSchema = z.object({ items: z.array(z.object({ key: z.string(), text: z.string() })) });

export async function translate(ctx: Ctx, input: z.infer<typeof translateInput>) {
  if (!ctx.userId) throw unauthorized();
  await rateLimit(`ai:translate:${ctx.userId}`, 30, 60);
  let items: { key: string; text: string }[] = [];
  let message: any = null;
  if (input.text) items = [{ key: "text", text: input.text }];
  if (input.messageId) {
    message = await one<any>("SELECT * FROM messages WHERE id=$1 AND owner_user_id=$2", [input.messageId, ctx.userId]);
    if (!message) throw notFound("message");
    items = [{ key: "subject", text: message.subject ?? "" }, { key: "body", text: message.body }].filter((i) => i.text);
  }
  if (input.profileId) {
    const p = await loadProfile(input.profileId);
    // own card, or a card of someone already in my contacts (business-visible fields only)
    const allowed = p && (p.userId === ctx.userId || (await one("SELECT 1 FROM contacts WHERE owner_user_id=$1 AND linked_user_id=$2 AND deleted_at IS NULL", [ctx.userId, p.userId])));
    if (!p || !allowed) throw notFound("profile");
    items = [
      { key: "jobTitle", text: p.jobTitle ?? "" },
      { key: "headline", text: p.headline ?? "" },
      { key: "bioShort", text: p.bioShort ?? "" },
      ...p.offers.map((o, i) => ({ key: `offer.${i}`, text: o.text })),
      ...p.needs.map((n, i) => ({ key: `need.${i}`, text: n.text })),
    ].filter((i) => i.text);
  }
  const llm = await structured({
    schema: TranslateSchema,
    task: `Translate each item's text into ${LANGS[input.target]} for a business context. Keep person names, company names, product names, email addresses, phone numbers and URLs unchanged. Do not add or remove information. Return every key exactly once.`,
    data: JSON.stringify(items),
    promptVersion: "translate-1",
    ownerUserId: ctx.userId,
    kind: "translate",
    sourceIds: [input.messageId ?? input.profileId ?? "text"],
  });
  const ok = Boolean(llm && items.every((i) => llm.output.items.some((o) => o.key === i.key)));
  const out = Object.fromEntries((ok ? llm!.output.items : items).map((i) => [i.key, i.text]));
  const result = {
    target: input.target,
    provenance: ok ? ("ai_inferred" as const) : ("none" as const),
    model: ok ? llm!.model : null,
    translated: ok,
    notice: ok ? "AI 번역 · 보내기 전에 확인하세요." : "번역 엔진을 사용할 수 없어 원문을 그대로 표시합니다.",
    items: out,
    needsConfirmation: true,
    draft: null as ReturnType<typeof messageDto> | null,
  };
  if (ok && input.saveAsDraft && message) {
    result.draft = await createMessage(ctx, { contactId: message.contact_id, channel: message.channel, toAddress: message.to_address, toName: message.to_name, subject: out.subject ?? message.subject, body: out.body ?? message.body, language: input.target, provenance: "ai_inferred" });
  }
  return result;
}
