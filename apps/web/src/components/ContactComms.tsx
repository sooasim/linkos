"use client";
// Person detail entry point: message composer (F-104/F-106/F-111/F-112/F-115) + F-105 follow-up sequence.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { MessageComposer, type MessageDto } from "@/components/MessageComposer";
import { api, fmtDate, uid } from "@/lib/client";

export function ContactComms({ contactId, email, phone }: { contactId: string; email: string | null; phone: string | null }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [sequences, setSequences] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ messages: MessageDto[] }>(`/messages?contactId=${contactId}`).then((r) => setMessages(r.messages)).catch(() => undefined);
    api<{ sequences: any[] }>(`/sequences?contactId=${contactId}`).then((r) => setSequences(r.sequences)).catch(() => undefined);
  }, [contactId]);
  useEffect(load, [load]);

  const startSequence = async () => {
    setBusy(true);
    try {
      await api("/sequences", { body: { contactId, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, idempotencyKey: uid() });
      setFlash("오늘 · 3일 후 · 2주 후 후속 초안을 만들었어요. 각 단계는 직접 확인하고 보냅니다.");
      load();
    } catch (e) {
      setFlash((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 space-y-3" aria-label="메시지">
      <div className="flex items-center justify-between">
        <h2 className="text-[18px] font-semibold">메시지</h2>
        <Link href="/app/messages" className="text-[13px] text-[var(--fg-mute)] underline">템플릿·보낸 메일</Link>
      </div>
      {open ? (
        <MessageComposer contactId={contactId} email={email} phone={phone} onChange={load} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ink !min-h-10 text-[14px]" onClick={() => setOpen(true)}><Icon name="mail" size={16} />메일 작성</button>
          <button className="btn btn-ghost !min-h-10 text-[14px]" disabled={busy} onClick={startSequence}><Icon name="calendar" size={16} />후속 시퀀스</button>
        </div>
      )}
      {flash && <p className="text-[13.5px]" role="status">{flash}</p>}
      {sequences.filter((s) => s.status === "active").map((s) => (
        <div key={s.id} className="surface p-4 text-[14px]">
          <div className="flex items-center justify-between">
            <p className="font-semibold">{s.name}</p>
            <button className="text-[13px] text-[var(--color-ember)]" onClick={() => api(`/sequences/${s.id}`, { method: "DELETE" }).then(load)}>중단</button>
          </div>
          <ol className="mt-2 space-y-1 text-[var(--fg-mute)]">
            {s.steps.map((st: any) => <li key={st.followupId}>{fmtDate(st.dueAt)} · {st.channel === "sms" ? "문자" : "메일"} · {st.title} · {st.status === "open" ? "대기" : st.status}</li>)}
          </ol>
        </div>
      ))}
      {messages.length > 0 && (
        <ul className="surface divide-y divide-[var(--line)] text-[14px]">
          {messages.slice(0, 6).map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="min-w-0 truncate">{m.subject ?? m.body.slice(0, 40)}</span>
              <span className="chip shrink-0">{m.status === "sent" ? "보냄" : m.status === "draft" ? (m.channel === "sms" ? "문자 초안" : "초안") : m.status === "failed" ? "실패" : m.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
