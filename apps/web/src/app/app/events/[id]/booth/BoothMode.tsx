"use client";
// F-147 부스 Lead Flow — 빠른 캡처 · BANT · 담당자 배정 · 부스 팀(스태프 추가/해제) · F-149 ROI · F-151 주최자 API 토큰
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Avatar, Empty, PageHeader } from "@/components/Page";
import { api, uid } from "@/lib/client";

const QUALIFIERS = [
  ["budget", "예산"],
  ["authority", "결정권"],
  ["need", "니즈"],
  ["timeline", "일정"],
] as const;
const STAGES = [
  ["new", "신규"],
  ["contacted", "연락함"],
  ["meeting", "미팅"],
  ["proposal", "제안"],
  ["won", "성사"],
  ["lost", "무산"],
] as const;
const won = (c: number | null) => (c === null ? "—" : `₩${Math.round(c / 100).toLocaleString("ko-KR")}`);

const empty = { fullName: "", company: "", jobTitle: "", email: "", phone: "", notes: "", qualifiers: [] as string[], interest: "" as "" | "hot" | "warm" | "cold", assignedTo: "" };

export function BoothMode({ id }: { id: string }) {
  const [ev, setEv] = useState<any>(null);
  const [leads, setLeads] = useState<any[]>([]);
  const [team, setTeam] = useState<{ user_id: string; name: string | null; role: string }[]>([]);
  const [roi, setRoi] = useState<any>(null);
  const [tokens, setTokens] = useState<any[] | null>(null);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [cost, setCost] = useState("");
  const [attendees, setAttendees] = useState<{ userId: string | null; status: string; role: string; fullName: string | null; company: string | null }[]>([]);
  const [staffPick, setStaffPick] = useState("");
  const [staffMsg, setStaffMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [e, l, t, r] = await Promise.all([api(`/events/${id}`), api(`/events/${id}/leads`), api(`/events/${id}/team`), api(`/events/${id}/roi`)]);
      setEv(e);
      setLeads(l.leads);
      setTeam(t.team);
      setRoi(r);
      if (e.isOwner) {
        const [tk, at] = await Promise.all([api(`/events/${id}/organizer-tokens`), api(`/events/${id}/attendees`).catch(() => ({ attendees: [] }))]);
        setTokens(tk.tokens);
        setAttendees(at.attendees);
      }
    } catch (x) {
      setError((x as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const capture = async () => {
    if (!form.fullName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/events/${id}/leads`, {
        body: {
          contact: { fullName: form.fullName, company: form.company || null, jobTitle: form.jobTitle || null, email: form.email || null, phone: form.phone || null },
          qualifiers: form.qualifiers,
          interest: form.interest || null,
          notes: form.notes || null,
          assignedTo: form.assignedTo || null,
        },
        idempotencyKey: uid(),
      });
      setForm({ ...empty, assignedTo: form.assignedTo });
      await load();
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setSaving(false);
    }
  };
  // F-147 booth team: the owner adds/removes staff among people who joined the event (POST /events/{id}/team)
  const setStaff = async (userId: string, staff: boolean, label: string) => {
    setStaffMsg(null);
    try {
      await api(`/events/${id}/team`, { body: { userId, staff } });
      setStaffPick("");
      setStaffMsg({ ok: true, text: staff ? `${label}님을 부스 팀에 추가했어요.` : `${label}님을 부스 팀에서 뺐어요.` });
      await load();
    } catch (x) {
      setStaffMsg({ ok: false, text: (x as Error).message });
    }
  };
  const staffCandidates = attendees.filter((a) => a.status === "joined" && a.userId && !team.some((t) => t.user_id === a.userId));

  const patch = (leadId: string, body: Record<string, unknown>) => api(`/leads/${leadId}`, { method: "PATCH", body }).then(load).catch((x) => setError(x.message));

  if (!ev) return error ? <Empty title="부스 모드를 열 수 없어요" body={error} /> : <div className="surface h-40 animate-pulse" />;
  return (
    <div>
      <PageHeader back={`/app/events/${id}`} eyebrow="Booth mode" title={<>{ev.name} <em>리드</em></>} action={<a className="btn btn-ghost" href={`/api/v1/events/${id}/leads/export`}><Icon name="download" size={18} /> CSV</a>} />

      {roi && (
        <section aria-label="Event ROI" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["리드", String(roi.leads), `A/B ${roi.qualifiedLeads}`],
            ["미팅", String(roi.meetingsBooked), roi.meetingRate === null ? "" : `${roi.meetingRate}%`],
            ["리드당 비용", won(roi.costPerLeadCents), `총 ${won(roi.costCents)}`],
            ["ROI", roi.roiPct === null ? "—" : `${roi.roiPct}%`, `성사 ${won(roi.wonCents)} · 파이프라인 ${won(roi.pipelineCents)}`],
          ].map(([l, v, h]) => (
            <div key={l} className="surface p-4">
              <p className="text-[12px] text-[var(--fg-mute)]">{l}</p>
              <p className="display num text-[30px] leading-tight">{v}</p>
              <p className="text-[11.5px] text-[var(--fg-mute)]">{h}</p>
            </div>
          ))}
        </section>
      )}
      {roi && <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]">후속 완료율 {roi.followupCompletion ?? "—"}% · 리드 → 후속 → 미팅 → 성사 추적</p>}

      <section className="surface mt-6 space-y-3 p-4" aria-labelledby="cap-h">
        <h2 id="cap-h" className="text-[17px] font-semibold">빠른 캡처</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className="field sm:col-span-2" placeholder="이름 *" aria-label="이름" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <input className="field" placeholder="회사" aria-label="회사" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          <input className="field" placeholder="직책" aria-label="직책" value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} />
          <input className="field" type="email" placeholder="이메일" aria-label="이메일" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className="field" type="tel" placeholder="전화" aria-label="전화" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="자격 (BANT)">
          {QUALIFIERS.map(([k, l]) => {
            const on = form.qualifiers.includes(k);
            return (
              <button key={k} type="button" aria-pressed={on} className={`chip ${on ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} onClick={() => setForm({ ...form, qualifiers: on ? form.qualifiers.filter((x) => x !== k) : [...form.qualifiers, k] })}>
                {l}
              </button>
            );
          })}
          {(["hot", "warm", "cold"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={form.interest === k} className={`chip ${form.interest === k ? "!bg-[var(--color-signal)] !text-[var(--color-ink)]" : ""}`} onClick={() => setForm({ ...form, interest: form.interest === k ? "" : k })}>
              {k === "hot" ? "🔥 Hot" : k === "warm" ? "Warm" : "Cold"}
            </button>
          ))}
        </div>
        <textarea className="field min-h-16" placeholder="메모 (나만 + 부스 팀)" aria-label="메모" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={2000} />
        <label className="block">
          <span className="label">담당자</span>
          <select className="field" value={form.assignedTo} onChange={(e) => setForm({ ...form, assignedTo: e.target.value })}>
            <option value="">미배정</option>
            {team.map((t) => <option key={t.user_id} value={t.user_id}>{t.name ?? t.user_id.slice(0, 8)} ({t.role})</option>)}
          </select>
        </label>
        {error && <p role="alert" className="text-[14px] text-[var(--color-ember)]">{error}</p>}
        <button className="btn btn-signal btn-lg w-full" disabled={saving || !form.fullName.trim()} onClick={capture}>
          {saving ? "저장 중…" : "리드 저장"}
        </button>
      </section>

      <section className="mt-8" aria-labelledby="leads-h">
        <h2 id="leads-h" className="mb-3 text-[18px] font-semibold">리드 {leads.length}</h2>
        {leads.length === 0 ? <Empty title="아직 리드가 없어요" body="부스에서 만난 사람을 위에서 바로 저장하세요." /> : (
          <ul className="space-y-2">
            {leads.map((l) => (
              <li key={l.id} className="surface p-4">
                <div className="flex items-center gap-3">
                  <Avatar name={l.full_name} size={36} />
                  <Link href={`/app/people/${l.contact_id}`} className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{l.full_name}</span>
                    <span className="block truncate text-[13px] text-[var(--fg-mute)]">{[l.company, l.job_title].filter(Boolean).join(" · ")}</span>
                  </Link>
                  <span className="chip" aria-label={`등급 ${l.grade}, 점수 ${l.score}`}>{l.grade} · {l.score}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[13.5px]">
                  <select className="field !min-h-10 !w-auto !py-1" aria-label="단계" value={l.stage} onChange={(e) => patch(l.id, { stage: e.target.value })}>
                    {STAGES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <select className="field !min-h-10 !w-auto !py-1" aria-label="담당자" value={l.assigned_to ?? ""} onChange={(e) => patch(l.id, { assignedTo: e.target.value || null })}>
                    <option value="">미배정</option>
                    {team.map((t) => <option key={t.user_id} value={t.user_id}>{t.name ?? t.user_id.slice(0, 8)}</option>)}
                  </select>
                  <label className="flex items-center gap-1">
                    ₩
                    <input
                      className="field !min-h-10 !w-32 !py-1"
                      type="number"
                      min={0}
                      aria-label="딜 금액(원)"
                      defaultValue={Math.round(Number(l.deal_value_cents) / 100) || ""}
                      onBlur={(e) => patch(l.id, { dealValueCents: Math.max(0, Math.round(Number(e.target.value || 0) * 100)) })}
                    />
                  </label>
                  {(l.qualifiers ?? []).map((q: string) => <span key={q} className="chip">{QUALIFIERS.find(([k]) => k === q)?.[1] ?? q}</span>)}
                </div>
                {l.notes && <p className="mt-2 text-[13.5px] text-[var(--fg-mute)]">{l.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {ev.isOwner && (
        <section className="mt-8 space-y-4" aria-labelledby="own-h">
          <h2 id="own-h" className="text-[18px] font-semibold">행사 설정</h2>
          <div className="surface space-y-3 p-4" data-testid="booth-team">
            <p className="font-semibold">부스 팀</p>
            <p className="text-[13px] text-[var(--fg-mute)]">스태프는 이 행사의 리드를 보고 저장·배정할 수 있어요. 참가 코드로 입장한 사람만 추가할 수 있습니다.</p>
            <ul className="space-y-1 text-[14px]">
              {team.map((t) => (
                <li key={t.user_id} className="flex items-center gap-2">
                  <Avatar name={t.name ?? "?"} size={28} />
                  <span className="min-w-0 flex-1 truncate">{t.name ?? t.user_id.slice(0, 8)}</span>
                  <span className="chip !text-[12px]">{t.role === "owner" ? "소유자" : "스태프"}</span>
                  {t.role !== "owner" && (
                    <button type="button" className="btn btn-ghost !min-h-9 !px-2" onClick={() => setStaff(t.user_id, false, t.name ?? "스태프")} aria-label={`${t.name ?? "스태프"} 부스 팀에서 빼기`}>
                      <Icon name="x" size={16} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <select className="field !w-auto min-w-0 flex-1" value={staffPick} onChange={(e) => setStaffPick(e.target.value)} aria-label="스태프로 추가할 참가자">
                <option value="">{staffCandidates.length ? "참가자 선택…" : "추가할 수 있는 참가자가 없어요"}</option>
                {staffCandidates.map((a) => <option key={a.userId!} value={a.userId!}>{a.fullName ?? a.userId!.slice(0, 8)}{a.company ? ` · ${a.company}` : ""}</option>)}
              </select>
              <button
                type="button"
                className="btn btn-ink"
                disabled={!staffPick}
                onClick={() => setStaff(staffPick, true, staffCandidates.find((a) => a.userId === staffPick)?.fullName ?? "참가자")}
                data-testid="booth-staff-add"
              >
                <Icon name="plus" size={16} /> 스태프 추가
              </button>
            </div>
            {staffMsg && <p role={staffMsg.ok ? "status" : "alert"} className={`text-[13.5px] ${staffMsg.ok ? "" : "text-[var(--color-ember)]"}`}>{staffMsg.text}</p>}
          </div>
          <div className="surface flex flex-wrap items-end gap-2 p-4">
            <label className="flex-1">
              <span className="label">행사 비용 (원) — ROI 계산</span>
              <input className="field" type="number" min={0} value={cost} placeholder={String(Math.round((roi?.costCents ?? 0) / 100))} onChange={(e) => setCost(e.target.value)} />
            </label>
            <button className="btn btn-ghost" onClick={() => api(`/events/${id}/settings`, { method: "PATCH", body: { costCents: Math.round(Number(cost || 0) * 100) } }).then(load)}>저장</button>
          </div>
          <div className="surface p-4">
            <p className="font-semibold">주최자 API 토큰</p>
            <p className="mt-1 text-[13px] text-[var(--fg-mute)]">배지·행사 시스템이 <code>/api/v1/organizer/events/{id}/attendees</code>(공개 동의한 참가자만)와 <code>/leads</code>를 읽을 수 있어요. 토큰은 한 번만 표시됩니다.</p>
            {newToken && <p className="num mt-3 break-all rounded-2xl bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] p-3 text-[13px]" role="status">{newToken}</p>}
            <ul className="mt-3 space-y-1 text-[14px]">
              {(tokens ?? []).map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <span className={t.revoked_at ? "line-through opacity-60" : ""}>{t.label}</span>
                  <span className="text-[12px] text-[var(--fg-mute)]">{t.scopes.join(", ")}</span>
                  {!t.revoked_at && <button className="btn btn-ghost ml-auto !min-h-9" onClick={() => api(`/events/${id}/organizer-tokens/${t.id}`, { method: "DELETE" }).then(load)}>폐기</button>}
                </li>
              ))}
            </ul>
            <button className="btn btn-ink mt-3" onClick={() => api(`/events/${id}/organizer-tokens`, { body: { label: `token ${new Date().toISOString().slice(0, 10)}` } }).then((r) => setNewToken(r.token)).then(load)}>
              새 토큰 발급
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
