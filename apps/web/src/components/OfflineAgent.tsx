"use client";
// F-150 오프라인 모드 표시 + F-179 재동기화: replays the encrypted outbox on reconnect / Background Sync
// message / periodically, and surfaces conflicts that need a decision.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";

export default function OfflineAgent() {
  const [online, setOnline] = useState(true);
  const [s, setS] = useState({ pending: 0, conflicts: 0, failed: 0 });
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let alive = true;
    let off = () => undefined as void;
    const mod = import("@/lib/offline");
    const refresh = () => mod.then(async (m) => alive && setS(await m.outboxSummary())).catch(() => undefined);
    const flush = () =>
      mod.then(async (m) => {
        if (!navigator.onLine) return;
        setSyncing(true);
        try {
          await m.flushOutbox();
        } finally {
          if (alive) setSyncing(false);
          void refresh();
        }
      });
    const net = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void flush();
    };
    setOnline(navigator.onLine);
    void mod.then((m) => {
      off = m.onOfflineChange(() => void refresh());
    });
    void flush();
    window.addEventListener("online", net);
    window.addEventListener("offline", net);
    const onSw = (e: MessageEvent) => {
      if (e.data?.type === "flush-outbox") void flush();
      if (e.data?.type === "outbox-replayed") void refresh();
    };
    navigator.serviceWorker?.addEventListener("message", onSw);
    const timer = window.setInterval(() => void flush(), 30_000);
    return () => {
      alive = false;
      off();
      window.removeEventListener("online", net);
      window.removeEventListener("offline", net);
      navigator.serviceWorker?.removeEventListener("message", onSw);
      window.clearInterval(timer);
    };
  }, []);

  const attention = s.conflicts + s.failed;
  if (online && !s.pending && !attention) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center px-4" data-testid="offline-indicator">
      <div role="status" aria-live="polite" className="pointer-events-auto flex items-center gap-2 rounded-full bg-[var(--color-ink)] px-4 py-2 text-[13px] font-semibold text-white shadow-lg">
        <span aria-hidden className={`size-2 rounded-full ${online ? "bg-[var(--color-signal)]" : "bg-[var(--color-ember)]"}`} />
        {!online ? <span>오프라인{s.pending ? ` · 전송 대기 ${s.pending}건` : " · 변경사항은 기기에 암호화 보관"}</span> : s.pending ? <span>{syncing ? "동기화 중" : "전송 대기"} {s.pending}건</span> : null}
        {attention === 0 && s.pending > 0 && (
          // F-179: queued items are inspectable too, not only conflicts/failures
          <Link href="/app/sync" className="ml-1 rounded-full px-2 py-0.5 text-white underline underline-offset-2" aria-label={`전송 대기 ${s.pending}건 보기`} data-testid="offline-queue-link">
            보기
          </Link>
        )}
        {attention > 0 && (
          <Link href="/app/sync" className="ml-1 flex items-center gap-1 rounded-full bg-[var(--color-ember)] px-2.5 py-0.5 text-white underline-offset-2 hover:underline">
            <Icon name="merge" size={13} /> 확인 필요 {attention}
          </Link>
        )}
      </div>
    </div>
  );
}
