// F-096 Pre-meeting Brief · F-089 관계 메모리 — "지난 미팅" + "그 뒤로 바뀐 것" for one person in a meeting brief.
// Everything shown is copied from stored records (meeting card, transcript, field history, Living Update). A stored
// transcript summary is labelled with its provenance (AI 추론 when ai_inferred) — never shown as the user's own note.
import Link from "next/link";
import { fmtDate } from "@/lib/client";
import { AiLabel } from "./Page";

export interface PreviousMeeting {
  meetingId: string;
  title: string;
  at: string;
  decisions: string[];
  promises: { text: string; by: "me" | "them" }[];
  discussion: string[];
  transcriptSummary: { text: string; provenance: "ai_inferred" | "rules"; recordingId: string | null } | null;
  transcriptExcerpt: { segmentId: string; text: string }[];
}
export interface ProfileChange {
  field: string;
  from: string | null;
  to: string | null;
  at: string;
  source: "contact_history" | "linked_profile";
  origin: string;
}

const FIELD: Record<string, string> = { fullName: "이름", full_name: "이름", company: "회사", jobTitle: "직책", job_title: "직책", department: "부서", email: "이메일", phone: "전화", address: "주소", website: "웹사이트", headline: "한 줄 소개" };

export function BriefHistory({ previousMeeting: pm, profileChanges = [], changesSince }: { previousMeeting?: PreviousMeeting | null; profileChanges?: ProfileChange[]; changesSince?: string | null }) {
  if (!pm && profileChanges.length === 0) return null;
  return (
    <div className="mt-2 space-y-3" data-testid="brief-history">
      {pm && (
        <div className="rounded-2xl bg-[var(--bg-sunk)] p-3">
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-mute)]">지난 미팅</p>
          <Link href={`/app/meetings/${pm.meetingId}`} className="mt-0.5 block font-semibold underline-offset-4 hover:underline">
            {pm.title} <span className="font-normal text-[var(--fg-mute)]">· {fmtDate(pm.at, { year: "numeric", month: "short", day: "numeric" })}</span>
          </Link>
          {pm.decisions.length > 0 && <p className="mt-1">결정: {pm.decisions.join(" · ")}</p>}
          {pm.promises.length > 0 && <p className="mt-1">약속: {pm.promises.map((p) => `${p.by === "me" ? "내가" : "상대가"} ${p.text}`).join(" · ")}</p>}
          {pm.discussion.length > 0 && <p className="mt-1 text-[var(--fg-mute)]">논의: {pm.discussion.join(" · ")}</p>}
          {pm.transcriptSummary && (
            <p className="mt-1.5">
              {pm.transcriptSummary.provenance === "ai_inferred" ? <AiLabel>AI 추론 · 전사 요약</AiLabel> : <span className="chip">전사 요약 · 규칙 추출</span>} <span className="ml-1">{pm.transcriptSummary.text}</span>
            </p>
          )}
          {pm.transcriptExcerpt.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-[13.5px] text-[var(--fg-mute)]" aria-label="전사 원문 일부">
              {pm.transcriptExcerpt.map((t) => <li key={t.segmentId}>“{t.text}”</li>)}
            </ul>
          )}
        </div>
      )}
      {profileChanges.length > 0 && (
        <div className="rounded-2xl border border-[var(--line)] p-3">
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-mute)]">
            {changesSince ? `${fmtDate(changesSince, { year: "numeric", month: "short", day: "numeric" })} 이후 바뀐 정보` : "최근 바뀐 정보"}
          </p>
          <ul className="mt-1 space-y-1">
            {profileChanges.map((c) => (
              <li key={`${c.source}:${c.field}`}>
                <b>{FIELD[c.field] ?? c.field}</b> {c.from || "—"} → {c.to || "—"}{" "}
                <span className="text-[12.5px] text-[var(--fg-mute)]">· {c.source === "linked_profile" ? "상대 Living Card 변경 (검토 대기)" : "내 연락처에 반영됨"} · {fmtDate(c.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
