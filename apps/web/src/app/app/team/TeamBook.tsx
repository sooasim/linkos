"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Avatar, Empty } from "@/components/Page";
import { api, relTime, uid } from "@/lib/client";

interface TC {
  id: string;
  fullName: string;
  company: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  piiHidden: boolean;
  ownership: "personal" | "company";
  owner: { userId: string; name: string };
  strength: number | null;
  lastContactAt: string | null;
  teamNotes: number;
}

// F-131 팀 주소록 · F-132 회사 소유 리드 · F-077 담당자 · F-076 공유 메모(작성자/관리자 삭제)
export function TeamBook({ orgId, myId, perms }: { orgId: string; myId: string; perms: string[] }) {
  const can = (p: string) => perms.includes(p);
  const [q, setQ] = useState("");
  const [own, setOwn] = useState<"" | "company" | "personal">("");
  const [items, setItems] = useState<TC[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [note, setNote] = useState("");
  const [members, setMembers] = useState<any[]>([]);
  const [mode, setMode] = useState<null | "share" | "lead">(null);
  const [mine, setMine] = useState<any[]>([]);
  const [pick, setPick] = useState<string[]>([]);
  const [asLead, setAsLead] = useState(false);
  const [lead, setLead] = useState({ fullName: "", company: "", jobTitle: "", email: "", phone: "", assigneeUserId: "" });
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (own) sp.set("ownership", own);
    api<{ contacts: TC[] }>(`/orgs/${orgId}/contacts?${sp}`).then((r) => setItems(r.contacts)).catch(() => setItems([]));
  };
  useEffect(() => {
    const t = setTimeout(load, 180);
    return () => clearTimeout(t);
  }, [q, own, orgId]);
  useEffect(() => {
    api<{ members: any[] }>(`/orgs/${orgId}/members`).then((r) => setMembers(r.members.filter((m) => m.status === "active" && m.role !== "viewer")));
  }, [orgId]);
  useEffect(() => {
    if (!open) return setDetail(null);
    api(`/orgs/${orgId}/contacts/${open}`).then(setDetail);
  }, [open]);
  useEffect(() => {
    if (mode === "share") api<{ contacts: any[] }>("/contacts?limit=200").then((r) => setMine(r.contacts));
  }, [mode]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      load();
      if (open) api(`/orgs/${orgId}/contacts/${open}`).then(setDetail).catch(() => setOpen(null));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--fg-mute)]" />
          <input className="field !pl-11" placeholder="이름, 회사, 직책" value={q} onChange={(e) => setQ(e.target.value)} aria-label="팀 주소록 검색" />
        </div>
        {(["", "company", "personal"] as const).map((k) => (
          <button key={k} className={`chip ${own === k ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} onClick={() => setOwn(k)}>{k === "" ? "전체" : k === "company" ? "회사 리드" : "공유된 개인 연락처"}</button>
        ))}
      </div>
      {msg && <p role="status" className="surface p-3 text-[14px]">{msg}</p>}

      {items === null ? (
        <div className="surface h-40 animate-pulse" />
      ) : items.length === 0 ? (
        <Empty title="팀 주소록이 비어 있어요" body="내 연락처를 팀에 공유하거나 회사 리드를 추가하세요. 개인 연락처는 공유하기 전까지 팀에 보이지 않습니다." />
      ) : (
        <ul className="surface divide-y divide-[var(--line)] overflow-hidden">
          {items.map((c) => (
            <li key={c.id}>
              <button className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-[color-mix(in_srgb,var(--fg)_4%,transparent)]" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
                <Avatar name={c.fullName} size={40} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15.5px] font-semibold">{c.fullName} {c.ownership === "company" && <span className="chip ml-1 !py-0 text-[11px]">회사 리드</span>}</span>
                  <span className="block truncate text-[13px] text-[var(--fg-mute)]">{[c.company, c.jobTitle].filter(Boolean).join(" · ") || "—"} · 담당 {c.owner.name}</span>
                </span>
                <span className="text-right text-[12px] text-[var(--fg-mute)]">
                  {c.strength != null && <span className="block">강도 {c.strength}</span>}
                  {relTime(c.lastContactAt)}
                </span>
              </button>
              {open === c.id && detail && (
                <div className="space-y-3 border-t border-[var(--line)] px-4 py-4 text-[14px]">
                  <p>{detail.contact.piiHidden ? <span className="text-[var(--fg-mute)]">연락처 정보는 Member 이상만 볼 수 있어요.</span> : [detail.contact.email, detail.contact.phone].filter(Boolean).join(" · ") || "—"}</p>
                  <p className="text-[12.5px] text-[var(--fg-mute)]">접촉 {detail.encounters.count}회 · 마지막 {relTime(detail.encounters.last)}</p>
                  <div className="flex flex-wrap gap-2">
                    {c.ownership === "company" && can("leads.assign") && (
                      <select className="field !w-auto !py-1.5 text-[13px]" value={c.owner.userId} aria-label="담당자 변경" onChange={(e) => run(() => api(`/orgs/${orgId}/contacts/${c.id}/assign`, { body: { userId: e.target.value } }), "담당자를 변경했어요.")}>
                        {members.map((m) => <option key={m.userId} value={m.userId}>담당: {m.name}</option>)}
                      </select>
                    )}
                    {c.ownership === "personal" && c.owner.userId === myId && (
                      <>
                        <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => run(() => api(`/orgs/${orgId}/contacts/${c.id}`, { method: "DELETE" }), "공유를 해제했어요.")}>공유 해제</button>
                        <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => confirm("회사 리드로 넘기면 이 연락처는 조직 소유가 되어, 퇴사 시에도 회사에 남습니다. 계속할까요?") && run(() => api(`/orgs/${orgId}/contacts/${c.id}/convert`, { body: {} }), "회사 리드로 전환했어요.")}>회사 리드로 전환</button>
                      </>
                    )}
                  </div>
                  <div>
                    <p className="eyebrow mb-1">팀 메모 · {detail.notes.length}</p>
                    <p className="mb-2 text-[12px] text-[var(--fg-mute)]">개인 메모는 여기에 표시되지 않으며 절대 공유되지 않습니다.</p>
                    <ul className="space-y-1.5">
                      {detail.notes.map((n: any) => (
                        <li key={n.id} className="flex items-start gap-2 rounded-xl border border-[var(--line)] px-3 py-2" data-testid="team-note">
                          <span className="min-w-0 flex-1">
                            <p>{n.body}</p>
                            <p className="text-[12px] text-[var(--fg-mute)]">{n.author} · {relTime(n.created_at)}</p>
                          </span>
                          {(n.author_user_id === myId || can("members.remove")) && (
                            <button
                              type="button"
                              className="grid size-9 shrink-0 place-items-center rounded-full text-[var(--fg-mute)] hover:text-[var(--color-ember)]"
                              aria-label="팀 메모 삭제"
                              onClick={() => confirm(n.author_user_id === myId ? "이 팀 메모를 삭제할까요? 팀원 모두에게서 사라지며 되돌릴 수 없습니다." : `${n.author}님의 팀 메모를 관리자 권한으로 삭제할까요? 되돌릴 수 없습니다.`) && run(() => api(`/orgs/${orgId}/notes/${n.id}`, { method: "DELETE" }), "팀 메모를 삭제했어요.")}
                            >
                              <Icon name="trash" size={16} />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                    {can("notes.write") && (
                      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/orgs/${orgId}/contacts/${c.id}/notes`, { body: { body: note } }); setNote(""); }); }}>
                        <input className="field flex-1" placeholder="팀과 공유할 메모" value={note} onChange={(e) => setNote(e.target.value)} required aria-label="팀 메모" />
                        <button className="btn btn-ink">추가</button>
                      </form>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {can("contacts.share") && (
        <div className="safe-bottom sticky bottom-24 flex gap-2 lg:bottom-4">
          <button className="btn btn-signal flex-1" onClick={() => setMode(mode === "share" ? null : "share")}><Icon name="share" size={17} />내 연락처 공유</button>
          <button className="btn btn-ink flex-1" onClick={() => setMode(mode === "lead" ? null : "lead")}><Icon name="plus" size={17} />회사 리드 추가</button>
        </div>
      )}

      {mode === "share" && (
        <section className="surface space-y-3 p-5">
          <h2 className="font-semibold">팀에 공유할 연락처</h2>
          <ul className="max-h-72 divide-y divide-[var(--line)] overflow-y-auto text-[14px]">
            {mine.map((c) => (
              <li key={c.id}>
                <label className="flex items-center gap-2 py-2">
                  <input type="checkbox" checked={pick.includes(c.id)} onChange={(e) => setPick(e.target.checked ? [...pick, c.id] : pick.filter((x) => x !== c.id))} />
                  {c.fullName} <span className="text-[var(--fg-mute)]">{c.company ?? ""}</span>
                </label>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" checked={asLead} onChange={(e) => setAsLead(e.target.checked)} />회사 리드로 공유 (조직 소유 · 퇴사 시 회사에 남음)</label>
          <button className="btn btn-signal" disabled={!pick.length} onClick={() => run(async () => { await api(`/orgs/${orgId}/contacts`, { body: { contactIds: pick, asCompanyLead: asLead } }); setPick([]); setMode(null); }, "팀에 공유했어요.")}>{pick.length}명 공유</button>
        </section>
      )}

      {mode === "lead" && (
        <form className="surface space-y-3 p-5" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/orgs/${orgId}/leads`, { body: { ...Object.fromEntries(Object.entries(lead).map(([k, v]) => [k, v || null])), fullName: lead.fullName }, idempotencyKey: uid() }); setLead({ fullName: "", company: "", jobTitle: "", email: "", phone: "", assigneeUserId: "" }); setMode(null); }, "회사 리드를 추가했어요."); }}>
          <h2 className="font-semibold">회사 리드</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {([["fullName", "이름*"], ["company", "회사"], ["jobTitle", "직책"], ["email", "이메일"], ["phone", "전화"]] as const).map(([k, l]) => (
              <input key={k} className="field" placeholder={l} value={lead[k]} onChange={(e) => setLead({ ...lead, [k]: e.target.value })} required={k === "fullName"} aria-label={l} />
            ))}
            {can("leads.assign") && (
              <select className="field" value={lead.assigneeUserId} onChange={(e) => setLead({ ...lead, assigneeUserId: e.target.value })} aria-label="담당자">
                <option value="">담당: 나</option>
                {members.filter((m) => m.userId !== myId).map((m) => <option key={m.userId} value={m.userId}>담당: {m.name}</option>)}
              </select>
            )}
          </div>
          <button className="btn btn-signal">추가</button>
        </form>
      )}
    </div>
  );
}
