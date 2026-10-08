// intro module — F-155 3자 소개 메시지(AI 초안 + 사용자 수정, 절대 자동 발송하지 않음), F-158 Room 요약,
// F-159 소개 성과(소개→미팅→기회 전환), F-152 후보에서 소개 생성.
import { INTRO_OUTCOMES, type IntroState, canIntroTransition, introStats } from "@linkos/domain";
import { z } from "zod";
import { one, pool, q, tx } from "../lib/db";
import { conflict, notFound, unauthorized } from "../lib/errors";
import { structured } from "../lib/llm";
import { type Ctx, audit } from "../lib/platform";
import { extractMeetingRules } from "./assist";
import { createIntroduction, getIntroduction } from "./connection";

const Msg = z.object({ subject: z.string(), body: z.string() });
const IntroDraftSchema = z.object({ toA: Msg, toB: Msg, joint: Msg });
export type IntroDraft = z.infer<typeof IntroDraftSchema>;

async function introContext(userId: string, id: string) {
  const i = await one<any>(
    `SELECT i.*, a.full_name AS a_name, a.job_title AS a_title, ac.name AS a_company, a.linked_user_id AS a_user,
            b.full_name AS b_name, b.job_title AS b_title, bc.name AS b_company, b.linked_user_id AS b_user
     FROM introductions i JOIN contacts a ON a.id=i.party_a_contact_id JOIN contacts b ON b.id=i.party_b_contact_id
     LEFT JOIN companies ac ON ac.id=a.company_id LEFT JOIN companies bc ON bc.id=b.company_id
     WHERE i.id=$1 AND i.introducer_user_id=$2`,
    [id, userId],
  );
  if (!i) throw notFound("introduction");
  return i;
}

async function offersOf(linkedUserId: string | null) {
  if (!linkedUserId) return [] as string[];
  const r = await q<{ text: string }>(
    "SELECT o.text FROM offers o WHERE o.confirmed AND o.profile_id = (SELECT id FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC, created_at LIMIT 1) LIMIT 3",
    [linkedUserId],
  );
  return r.map((x) => x.text);
}

function ruleDraft(i: any, me: { name: string; company: string | null } | null, aOffers: string[], bOffers: string[]): IntroDraft {
  const sign = me ? `\n\n${me.name}${me.company ? ` (${me.company})` : ""} 드림` : "";
  const who = (name: string, title: string | null, company: string | null) => `${name}님${[company, title].filter(Boolean).length ? `(${[company, title].filter(Boolean).join(" ")})` : ""}`;
  const aDesc = who(i.a_name, i.a_title, i.a_company);
  const bDesc = who(i.b_name, i.b_title, i.b_company);
  const extra = (offers: string[]) => (offers.length ? `\n참고로 ${offers.join(", ")} 쪽에 강점이 있는 분입니다.` : "");
  return {
    // double opt-in: each party is asked privately first; contact details are shared only after both agree
    toA: {
      subject: `${i.b_name}님 소개드려도 될까요?`,
      body: `${i.a_name}님, 안녕하세요.\n${bDesc}을 소개해 드리고 싶어 먼저 여쭙니다.\n소개 이유: ${i.reason}${extra(bOffers)}\n괜찮으시면 회신 부탁드립니다. 동의해 주시기 전에는 연락처를 전달하지 않습니다.${sign}`,
    },
    toB: {
      subject: `${i.a_name}님 소개드려도 될까요?`,
      body: `${i.b_name}님, 안녕하세요.\n${aDesc}을 소개해 드리고 싶어 먼저 여쭙니다.\n소개 이유: ${i.reason}${extra(aOffers)}\n괜찮으시면 회신 부탁드립니다. 동의해 주시기 전에는 연락처를 전달하지 않습니다.${sign}`,
    },
    joint: {
      subject: `${i.a_name}님 ↔ ${i.b_name}님 인사 나누세요`,
      body: `두 분 모두 소개에 동의해 주셔서 연결해 드립니다.\n\n${aDesc} — ${i.b_name}님께 소개드리고 싶었던 분입니다.\n${bDesc} — ${i.a_name}님께 소개드리고 싶었던 분입니다.\n\n소개 이유: ${i.reason}\n편하신 때 직접 이야기 나눠 보세요.${sign}`,
    },
  };
}

