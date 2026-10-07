"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel, PageHeader } from "@/components/Page";
import { api, fmtDate } from "@/lib/client";
import { MeetingRecorder } from "./MeetingRecorder";
import { TranscriptPanel } from "./TranscriptPanel";

type Action = { id?: string; description: string; dueAt?: string | null; contactId?: string | null; status: "open" | "done"; sourceSegmentIds?: string[] };

function Lines({ label, items, onChange, placeholder }: { label: string; items: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="space-y-2">
        {[...items, ""].map((v, i) => (
          <input key={i} className="field" value={v} placeholder={i === items.length ? placeholder : ""} onChange={(e) => {
            const next = [...items];
            if (i === items.length) next.push(e.target.value);
            else next[i] = e.target.value;
            onChange(next.filter((x, j) => x || j < items.length - 1 || j === i));
          }} />
        ))}
      </div>
    </div>
  );
}

const toLocal = (d?: string | null) => (d ? new Date(new Date(d).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

export function MeetingEditor({ meeting, preselect }: { meeting: any | null; preselect: string[] }) {
  const router = useRouter();
  const [contacts, setContacts] = useState<{ id: string; fullName: string; company: string | null }[]>([]);
  const [m, setM] = useState({
    title: meeting?.title ?? "",
    purpose: meeting?.purpose ?? "",
    startedAt: meeting?.startedAt ?? new Date().toISOString(),
    nextMeetingAt: meeting?.nextMeetingAt ?? null,
    participantContactIds: (meeting?.participants?.map((p: any) => p.id) ?? preselect) as string[],
    discussion: (meeting?.discussion ?? []) as string[],
    decisions: (meeting?.decisions ?? []) as string[],
    promises: (meeting?.promises ?? []) as { text: string; by: "me" | "them" }[],
    actionItems: (meeting?.actionItems ?? []) as Action[],
  });
  const [brief, setBrief] = useState<any>(null);
  const [consent, setConsent] = useState({ owner: false, participants: false, status: meeting?.consentStatus ?? "unknown", msg: "" });
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [extract, setExtract] = useState<any>(null);
  const [recKey, setRecKey] = useState(0);

  useEffect(() => {
    api<{ contacts: any[] }>("/contacts?limit=200").then((r) => setContacts(r.contacts)).catch(() => undefined);
  }, []);

  const save = async () => {
    setBusy(true);
    const body = { ...m, purpose: m.purpose || null, promises: m.promises.filter((p) => p.text), actionItems: m.actionItems.filter((a) => a.description) };
    try {
      if (meeting) {
        await api(`/meetings/${meeting.id}`, { method: "PATCH", body });
        router.refresh();
      } else {
        const r = await api<{ id: string }>("/meetings", { body });
        router.replace(`/app/meetings/${r.id}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const setRecordingConsent = async () => {
    const r = await api<{ consentStatus: string; reason: string | null }>(`/meetings/${meeting.id}/consent`, { body: { ownerConsent: consent.owner, participantsAcknowledged: consent.participants, policy: "all_party" } });
    setConsent({ ...consent, status: r.consentStatus, msg: r.consentStatus === "granted" ? "동의가 기록되었습니다." : "모든 참여자의 동의가 필요합니다." });
  };

  return (
    <div>
      <PageHeader back="/app/meetings" eyebrow="Meeting Card" title={meeting ? meeting.title : <>새 <em>미팅</em></>} />
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className="label">제목 *</span>
            <input className="field" value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} />
          </label>
          <label className="sm:col-span-2">
            <span className="label">목적</span>
            <input className="field" value={m.purpose} onChange={(e) => setM({ ...m, purpose: e.target.value })} />
          </label>
          <label>
            <span className="label">일시</span>
            <input type="datetime-local" className="field" value={toLocal(m.startedAt)} onChange={(e) => setM({ ...m, startedAt: fromLocal(e.target.value) ?? m.startedAt })} />
          </label>
          <label>
            <span className="label">다음 일정</span>
            <input type="datetime-local" className="field" value={toLocal(m.nextMeetingAt)} onChange={(e) => setM({ ...m, nextMeetingAt: fromLocal(e.target.value) })} />
          </label>
        </div>

        <div>
          <span className="label">참석자</span>
          <div className="flex flex-wrap gap-2">
            {contacts.map((c) => {
              const on = m.participantContactIds.includes(c.id);
              return (
                <button key={c.id} type="button" onClick={() => setM({ ...m, participantContactIds: on ? m.participantContactIds.filter((x) => x !== c.id) : [...m.participantContactIds, c.id] })} className={`chip ${on ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
                  {c.fullName}
                </button>
              );
            })}
          </div>
        </div>

        <Lines label="논의" items={m.discussion} onChange={(v) => setM({ ...m, discussion: v })} placeholder="논의한 내용" />
        <Lines label="결정" items={m.decisions} onChange={(v) => setM({ ...m, decisions: v })} placeholder="결정된 사항" />
        <div>
          <span className="label">약속</span>
          <div className="space-y-2">
            {[...m.promises, { text: "", by: "me" as const }].map((p, i) => (
              <div key={i} className="flex gap-2">
                <select className="field !w-28" value={p.by} onChange={(e) => {
                  const next = [...m.promises];
                  next[i] = { ...p, by: e.target.value as "me" | "them" };
                  setM({ ...m, promises: next });
                }}>
                  <option value="me">내가</option>
                  <option value="them">상대가</option>
                </select>
                <input className="field" value={p.text} placeholder="약속한 내용" onChange={(e) => {
                  const next = [...m.promises];
                  next[i] = { ...p, text: e.target.value };
                  setM({ ...m, promises: next.filter((x, j) => x.text || j === i) });
                }} />
              </div>
            ))}
          </div>
        </div>
        <div>
          <span className="label">To-do</span>
          <div className="space-y-2">
            {[...m.actionItems, { description: "", status: "open" as const }].map((a, i) => (
              <div key={a.id ?? i} className="flex items-center gap-2">
                <input type="checkbox" aria-label="완료" className="size-5 accent-[var(--color-ink)]" checked={a.status === "done"} disabled={!a.description} onChange={(e) => {
                  const next = [...m.actionItems];
                  next[i] = { ...a, status: e.target.checked ? "done" : "open" };
                  setM({ ...m, actionItems: next });
                }} />
                <input className="field" value={a.description} placeholder="할 일" onChange={(e) => {
                  const next = [...m.actionItems];
                  next[i] = { ...a, description: e.target.value, contactId: a.contactId ?? m.participantContactIds[0] ?? null };
                  setM({ ...m, actionItems: next.filter((x, j) => x.description || j === i) });
                }} />
                <input type="date" className="field !w-40" value={a.dueAt ? a.dueAt.slice(0, 10) : ""} aria-label="기한" onChange={(e) => {
                  const next = [...m.actionItems];
                  next[i] = { ...a, dueAt: e.target.value ? new Date(e.target.value).toISOString() : null };
                  setM({ ...m, actionItems: next });
                }} />
              </div>
            ))}
          </div>
        </div>

        <button onClick={save} disabled={busy || !m.title} className="btn btn-signal btn-lg w-full sm:w-auto">{busy ? "저장 중…" : "미팅 카드 저장"}</button>

        {meeting && (
          <>
            <section className="surface space-y-3 p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-[17px] font-semibold">30초 브리핑</h2>
                <button className="btn btn-ghost !min-h-10" onClick={() => api(`/meetings/${meeting.id}/brief`).then(setBrief)}>
                  <Icon name="spark" size={16} /> 생성
                </button>
              </div>
              {brief && (
                <div className="space-y-4">
                  <AiLabel>내 기록에서 도출</AiLabel>
                  {brief.people.map((p: any) => (
                    <div key={p.contactId} className="border-t border-[var(--line)] pt-3 text-[14.5px]">
                      <p className="font-semibold">{p.fullName} <span className="font-normal text-[var(--fg-mute)]">{p.company}</span></p>
                      {p.lastEncounter && <p className="text-[var(--fg-mute)]">마지막 만남: {fmtDate(p.lastEncounter.occurred_at)} {p.lastEncounter.place_label ?? ""}</p>}
                      {p.openActions.length > 0 && <p>미완료 약속: {p.openActions.map((a: any) => a.description).join(", ")}</p>}
                      {p.recentNotes[0] && <p className="text-[var(--fg-mute)]">최근 메모: {p.recentNotes[0].body}</p>}
                      {p.suggestedTopics.map((t: string) => <p key={t}>추천 논점: {t}</p>)}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="surface space-y-3 p-5" aria-label="노트에서 추출">
              <h2 className="text-[17px] font-semibold">노트·전사에서 자동 정리</h2>
              <p className="text-[13.5px] text-[var(--fg-mute)]">회의 메모나 전사 텍스트를 붙여넣으면 결정·약속·To-do·다음 일정을 제안합니다. 적용 전에 확인하세요.</p>
              <textarea className="field min-h-32" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={"예)\n결정: 3개 병원 파일럿 진행\n할 일: 제안서 송부 금요일까지\n약속: 상대가 데이터 샘플 공유\n다음 미팅: 다음 주 화요일"} aria-label="회의 노트" />
              <button className="btn btn-ghost" disabled={!notes.trim()} onClick={async () => setExtract(await api(`/meetings/${meeting.id}/extract`, { body: { text: notes } }))}>
                <Icon name="spark" size={16} /> 추출
              </button>
              {extract && (
                <div className="space-y-2 text-[14.5px]" data-testid="extract">
                  <AiLabel>{extract.provenance === "ai_inferred" ? "AI 추출 · 확인 필요" : "표시된 줄만 추출"}</AiLabel>
                  {extract.result.summary && <p>{extract.result.summary}</p>}
                  {extract.result.decisions.map((d: string) => <p key={d}>결정 · {d}</p>)}
                  {extract.result.promises.map((p: any) => <p key={p.text}>약속({p.by === "me" ? "내가" : "상대가"}) · {p.text}</p>)}
                  {extract.result.actionItems.map((a: any) => <p key={a.description}>To-do · {a.description}{a.dueHint ? ` (${a.dueHint})` : ""}</p>)}
                  {extract.result.nextMeetingHint && <p>다음 일정 후보 · {extract.result.nextMeetingHint}</p>}
                  <button className="btn btn-signal" onClick={() => {
                    setM((cur) => ({
                      ...cur,
                      discussion: extract.result.summary ? [...cur.discussion, extract.result.summary] : cur.discussion,
                      decisions: [...cur.decisions, ...extract.result.decisions.filter((d: string) => !cur.decisions.includes(d))],
                      promises: [...cur.promises, ...extract.result.promises],
                      actionItems: [...cur.actionItems, ...extract.result.actionItems.map((a: any) => ({ description: a.dueHint ? `${a.description}` : a.description, status: "open" as const, contactId: cur.participantContactIds[0] ?? null }))],
                    }));
                    setExtract(null);
                  }}>미팅 카드에 적용</button>
                </div>
              )}
            </section>

            <section className="surface space-y-3 p-5" aria-label="녹음 동의">
              <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Icon name="mic" size={18} /> 회의 녹음</h2>
              <p className="text-[14px] text-[var(--fg-mute)]">녹음은 모든 참여자의 동의가 기록된 뒤에만 시작할 수 있습니다.</p>
              <label className="flex items-center gap-3 text-[14.5px]"><input type="checkbox" className="size-5" checked={consent.owner} onChange={(e) => setConsent({ ...consent, owner: e.target.checked })} />녹음·전사에 동의합니다</label>
              <label className="flex items-center gap-3 text-[14.5px]"><input type="checkbox" className="size-5" checked={consent.participants} onChange={(e) => setConsent({ ...consent, participants: e.target.checked })} />모든 참여자에게 녹음 사실을 알리고 동의를 받았습니다</label>
              <div className="flex flex-wrap items-start gap-2">
                <button className="btn btn-ghost" onClick={setRecordingConsent}>동의 기록</button>
                <MeetingRecorder meetingId={meeting.id} consentGranted={consent.status === "granted"} onFinished={() => setRecKey((k) => k + 1)} />
              </div>
              {consent.msg && <p role="status" className="text-[13.5px]">{consent.msg}</p>}
              <p className="text-[12.5px] text-[var(--fg-mute)]">녹음은 약 50초 단위로 암호화 저장되고, 전사가 끝나면 화자별 문장과 To-do 제안이 아래에 나타납니다.</p>
            </section>

            <TranscriptPanel
              meetingId={meeting.id}
              refreshKey={recKey}
              confirmed={m.actionItems}
              onAccepted={(a) => setM((cur) => ({ ...cur, actionItems: [...cur.actionItems, { id: a.id, description: a.description, dueAt: a.dueAt, status: "open", contactId: cur.participantContactIds[0] ?? null, sourceSegmentIds: a.sourceSegmentIds }] }))}
              onApplyDecision={(kind, text) =>
                setM((cur) => (kind === "decision" ? { ...cur, decisions: cur.decisions.includes(text) ? cur.decisions : [...cur.decisions, text] } : { ...cur, promises: [...cur.promises, { text, by: "me" as const }] }))
              }
              onUseTranscript={(text) => setNotes(text)}
            />
          </>
        )}
      </div>
    </div>
  );
}
