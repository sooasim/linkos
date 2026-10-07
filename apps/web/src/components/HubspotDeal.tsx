"use client";
// F-121 HubSpot 딜 — meeting outcome → deal DRAFT → user reviews/edits → explicit approval sends it (CLAUDE.md rule 8).
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/client";

const STAGES: [string, string][] = [["discovery", "발굴"], ["qualified", "검증"], ["proposal", "제안"], ["negotiation", "협상"], ["won", "성사"], ["lost", "실패"]];

interface Deal {
  id: string;
  name: string;
  amount: number | null;
  currency: string | null;
  closeDate: string | null;
  stage: string;
  stageLabel: string;
  description: string | null;
  status: "draft" | "approved" | "synced" | "discarded";
  version: number;
  sync: { jobId: string; status: string | null; error: string | null } | null;
  external: { id: string; url: string | null } | null;
}

const SYNC_LABEL: Record<string, string> = { queued: "전송 대기", retry: "재시도 예정", done: "전송 완료", dead: "실패", conflict: "충돌 — Sync Journal에서 결정", skipped: "외부 값 유지" };

export function HubspotDealPanel({ meetingId }: { meetingId: string }) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ deals: Deal[] }>(`/integrations/hubspot/deals?meetingId=${meetingId}`).then((r) => setDeals(r.deals)).catch(() => undefined), [meetingId]);
  useEffect(() => {
    load();
  }, [load]);

  const draft = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api("/integrations/hubspot/deals", { body: { meetingId }, offline: false });
      setMsg("초안을 만들었어요. 금액·마감일·단계를 확인한 뒤 승인해야 HubSpot에 만들어집니다.");
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-[var(--line)] pt-3" aria-label="HubSpot 딜">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-ghost !min-h-10 text-[14px]" onClick={draft} disabled={busy} data-testid="hubspot-deal-draft">
          <Icon name="plus" size={16} />HubSpot 딜 만들기 (승인 필요)
        </button>
      </div>
      <p className="text-[12.5px] text-[var(--fg-mute)]">초안은 LINKOS에만 저장됩니다. 금액·마감일은 추정하지 않으며, 승인한 내용만 HubSpot으로 보냅니다.</p>
      {msg && <p className="text-[13.5px]" role="status">{msg}</p>}
      {deals.map((d) => <DealEditor key={`${d.id}:${d.version}:${d.status}:${d.sync?.status ?? ""}`} deal={d} onChange={load} />)}
    </div>
  );
}

function DealEditor({ deal, onChange }: { deal: Deal; onChange: () => void }) {
  const [f, setF] = useState({ name: deal.name, amount: deal.amount == null ? "" : String(deal.amount), currency: deal.currency ?? "KRW", closeDate: deal.closeDate ?? "", stage: deal.stage, description: deal.description ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = deal.status === "draft" || deal.status === "synced" || (deal.status === "approved" && !!deal.sync && !["queued", "retry"].includes(deal.sync.status ?? ""));
  const dirty =
    f.name !== deal.name ||
    f.amount !== (deal.amount == null ? "" : String(deal.amount)) ||
    f.currency !== (deal.currency ?? "KRW") ||
    f.closeDate !== (deal.closeDate ?? "") ||
    f.stage !== deal.stage ||
    f.description !== (deal.description ?? "");

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(() =>
      api(`/integrations/hubspot/deals/${deal.id}`, {
        method: "PATCH",
        offline: false,
        body: { name: f.name, amount: f.amount === "" ? null : Number(f.amount), currency: f.amount === "" ? null : f.currency || null, closeDate: f.closeDate || null, stage: f.stage, description: f.description || null },
      }),
    );
  const approve = () => {
    if (!confirm(`'${deal.name}' 딜을 HubSpot에 ${deal.external ? "반영" : "생성"}합니다. 승인할까요?`)) return;
    return run(() => api(`/integrations/hubspot/deals/${deal.id}/approve`, { body: { version: deal.version }, offline: false }));
  };
  const discard = () => confirm("이 딜 초안을 삭제할까요?") && run(() => api(`/integrations/hubspot/deals/${deal.id}`, { method: "DELETE", offline: false }));

  const status = deal.status === "synced" ? "HubSpot 반영됨" : deal.status === "approved" ? (SYNC_LABEL[deal.sync?.status ?? "queued"] ?? deal.sync?.status) : deal.external ? "변경 사항 승인 대기" : "초안 · 승인 대기";
  return (
    <div className="space-y-2 rounded-[16px] border border-[var(--line)] p-3" data-testid="hubspot-deal">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className={`chip ${deal.status === "draft" ? "!border-[var(--color-ember)]" : ""}`}>{status}</span>
        <span className="text-[var(--fg-mute)]">v{deal.version}</span>
        {deal.external?.url && <a className="underline" href={deal.external.url} target="_blank" rel="noopener noreferrer">HubSpot에서 열기</a>}
      </div>
      <input className="field !min-h-9 text-[14px]" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="딜 이름" disabled={!editable} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <input className="field !min-h-9 text-[14px]" inputMode="decimal" placeholder="금액" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, "") })} aria-label="금액" disabled={!editable} />
        <select className="field !min-h-9 text-[14px]" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} aria-label="통화" disabled={!editable}>
          {["KRW", "USD", "JPY", "EUR"].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className="field !min-h-9 text-[14px]" type="date" value={f.closeDate} onChange={(e) => setF({ ...f, closeDate: e.target.value })} aria-label="마감 예정일" disabled={!editable} />
        <select className="field !min-h-9 text-[14px]" value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })} aria-label="단계" disabled={!editable}>
          {STAGES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      <textarea className="field min-h-20 text-[13.5px]" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} aria-label="딜 설명" disabled={!editable} />
      {deal.sync?.error && deal.status === "approved" && <p className="text-[12.5px] text-[var(--color-ember)]">{deal.sync.error}</p>}
      <div className="flex flex-wrap gap-2">
        {editable && dirty && <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={save} disabled={busy || !f.name.trim()}>변경 저장</button>}
        {deal.status === "draft" && !dirty && (
          <button className="btn btn-signal !min-h-9 text-[13px]" onClick={approve} disabled={busy} data-testid="hubspot-deal-approve">
            <Icon name="check" size={14} />승인하고 HubSpot에 {deal.external ? "반영" : "만들기"}
          </button>
        )}
        {!deal.external && deal.status !== "approved" && <button className="text-[13px] text-[var(--color-ember)]" onClick={discard} disabled={busy}>초안 삭제</button>}
      </div>
      {err && <p className="text-[13px] text-[var(--color-ember)]" role="alert">{err}</p>}
    </div>
  );
}