/** F-155: generate (not send) the 3-party intro messages. Stored as a draft; the user edits and sends from their own mail. */
export async function draftIntroMessage(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const i = await introContext(ctx.userId, id);
  const me = await one<{ name: string; company: string | null }>("SELECT name, company FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC, created_at LIMIT 1", [ctx.userId]);
  const [aOffers, bOffers] = await Promise.all([offersOf(i.a_user), offersOf(i.b_user)]);
  const data = JSON.stringify({
    introducer: me,
    reason: i.reason,
    partyA: { name: i.a_name, title: i.a_title, company: i.a_company, offers: aOffers },
    partyB: { name: i.b_name, title: i.b_title, company: i.b_company, offers: bOffers },
  });
  const llm = await structured({
    schema: IntroDraftSchema,
    task:
      "Draft a double-opt-in introduction in Korean business tone: toA asks party A privately whether they want to be introduced to party B; toB asks B about A; joint is the introduction email sent only after both agree. Max 6 sentences each. Use only facts in the data; do not promise outcomes; never include phone numbers or emails.",
    data,
    promptVersion: "intro-draft-1",
    ownerUserId: ctx.userId,
    kind: "intro_draft",
    sourceIds: [id],
  });
  const draft = llm?.output ?? ruleDraft(i, me, aOffers, bOffers);
  const stored = { ...draft, provenance: llm ? "ai_inferred" : "rules", model: llm?.model ?? "rules-v1", generatedAt: new Date().toISOString(), editedByUser: false };
  await q("UPDATE introductions SET draft=$2 WHERE id=$1", [id, JSON.stringify(stored)]);
  await audit(pool(), ctx, "intro.draft_generated", "introduction", id, { provenance: stored.provenance });
  return { draft: stored, sent: false, needsConfirmation: true as const };
}

export const introDraftInput = IntroDraftSchema;

export async function saveIntroDraft(ctx: Ctx, id: string, draft: IntroDraft) {
  if (!ctx.userId) throw unauthorized();
  await introContext(ctx.userId, id);
  const stored = { ...draft, provenance: "user", model: "user", generatedAt: new Date().toISOString(), editedByUser: true };
  await q("UPDATE introductions SET draft=$2 WHERE id=$1 AND introducer_user_id=$3", [id, JSON.stringify(stored), ctx.userId]);
  await audit(pool(), ctx, "intro.draft_saved", "introduction", id);
  return { draft: stored, sent: false };
}

export async function getIntroDraft(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const i = await introContext(ctx.userId, id);
  return { draft: i.draft ?? null, sent: false };
}

// ---------- F-158 ----------
const RoomSummarySchema = z.object({ status: z.string(), decisions: z.array(z.string()), openItems: z.array(z.string()), nextStep: z.string() });

export async function summarizeRoom(ctx: Ctx, roomId: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<any>("SELECT * FROM connection_rooms WHERE id=$1 AND owner_user_id=$2", [roomId, ctx.userId]);
  if (!r) throw notFound("room");
  const msgs = await q<{ body: string; created_at: Date }>("SELECT body, created_at FROM connection_room_messages WHERE room_id=$1 ORDER BY created_at LIMIT 500", [roomId]);
  const text = msgs.map((m) => m.body).join("\n");
  const llm = await structured({
    schema: RoomSummarySchema,
    task: "Summarize this connection room: current status in one sentence, decisions actually made, open (unfinished) items, and the single next step. Only use the data; empty arrays when nothing applies.",
    data: JSON.stringify({ purpose: r.purpose, status: r.status, nextAction: r.next_action, messages: text.slice(0, 40_000) }),
    promptVersion: "room-summary-1",
    ownerUserId: ctx.userId,
    kind: "room_summary",
    sourceIds: [roomId],
  });
  let result: z.infer<typeof RoomSummarySchema>;
  if (llm) result = llm.output;
  else {
    const ex = extractMeetingRules(text);
    const statusText = { active: "진행 중", won: "성사", archived: "보관됨" }[r.status as string] ?? r.status;
    result = {
      status: `${statusText} · 메시지 ${msgs.length}개${msgs.length ? ` · 마지막 활동 ${new Date(msgs[msgs.length - 1]!.created_at).toISOString().slice(0, 10)}` : ""}`,
      decisions: ex.decisions,
      openItems: ex.actionItems.map((a) => a.description),
      nextStep: r.next_action ?? ex.nextMeetingHint ?? "",
    };
  }
  const stored = { ...result, provenance: llm ? "ai_inferred" : "rules", model: llm?.model ?? "rules-v1", generatedAt: new Date().toISOString() };
  await q("UPDATE connection_rooms SET summary=$2, summary_at=now() WHERE id=$1", [roomId, JSON.stringify(stored)]);
  return { summary: stored, needsConfirmation: true as const };
}

