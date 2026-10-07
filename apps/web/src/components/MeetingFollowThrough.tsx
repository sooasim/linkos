"use client";
// Meeting card entry point: F-087 일정 후보 (from the extracted next-meeting wording) + F-088 CRM 연결 + F-121 HubSpot 딜(승인 필요).
import { useCallback, useEffect, useState } from "react";
import { HubspotDealPanel } from "@/components/HubspotDeal";
import { Icon } from "@/components/Icon";
import { type Candidate, CandidateCard } from "@/components/Scheduling";
import { api } from "@/lib/client";

export function MeetingFollowThrough({ meetingId, hint }: { meetingId: string; hint?: string | null }) {
  const [text, setText] = useState(hint ?? "");
  const [cands, setCands] = useState<Candidate[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [crms, setCrms] = useState<{ provider: string; status: string; capabilities: { notes: boolean; deals?: boolean } }[]>([]);
  const [crmMsg, setCrmMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ candidates: Candidate[] }>(`/calendar/candidates?meetingId=${meetingId}`).then((r) => setCands(r.candidates)), [meetingId]);
  useEffect(() => {
    load();
    api<{ providers: any[] }>("/integrations/providers").then((r) => setCrms(r.providers.filter((p) => p.status === "active" && p.capabilities.notes))).catch(() => undefined);
  }, [load]);
  useEffect(() => {
    if (hint) setText(hint);
  }, [hint]);

  const propose = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ candidates: Candidate[]; message?: string }>(`/meetings/${meetingId}/schedule`, { body: { hint: text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      setMsg(r.message ?? `${r.candidates.length}개 후보를 만들었어요. 승인해야 캘린더에 등록됩니다.`);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const attach = async (provider: string) => {
    setCrmMsg(null);
    try {
      const r = await api<{ queued: number; done: number; pending: { status: string; error: string | null }[] }>(`/meetings/${meetingId}/crm`, { body: { provider } });
      setCrmMsg(r.pending.length ? `${r.done}/${r.queued}명 첨부 · 나머지는 Sync Journal에서 확인하세요 (${r.pending[0]!.status})` : `${r.done}명의 CRM 기록에 미팅 요약을 첨부했어요.`);
    } catch (e) {
      setCrmMsg((e as Error).message);
    }
  };

  return (
    <>
      <section className="surface space-y-3 p-5" aria-label="다음 일정">
        <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Icon name="calendar" size={18} />다음 일정 잡기</h2>
        <p className="text-[13.5px] text-[var(--fg-mute)]">‘다음 주 화요일 오후 3시’ 같은 표현에서 일정 후보를 만들어요. 날짜 표현이 없으면 후보를 지어내지 않습니다.</p>
        <div className="flex gap-2">
          <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="다음 주 화요일 오후 3시" aria-label="다음 일정 표현" />
          <button className="btn btn-ink shrink-0" disabled={busy || !text.trim()} onClick={propose}>후보 만들기</button>
        </div>
        {msg && <p className="text-[13.5px]" role="status">{msg}</p>}
        {cands.length > 0 && <ul className="space-y-2">{cands.map((c) => <CandidateCard key={c.id} c={c} onChange={load} />)}</ul>}
      </section>
      {crms.length > 0 && (
        <section className="surface space-y-3 p-5" aria-label="CRM 연결">
          <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Icon name="link" size={18} />CRM에 기록</h2>
          <p className="text-[13.5px] text-[var(--fg-mute)]">논의·결정·약속·To-do 요약을 참석자의 CRM 레코드에 활동/노트로 첨부합니다. 다시 누르면 같은 기록을 갱신해요. 개인 메모는 보내지 않습니다.</p>
          <div className="flex flex-wrap gap-2">
            {crms.map((c) => <button key={c.provider} className="btn btn-ghost !min-h-10 text-[14px]" onClick={() => attach(c.provider)}>{c.provider === "salesforce" ? "Salesforce" : c.provider === "hubspot" ? "HubSpot" : "Dynamics 365"}</button>)}
          </div>
          {crmMsg && <p className="text-[13.5px]" role="status">{crmMsg}</p>}
          {crms.some((c) => c.provider === "hubspot" && c.capabilities.deals) && <HubspotDealPanel meetingId={meetingId} />}
        </section>
      )}
    </>
  );
}
