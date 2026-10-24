"use client";

/**
 * P-104 단계 변경 · P-106 비공개 메모.
 *
 * 단계는 **한 필드만** 보낸다(`PATCH /me/leads/{id}`): 라우트가 `stage` 와 `assignedTo` 를 함께 받지 않는다.
 * 담당자 배정은 별개의 요청이고, 후보 목록(같은 조직의 활성 멤버)을 주는 응답이 이 화면에 없으므로
 * 배정 UI 를 만들지 않았다 — 사용자 id 를 직접 적어 넣는 입력창은 운영 도구가 아니라 사고다.
 *
 * 선택 가능한 단계는 도메인의 `canChangeStage()` 로 좁힌다(서버가 쓰는 같은 함수). 최종 판정은 서버다.
 *
 * 메모는 고객에게 보이지 않는다 — 입력창 옆에 그렇게 적는 것이 이 컴포넌트의 책임 중 하나다.
 * (공개 뷰는 `lead_notes` 를 모르고, 모듈에도 메모를 공개 DTO 로 바꾸는 함수가 없다.)
 */

import type { lead as leadModule } from "@proplus/api";
import { LEAD_STAGES, LEAD_STAGE_LABEL_KO, type LeadStage, canChangeStage } from "@proplus/domain";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ClientError, api, fmtDateTime, uid } from "@/lib/client";

interface Notice {
  tone: "ok" | "error";
  message: string;
  code?: string;
}

export function LeadDetail({
  leadId,
  stage,
  notes,
}: {
  leadId: string;
  stage: LeadStage;
  notes: readonly leadModule.LeadNoteView[];
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<LeadStage>(stage);
  const [rows, setRows] = useState<leadModule.LeadNoteView[]>([...notes]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noteKeyRef = useRef<string | null>(null);

  async function changeStage(next: LeadStage) {
    if (busy) return;
    setBusy("stage");
    setNotice(null);
    try {
      await api(`/me/leads/${leadId}`, { method: "PATCH", body: { stage: next } });
      setCurrent(next);
      setNotice({ tone: "ok", message: `단계를 “${LEAD_STAGE_LABEL_KO[next]}”로 바꿨습니다.` });
      router.refresh();
    } catch (err) {
      const e = err instanceof ClientError ? err : null;
      setNotice({ tone: "error", message: e?.message ?? "단계를 바꾸지 못했습니다.", code: e?.code });
    } finally {
      setBusy(null);
    }
  }

  async function addNote(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const text = draft.trim();
    if (text.length === 0) return;
    setBusy("note");
    setNotice(null);
    try {
      noteKeyRef.current ??= uid();
      const saved = await api<leadModule.LeadNoteView>(`/me/leads/${leadId}/notes`, {
        method: "POST",
        idempotencyKey: noteKeyRef.current,
        body: { note: text },
      });
      noteKeyRef.current = null;
      // 서버가 돌려준 값(정규화·무해화를 거친 본문)을 그대로 쓴다. 입력값을 그려 두면 저장된 것과 달라진다.
      setRows((prev) => [...prev, saved]);
      setDraft("");
      setNotice({ tone: "ok", message: "메모를 저장했습니다." });
    } catch (err) {
      const e = err instanceof ClientError ? err : null;
      setNotice({ tone: "error", message: e?.message ?? "메모를 저장하지 못했습니다.", code: e?.code });
    } finally {
      setBusy(null);
    }
  }

  const options = LEAD_STAGES.filter((s) => canChangeStage(current, s));

  return (
    <>
      <section className="card mt-6 p-6" aria-labelledby="stage-section">
        <h2 id="stage-section" className="text-[17px] font-semibold">
          진행 단계
        </h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
          단계 변경은 모두 이력으로 남습니다. 성약·종료에서 “신규”로는 되돌릴 수 없고, 최소 “연락함”부터 다시 시작합니다.
        </p>

        <label className="mt-4 block">
          <span className="label">현재 단계: {LEAD_STAGE_LABEL_KO[current]}</span>
          <select
            className="field"
            value=""
            disabled={busy !== null || options.length === 0}
            onChange={(e) => {
              const next = e.target.value;
              if ((LEAD_STAGES as readonly string[]).includes(next)) changeStage(next as LeadStage);
            }}
          >
            <option value="">단계 바꾸기…</option>
            {options.map((s) => (
              <option key={s} value={s}>
                {LEAD_STAGE_LABEL_KO[s]}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="card mt-6 p-6" aria-labelledby="notes-section">
        <h2 id="notes-section" className="text-[17px] font-semibold">
          메모
        </h2>

        {rows.length === 0 ? (
          <p className="mt-3 text-[14px] text-[var(--fg-mute)]">아직 메모가 없습니다.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {rows.map((n) => (
              <li key={n.id} className="panel p-4">
                <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed">{n.note}</p>
                <p className="mt-2 text-[12px] text-[var(--fg-mute)]" suppressHydrationWarning>
                  {fmtDateTime(n.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}

        <form className="mt-5" onSubmit={addNote} aria-busy={busy === "note"}>
          <label className="label" htmlFor="note-draft">
            메모 추가
          </label>
          <textarea
            id="note-draft"
            className="field"
            rows={3}
            maxLength={2000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-describedby="note-privacy"
          />
          {/* P-106: 입력창 **옆에** 적는다. 저장한 뒤에 알려 주면 이미 늦다. */}
          <p id="note-privacy" className="mt-2 text-[12.5px] font-semibold text-[var(--fg-mute)]">
            이 메모는 고객에게 보이지 않습니다. 같은 상담을 볼 수 있는 담당자만 읽습니다.
          </p>
          <button type="submit" className="btn btn-primary mt-4" disabled={busy !== null || draft.trim().length === 0}>
            {busy === "note" ? "저장 중…" : "메모 저장"}
          </button>
        </form>
      </section>

      {notice ? (
        <p
          className={`mt-5 text-[13.5px] font-semibold ${
            notice.tone === "ok" ? "text-[var(--verified)]" : "text-[var(--caution)]"
          }`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
          {notice.code ? <span className="block font-normal text-[var(--fg-mute)]">오류 코드: {notice.code}</span> : null}
        </p>
      ) : null}
    </>
  );
}
