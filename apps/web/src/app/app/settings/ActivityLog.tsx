"use client";
// F-137 / F-166 내 활동 기록 — GET /me/audit (keyset paging). Only what the server returns is shown; audit_logs keeps no IP/device.
import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, relTime } from "@/lib/client";
import { auditLabel } from "./auditLabels";

interface Entry {
  id: string;
  action: string;
  entity_type: string | null;
  organization_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

const META_LABEL: Record<string, (v: unknown) => string> = {
  format: (v) => String(v).toUpperCase(),
  report: (v) => ({ contacts: "연락처", meetings: "미팅 보고서", relationships: "관계 보고서" })[String(v)] ?? String(v),
  period: (v) => (v ? "기간 지정" : ""),
  rows: (v) => `${v}행`,
  queued: (v) => `${v}건 대기`,
  count: (v) => `${v}건`,
  provider: (v) => String(v),
};

export function ActivityLog() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (before: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ entries: Entry[]; nextCursor: string | null }>(`/me/audit?limit=20${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      setEntries((cur) => (before && cur ? [...cur, ...r.entries] : r.entries));
      setCursor(r.nextCursor);
    } catch (e) {
      setError((e as Error).message);
      setEntries((cur) => cur ?? []);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    load(null);
  }, [load]);

  return (
    <div className="space-y-3" data-testid="activity-log">
      <p className="text-[13px] text-[var(--fg-mute)]">내 계정에서 일어난 내보내기·연동·삭제 같은 중요한 작업이 기록됩니다. 연락처 원문(전화·이메일)은 기록에 남기지 않습니다.</p>
      {error && (
        <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-[var(--color-ember)]" role="alert">
          활동 기록을 불러오지 못했어요: {error}
          <button className="btn btn-ghost !min-h-8 text-[12.5px]" onClick={() => load(null)}>다시 시도</button>
        </div>
      )}
      {entries === null ? (
        <div className="h-16 animate-pulse rounded-2xl bg-[var(--bg-sunk)]" aria-hidden />
      ) : entries.length === 0 && !error ? (
        <p className="text-[14px] text-[var(--fg-mute)]">아직 기록된 활동이 없어요.</p>
      ) : (
        <ul className="divide-y divide-[var(--line)] text-[14px]">
          {entries.map((e) => {
            const meta = Object.entries(e.metadata ?? {})
              .map(([k, v]) => META_LABEL[k]?.(v) ?? "")
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={e.id} className="flex items-start justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block font-medium">{auditLabel(e.action)}</span>
                  {(meta || e.organization_id) && <span className="block text-[12.5px] text-[var(--fg-mute)]">{[e.organization_id ? "조직" : "", meta].filter(Boolean).join(" · ")}</span>}
                </span>
                <time className="shrink-0 text-[12.5px] text-[var(--fg-mute)]" dateTime={e.created_at} title={fmtDate(e.created_at, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}>
                  {relTime(e.created_at)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <button className="btn btn-ghost !min-h-9 text-[13px]" disabled={busy} onClick={() => load(cursor)}>
          {busy ? "불러오는 중…" : "더 보기"}
        </button>
      )}
    </div>
  );
}
