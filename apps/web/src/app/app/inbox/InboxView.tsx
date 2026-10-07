"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Avatar, Empty } from "@/components/Page";
import { api, relTime } from "@/lib/client";

const FIELD_KO: Record<string, string> = { company: "회사", jobTitle: "직책", website: "웹사이트" };
const KIND_KO: Record<string, string> = { booking: "미팅 예약", quote: "견적 요청", proposal: "제안 요청", nda: "NDA 요청" };
const STATUS_KO: Record<string, string> = { new: "새 요청", in_progress: "진행 중", done: "완료", declined: "거절" };

type Note = { id: string; kind: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string };
type Update = { id: string; contact_id: string; full_name: string; changes: { field: string; from: string | null; to: string }[]; created_at: string };
type Req = { id: string; kind: string; requester_name: string; requester_email: string; requester_company: string | null; message: string | null; details: Record<string, unknown>; status: string; created_at: string };

export function InboxView() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [updates, setUpdates] = useState<Update[]>([]);
  const [requests, setRequests] = useState<Req[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [n, u, r] = await Promise.all([api<{ notifications: Note[]; unread: number }>("/notifications"), api<{ updates: Update[] }>("/living-updates"), api<{ requests: Req[] }>("/action-requests")]);
    setNotes(n.notifications);
    setUnread(n.unread);
    setUpdates(u.updates);
    setRequests(r.requests);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (id: string, accept: boolean) => {
    setBusy(id);
    try {
      await api(`/living-updates/${id}`, { body: { accept } });
      await load();
    } finally {
      setBusy(null);
    }
  };
  const setStatus = async (id: string, status: string) => {
    setBusy(id);
    try {
      await api(`/action-requests/${id}`, { method: "PATCH", body: { status } });
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (!notes) return <div className="surface h-40 animate-pulse" />;
  return (
    <div className="space-y-8">
      <section aria-labelledby="lu-h">
        <h2 id="lu-h" className="mb-3 text-[18px] font-semibold">연락처 갱신 제안 <span className="num text-[var(--fg-mute)]">{updates.length}</span></h2>
        {updates.length === 0 ? (
          <Empty title="새 갱신 제안이 없어요" body="연결된 사람이 회사·직책·웹사이트를 바꾸면 여기에서 바로 반영할 수 있어요." />
        ) : (
          <ul className="space-y-2">
            {updates.map((u) => (
              <li key={u.id} className="surface p-4">
                <div className="flex items-center gap-3">
                  <Avatar name={u.full_name} size={36} />
                  <Link href={`/app/people/${u.contact_id}`} className="font-semibold">{u.full_name}</Link>
                  <span className="ml-auto text-[12.5px] text-[var(--fg-mute)]">{relTime(u.created_at)}</span>
                </div>
                <ul className="mt-3 space-y-1 text-[14px]">
                  {u.changes.map((c) => (
                    <li key={c.field}>
                      <span className="text-[var(--fg-mute)]">{FIELD_KO[c.field] ?? c.field}</span> {c.from ?? "—"} <Icon name="arrow" size={13} /> <b>{c.to}</b>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]">상대가 직접 수정한 Living Card 정보예요 (출처: 동기화).</p>
                <div className="mt-3 flex gap-2">
                  <button className="btn btn-signal" disabled={busy === u.id} onClick={() => resolve(u.id, true)}>반영하기</button>
                  <button className="btn btn-ghost" disabled={busy === u.id} onClick={() => resolve(u.id, false)}>무시</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="req-h">
        <h2 id="req-h" className="mb-3 text-[18px] font-semibold">내 카드로 받은 요청</h2>
        {requests.length === 0 ? (
          <Empty title="아직 받은 요청이 없어요" body="카드 편집에서 예약·견적·제안·NDA 버튼을 켜면 상대가 로그인 없이 요청할 수 있어요." action={<Link href="/app/me/edit" className="btn btn-ghost">Action Card 설정</Link>} />
        ) : (
          <ul className="space-y-2">
            {requests.map((r) => (
              <li key={r.id} className="surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip">{KIND_KO[r.kind] ?? r.kind}</span>
                  <span className="font-semibold">{r.requester_name}</span>
                  {r.requester_company && <span className="text-[13px] text-[var(--fg-mute)]">{r.requester_company}</span>}
                  <span className="ml-auto text-[12.5px] text-[var(--fg-mute)]">{relTime(r.created_at)} · {STATUS_KO[r.status] ?? r.status}</span>
                </div>
                {r.message && <p className="mt-2 whitespace-pre-wrap text-[14px]">{r.message}</p>}
                {Object.keys(r.details ?? {}).length > 0 && (
                  <p className="mt-1 text-[13px] text-[var(--fg-mute)]">{Object.entries(r.details).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`).join(" · ")}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <a className="btn btn-ghost" href={`mailto:${r.requester_email}`}><Icon name="mail" size={16} /> 답장</a>
                  {r.status !== "done" && <button className="btn btn-ghost" disabled={busy === r.id} onClick={() => setStatus(r.id, "done")}>완료</button>}
                  {r.status === "new" && <button className="btn btn-ghost" disabled={busy === r.id} onClick={() => setStatus(r.id, "declined")}>거절</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="nt-h">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="nt-h" className="text-[18px] font-semibold">알림 <span className="num text-[var(--fg-mute)]">{unread}</span></h2>
          {unread > 0 && <button className="btn btn-ghost !min-h-10 text-[14px]" onClick={() => api("/notifications/all/read", { body: {} }).then(load)}>모두 읽음</button>}
        </div>
        {notes.length === 0 ? (
          <Empty title="알림이 없어요" />
        ) : (
          <ul className="surface divide-y divide-[var(--line)]">
            {notes.map((n) => (
              <li key={n.id} className={`flex items-start gap-3 px-4 py-3 ${n.read_at ? "opacity-60" : ""}`}>
                <span aria-hidden className={`mt-2 size-2 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-[var(--color-signal)]"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-semibold">{n.title}</span>
                  {n.body && <span className="block whitespace-pre-wrap text-[13px] text-[var(--fg-mute)]">{n.body}</span>}
                  <span className="block text-[12px] text-[var(--fg-mute)]">{relTime(n.created_at)}</span>
                </span>
                {!n.read_at && (
                  <button className="grid size-10 place-items-center text-[var(--fg-mute)]" aria-label="읽음으로 표시" onClick={() => api(`/notifications/${n.id}/read`, { body: {} }).then(load)}>
                    <Icon name="check" size={18} />
                  </button>
                )}
                {n.link && n.link !== "/app/inbox" && (
                  <Link href={n.link} className="grid size-10 place-items-center" aria-label="열기"><Icon name="arrow" size={18} /></Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