// ---------- F-159 ----------
export const outcomeInput = z.object({ outcome: z.enum(INTRO_OUTCOMES), note: z.string().trim().max(1000).nullish(), meetingAt: z.string().datetime().nullish() });

export async function setIntroOutcome(ctx: Ctx, id: string, input: z.infer<typeof outcomeInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await tx(async (c) => {
    const i = await one<{ state: IntroState; outcome: string }>("SELECT state, outcome FROM introductions WHERE id=$1 AND introducer_user_id=$2 FOR UPDATE", [id, userId], c);
    if (!i) throw notFound("introduction");
    if (i.state === "DECLINED" && input.outcome !== "none") throw conflict("intro_declined", "거절된 소개에는 성과를 기록할 수 없습니다.");
    // walk the state machine forward where the outcome implies it (never backwards)
    const target: IntroState | null = input.outcome === "meeting" || input.outcome === "opportunity" ? "MEETING_BOOKED" : input.outcome === "won" ? "WON" : input.outcome === "lost" ? "ARCHIVED" : null;
    let state = i.state;
    if (target) {
      const path: IntroState[] = target === "WON" ? ["MEETING_BOOKED", "ACTIVE", "WON"] : target === "MEETING_BOOKED" ? ["MEETING_BOOKED"] : ["ARCHIVED"];
      for (const s of path) if (canIntroTransition(state, s)) state = s;
    }
    await c.query(
      "UPDATE introductions SET outcome=$2, outcome_note=$3, outcome_at=now(), meeting_at=COALESCE($4::timestamptz, meeting_at), state=$5 WHERE id=$1",
      [id, input.outcome, input.note ?? null, input.meetingAt ?? null, state],
    );
    if (state === "WON") await c.query("UPDATE connection_rooms SET status='won' WHERE introduction_id=$1", [id]);
    await audit(c, ctx, "intro.outcome", "introduction", id, { outcome: input.outcome, state });
  });
  return { ...(await getIntroduction(ctx, id)), outcome: input.outcome };
}

export async function introOutcomeStats(ctx: Ctx, days = 365) {
  if (!ctx.userId) throw unauthorized();
  const rows = await q<{ state: string; outcome: any; source: string }>(
    "SELECT state, outcome, source FROM introductions WHERE introducer_user_id=$1 AND created_at > now() - ($2 || ' days')::interval",
    [ctx.userId, days],
  );
  return { windowDays: days, all: introStats(rows), aiSuggested: introStats(rows.filter((r) => r.source === "ai_suggested")) };
}

export async function listIntroductionsWithOutcome(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  const rows = await q<{ id: string; outcome: string; outcome_note: string | null; source: string; meeting_at: Date | null; has_draft: boolean }>(
    "SELECT id, outcome, outcome_note, source, meeting_at, draft IS NOT NULL AS has_draft FROM introductions WHERE introducer_user_id=$1 ORDER BY created_at DESC LIMIT 50",
    [ctx.userId],
  );
  return Promise.all(rows.map(async (r) => ({ ...(await getIntroduction(ctx, r.id)), outcome: r.outcome, outcomeNote: r.outcome_note, source: r.source, meetingAt: r.meeting_at, hasDraft: r.has_draft })));
}

/** F-152 → create an introduction from an AI candidate (still consent-based; source recorded for F-159 stats). */
export async function createFromSuggestion(ctx: Ctx, input: { partyAContactId: string; partyBContactId: string; reason: string }) {
  const intro = await createIntroduction(ctx, input);
  await q("UPDATE introductions SET source='ai_suggested' WHERE id=$1 AND introducer_user_id=$2", [intro.id, ctx.userId]);
  return intro;
}
