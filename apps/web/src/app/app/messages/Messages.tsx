"use client";
// F-106 초안 목록 · 초안 삭제(확인 후) · F-111 템플릿 · 후속 시퀀스
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { MessageComposer, type MessageDto } from "@/components/MessageComposer";
import { Icon } from "@/components/Icon";
import { Empty } from "@/components/Page";
import { api, fmtDate, relTime, uid } from "@/lib/client";

type Tab = "drafts" | "sent" | "templates" | "sequences";
const TABS: [Tab, string][] = [["drafts", "초안"], ["sent", "보낸 메일"], ["templates", "템플릿"], ["sequences", "후속 시퀀스"]];

export function Messages() {
  const [tab, setTab] = useState<Tab>("drafts");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`chip ${tab === k ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>{l}</button>
        ))}
      </div>
      {tab === "drafts" && <MessageList status="draft" />}
      {tab === "sent" && <MessageList status="sent" />}
      {tab === "templates" && <Templates />}
      {tab === "sequences" && <Sequences />}
    </div>
  );
}

function MessageList({ status }: { status: "draft" | "sent" }) {
  const [list, setList] = useState<MessageDto[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const discard = async (m: MessageDto) => {
    if (!confirm(`‘${m.subject ?? "제목 없음"}’ 초안을 삭제할까요? 발송되지 않으며 목록에서 사라집니다.`)) return;
    setErr(null);
    try {
      await api(`/messages/${m.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const load = useCallback(() => api<{ messages: MessageDto[] }>(`/messages?status=${status}`).then((r) => setList(r.messages)), [status]);
  useEffect(() => {
    load();
  }, [load]);
  if (!list) return <div className="surface h-24 animate-pulse" />;
  if (!list.length) return <Empty title={status === "draft" ? "초안이 없어요" : "보낸 메일이 없어요"} body="사람 상세 화면에서 AI 초안이나 템플릿으로 메일을 작성하세요. 발송은 항상 직접 승인해야 합니다." />;
  return (
    <ul className="space-y-2">
      {err && <li className="text-[13px] text-[var(--color-ember)]" role="alert">{err}</li>}
      {list.map((m) => (
        <li key={m.id} className="relative">
          {open === m.id ? (
            <MessageComposer initial={m} contactId={m.contactId} onChange={load} onDiscard={() => setOpen(null)} />
          ) : (
            <div className="surface flex items-center">
            <button className="flex min-w-0 flex-1 items-center gap-3 p-4 text-left" onClick={() => setOpen(m.id)}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{m.subject ?? (m.channel === "sms" ? "문자 초안" : "(제목 없음)")}</span>
                <span className="block truncate text-[13px] text-[var(--fg-mute)]">{m.toName ?? m.toAddress ?? "받는 사람 없음"} · {m.body.slice(0, 60)}</span>
              </span>
              <span className="text-[12px] text-[var(--fg-mute)]">{m.sentAt ? relTime(m.sentAt) : m.provider === "gmail" && m.gmailDraftId ? "Gmail 초안" : ""}</span>
            </button>
            {status === "draft" && (
              <button type="button" className="mr-2 grid size-10 shrink-0 place-items-center rounded-full text-[var(--fg-mute)] hover:text-[var(--color-ember)]" aria-label={`‘${m.subject ?? "제목 없음"}’ 초안 삭제`} onClick={() => discard(m)} data-testid="discard-draft-row">
                <Icon name="trash" size={17} />
              </button>
            )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

const VARS = ["name", "firstName", "company", "jobTitle", "myName", "myCompany", "myTitle", "place", "date"];

function Templates() {
  const [list, setList] = useState<any[] | null>(null);
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState<{ id?: string; name: string; channel: "email" | "sms"; subject: string; body: string; scope: "user" | "org"; organizationId: string }>({ name: "", channel: "email", subject: "", body: "", scope: "user", organizationId: "" });
  const [err, setErr] = useState<string | null>(null);
  const load = () => api<{ templates: any[]; organizations: { id: string; name: string }[] }>("/templates").then((r) => {
    setList(r.templates);
    setOrgs(r.organizations);
  });
  useEffect(() => {
    load();
  }, []);
  const save = async () => {
    setErr(null);
    try {
      const body = { name: form.name, channel: form.channel, subject: form.channel === "email" ? form.subject : null, body: form.body, scope: form.scope, organizationId: form.scope === "org" ? form.organizationId : null };
      if (form.id) await api(`/templates/${form.id}`, { method: "PUT", body });
      else await api("/templates", { body, idempotencyKey: uid() });
      setForm({ name: "", channel: "email", subject: "", body: "", scope: "user", organizationId: "" });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <section className="surface space-y-3 p-4" aria-label="템플릿 편집">
        <p className="text-[13px] text-[var(--fg-mute)]">변수: {VARS.map((v) => <code key={v} className="mr-1.5">{`{{${v}}}`}</code>)} — 값이 없는 변수는 비워 두고 알려 드려요.</p>
        <input className="field" placeholder="템플릿 이름" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="템플릿 이름" />
        <div className="flex flex-wrap gap-2">
          {(["email", "sms"] as const).map((c) => <button key={c} className={`chip ${form.channel === c ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} onClick={() => setForm({ ...form, channel: c })}>{c === "email" ? "메일" : "문자"}</button>)}
          {orgs.length > 0 && (["user", "org"] as const).map((s) => <button key={s} className={`chip ${form.scope === s ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} onClick={() => setForm({ ...form, scope: s, organizationId: form.organizationId || orgs[0]!.id })}>{s === "user" ? "개인" : "팀"}</button>)}
        </div>
        {form.channel === "email" && <input className="field" placeholder="제목" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} aria-label="제목" />}
        <textarea className="field min-h-32" placeholder={"{{name}}님, {{place}}에서 반가웠습니다."} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} aria-label="본문" />
        <div className="flex gap-2">
          <button className="btn btn-signal" disabled={!form.name || !form.body} onClick={save}>{form.id ? "수정" : "템플릿 추가"}</button>
          {form.id && <button className="btn btn-ghost" onClick={() => setForm({ name: "", channel: "email", subject: "", body: "", scope: "user", organizationId: "" })}>취소</button>}
        </div>
        {err && <p className="text-[13px] text-[var(--color-ember)]" role="alert">{err}</p>}
      </section>
      {!list ? null : list.length === 0 ? <Empty title="템플릿이 없어요" /> : (
        <ul className="space-y-2">
          {list.map((t) => (
            <li key={t.id} className="surface p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">{t.name} <span className="chip ml-1">{t.scope === "org" ? "팀" : "개인"}</span> <span className="chip">{t.channel === "sms" ? "문자" : "메일"}</span></p>
                {t.editable && (
                  <span className="flex gap-3 text-[13px]">
                    <button onClick={() => setForm({ id: t.id, name: t.name, channel: t.channel, subject: t.subject ?? "", body: t.body, scope: t.scope, organizationId: t.organizationId ?? "" })}>편집</button>
                    <button className="text-[var(--color-ember)]" onClick={() => api(`/templates/${t.id}`, { method: "DELETE" }).then(load)}>삭제</button>
                  </span>
                )}
              </div>
              {t.subject && <p className="mt-1 text-[14px]">{t.subject}</p>}
              <p className="mt-1 whitespace-pre-wrap text-[13.5px] text-[var(--fg-mute)]">{t.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Sequences() {
  const [list, setList] = useState<any[] | null>(null);
  const load = () => api<{ sequences: any[] }>("/sequences").then((r) => setList(r.sequences));
  useEffect(() => {
    load();
  }, []);
  if (!list) return <div className="surface h-24 animate-pulse" />;
  if (!list.length) return <Empty title="후속 시퀀스가 없어요" body="사람 상세 화면에서 ‘후속 시퀀스’를 눌러 감사 메일 → 짧은 문자 → 2주 후 안부 초안을 한 번에 만드세요. 자동 발송은 없습니다." />;
  return (
    <ul className="space-y-2">
      {list.map((s) => (
        <li key={s.id} className="surface p-4 text-[14px]">
          <div className="flex items-center justify-between">
            <Link href={`/app/people/${s.contact.id}`} className="font-semibold underline-offset-2 hover:underline">{s.contact.fullName} · {s.name}</Link>
            {s.status === "active" ? <button className="text-[13px] text-[var(--color-ember)]" onClick={() => api(`/sequences/${s.id}`, { method: "DELETE" }).then(load)}>중단</button> : <span className="chip">{s.status === "cancelled" ? "중단됨" : s.status}</span>}
          </div>
          <ol className="mt-2 space-y-1 text-[var(--fg-mute)]">
            {s.steps.map((st: any) => <li key={st.followupId}>{fmtDate(st.dueAt)} · {st.channel === "sms" ? "문자" : "메일"} · {st.title} · {st.status}</li>)}
          </ol>
        </li>
      ))}
    </ul>
  );
}
