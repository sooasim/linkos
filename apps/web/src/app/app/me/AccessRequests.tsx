"use client";
import { useEffect, useState } from "react";
import { api, relTime } from "@/lib/client";

// F-035 Access Request 승인/거절
export function AccessRequests() {
  const [items, setItems] = useState<any[]>([]);
  const load = () => api<{ requests: any[] }>("/access-requests").then((r) => setItems(r.requests)).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  const pending = items.filter((i) => i.status === "pending");
  if (!pending.length) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-[18px] font-semibold">공유 요청 {pending.length}</h2>
      <ul className="space-y-2">
        {pending.map((r) => (
          <li key={r.id} className="surface flex items-center gap-3 p-4">
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{r.requester_name ?? r.requester_email}</span>
              <span className="block text-[13px] text-[var(--fg-mute)]">숨김 항목 열람 요청 · {relTime(r.created_at)}</span>
            </span>
            <button className="btn btn-ghost !min-h-10" onClick={() => api(`/access-requests/${r.id}`, { body: { approve: false } }).then(load)}>거절</button>
            <button className="btn btn-signal !min-h-10" onClick={() => api(`/access-requests/${r.id}`, { body: { approve: true } }).then(load)}>승인</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
