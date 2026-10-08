// assist module — AI 프로필 요약(F-091), 회의 요약·To-do·약속·일정 후보 추출(F-084~F-087), 감사메일 초안(F-104).
// 모든 결과는 "제안(suggestion)"이며 provenance=ai_inferred|rules, 사용자가 확인해야 저장된다(F-102 Human Confirmation).
import { z } from "zod";
import { one, q } from "../lib/db";
import { notFound, unauthorized } from "../lib/errors";
import { LLM_MODEL, structured } from "../lib/llm";
import type { Ctx } from "../lib/platform";
import { loadProfile } from "./card";
import { getContactRow } from "./relationship";

export interface Provenanced<T> {
  result: T;
  provenance: "ai_inferred" | "rules";
  model: string;
  needsConfirmation: true;
}

// ---------- F-091 profile summary ----------
const SummarySchema = z.object({ summary: z.string(), highlights: z.array(z.string()) });

export async function summarizeProfile(ctx: Ctx, profileId: string): Promise<Provenanced<z.infer<typeof SummarySchema>>> {
  if (!ctx.userId) throw unauthorized();
  const p = await loadProfile(profileId);
  if (!p) throw notFound("profile");
  // Only owner or people with a relationship may summarize; uses the business-visible projection only.
  const allowed = p.userId === ctx.userId || (await one("SELECT 1 FROM contacts WHERE owner_user_id=$1 AND linked_user_id=$2 AND deleted_at IS NULL", [ctx.userId, p.userId]));
  if (!allowed) throw notFound("profile");
  const visible = p.fields.filter((f) => f.visibility === "public" || f.visibility === "business");
  const data = JSON.stringify({ name: p.name, company: p.company, jobTitle: p.jobTitle, headline: p.headline, bio: p.bioShort, keywords: p.keywords, offers: p.offers.map((o) => o.text), needs: p.needs.map((n) => n.text), industries: p.industries, projects: (p.deep as any)?.projects ?? [], contactTypes: visible.map((f) => f.type) });
  const llm = await structured({
    schema: SummarySchema,
    task: "Write a 2-sentence business summary of this person and up to 3 short highlights a new contact should know. Use only the data.",
    data,
    promptVersion: "profile-summary-1",
    ownerUserId: ctx.userId,
    kind: "profile_summary",
    sourceIds: [profileId],
  });
  if (llm) return { result: llm.output, provenance: "ai_inferred", model: llm.model, needsConfirmation: true };
  const role = [p.company, p.jobTitle].filter(Boolean).join(" ");
  const summary = [`${p.name}${role ? ` — ${role}` : ""}.`, p.headline ?? p.bioShort ?? ""].filter(Boolean).join(" ").trim();
  const highlights = [
    ...(p.offers.length ? [`제공: ${p.offers.map((o) => o.text).slice(0, 2).join(", ")}`] : []),
    ...(p.needs.length ? [`필요: ${p.needs.map((n) => n.text).slice(0, 2).join(", ")}`] : []),
    ...(p.keywords.length ? [`키워드: ${p.keywords.join(", ")}`] : []),
  ].slice(0, 3);
  return { result: { summary, highlights }, provenance: "rules", model: "rules-v1", needsConfirmation: true };
}

// ---------- F-084~F-087 meeting extraction ----------
const MeetingExtractSchema = z.object({
  summary: z.string(),
  decisions: z.array(z.string()),
  promises: z.array(z.object({ text: z.string(), by: z.enum(["me", "them"]) })),
  actionItems: z.array(z.object({ description: z.string(), dueHint: z.string() })),
  nextMeetingHint: z.string(),
});
export type MeetingExtract = z.infer<typeof MeetingExtractSchema>;

const RULES: [keyof Omit<MeetingExtract, "summary" | "nextMeetingHint">, RegExp][] = [
  ["decisions", /^(?:[-*•]\s*)?(?:결정|합의|decision|decided)\s*[:：]?\s*(.+)$/i],
  ["actionItems", /^(?:[-*•]\s*)?(?:할\s*일|todo|to-do|action|액션)\s*[:：]?\s*(.+)$/i],
  ["promises", /^(?:[-*•]\s*)?(?:약속|promise)\s*[:：]?\s*(.+)$/i],
];

/** Rule-based extraction: only lines explicitly marked (결정:/할 일:/약속:/다음 미팅:). Never fabricates. */
export function extractMeetingRules(text: string): MeetingExtract {
  const out: MeetingExtract = { summary: "", decisions: [], promises: [], actionItems: [], nextMeetingHint: "" };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const next = line.match(/^(?:[-*•]\s*)?(?:다음\s*(?:미팅|회의|일정)|next meeting)\s*[:：]?\s*(.+)$/i);
    if (next) {
      out.nextMeetingHint = next[1]!.trim();
      continue;
    }
    for (const [key, re] of RULES) {
      const m = line.match(re);
      if (!m) continue;
      const v = m[1]!.trim();
      if (key === "decisions") out.decisions.push(v);
      else if (key === "promises") out.promises.push({ text: v, by: /(상대|그쪽|they|them)/i.test(v) ? "them" : "me" });
      else {
        const due = v.match(/(\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|오늘|내일|모레|이번\s*주|다음\s*주|금요일|월요일)/);
        out.actionItems.push({ description: v, dueHint: due?.[1] ?? "" });
      }
      break;
    }
  }
  out.summary = lines.filter((l) => !RULES.some(([, re]) => re.test(l))).slice(0, 2).join(" ").slice(0, 300);
  return out;
}

export async function extractMeeting(ctx: Ctx, meetingId: string, text: string): Promise<Provenanced<MeetingExtract>> {
  if (!ctx.userId) throw unauthorized();
  const m = await one("SELECT 1 FROM meetings WHERE id=$1 AND owner_user_id=$2", [meetingId, ctx.userId]);
  if (!m) throw notFound("meeting");
  const llm = await structured({
    schema: MeetingExtractSchema,
    task:
      "From these meeting notes or transcript, extract: a 2-3 sentence summary; decisions actually made; promises (by 'me' = the note taker, or 'them'); action items with any due-date wording as dueHint (empty string if none); and the next meeting wording if mentioned (empty string if none). Only include items stated in the data.",
    data: text.slice(0, 60_000),
    promptVersion: "meeting-extract-1",
    ownerUserId: ctx.userId,
    kind: "meeting_extract",
    sourceIds: [meetingId],
  });
  if (llm) return { result: llm.output, provenance: "ai_inferred", model: llm.model, needsConfirmation: true };
  await q("INSERT INTO ai_runs (owner_user_id, kind, model, prompt_version, source_ids) VALUES ($1,'meeting_extract','rules-v1','meeting-extract-1',$2)", [ctx.userId, [meetingId]]);
  return { result: extractMeetingRules(text), provenance: "rules", model: "rules-v1", needsConfirmation: true };
}

// ---------- F-104 thank-you / follow-up draft ----------
const DraftSchema = z.object({ subject: z.string(), body: z.string() });

export async function draftFollowup(ctx: Ctx, contactId: string, kind: "thank_you" | "check_in" | "send_material" = "thank_you"): Promise<Provenanced<z.infer<typeof DraftSchema>>> {
  if (!ctx.userId) throw unauthorized();
  const c = await getContactRow(ctx.userId, contactId);
  const enc = await one<{ place_label: string | null; note: string | null; occurred_at: Date }>("SELECT place_label, note, occurred_at FROM encounters WHERE owner_user_id=$1 AND contact_id=$2 ORDER BY occurred_at DESC LIMIT 1", [ctx.userId, contactId]);
  const me = await one<{ name: string; company: string | null }>("SELECT name, company FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC LIMIT 1", [ctx.userId]);
  const data = JSON.stringify({ recipient: { name: c.fullName, company: c.company, title: c.jobTitle }, sender: me, lastMeeting: enc, kind });
  const llm = await structured({
    schema: DraftSchema,
    task: `Write a short, warm, professional ${kind === "thank_you" ? "thank-you" : kind === "check_in" ? "check-in" : "material follow-up"} email from sender to recipient (Korean business tone, max 5 sentences). Mention only facts present in the data. This is a draft the sender will edit; do not promise anything.`,
    data,
    promptVersion: "followup-draft-1",
    ownerUserId: ctx.userId,
    kind: "followup_draft",
    sourceIds: [contactId],
  });
  if (llm) return { result: llm.output, provenance: "ai_inferred", model: llm.model, needsConfirmation: true };
  const where = enc?.place_label ? `${enc.place_label}에서 ` : "";
  const sign = me ? `\n\n${me.name}${me.company ? ` 드림 (${me.company})` : " 드림"}` : "";
  const subjects = { thank_you: "만나서 반가웠습니다", check_in: "안부 인사드립니다", send_material: "말씀드린 자료 보내드립니다" };
  const bodies = {
    thank_you: `${c.fullName}님, 안녕하세요.\n${where}뵙게 되어 반가웠습니다. 나눈 이야기 이어서 연락드리겠습니다.`,
    check_in: `${c.fullName}님, 안녕하세요.\n지난번 ${where}만남 이후 어떻게 지내시는지 궁금해 연락드렸습니다.`,
    send_material: `${c.fullName}님, 안녕하세요.\n${where}말씀드린 자료를 첨부해 보내드립니다. 검토 후 편하실 때 의견 주세요.`,
  };
  return { result: { subject: subjects[kind], body: bodies[kind] + sign }, provenance: "rules", model: "rules-v1", needsConfirmation: true };
}

export { LLM_MODEL };
