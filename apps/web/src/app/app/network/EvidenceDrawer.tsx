"use client";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel } from "@/components/Page";
import type { Reco } from "./NetworkHub";

// S19 Evidence Drawer (N-108): 추천의 모든 이유를 원천·날짜·confidence·추론여부와 함께 확인한다.
// 근거 없는 주장은 서버가 이미 걸러낸다(groundedReasons) — 여기서는 남은 것을 그대로 보여준다.

const TYPE_LABEL: Record<string, string> = {
  business_card: "명함",
  user_confirmed: "사용자 확인",
  meeting: "미팅 기록",
  interaction: "접촉 기록",
  referral: "소개 이력",
  note: "메모",
  company_data: "회사 정보",
  org_membership: "조직 소속",
  ai_inferred: "AI 추론",
};

const SOURCE_LABEL: Record<string, string> = { field: "구조화 필드", evidence: "근거 기록", score: "점수 설명" };

export function EvidenceDrawer({ reco, onClose }: { reco: Reco; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[color-mix(in_srgb,var(--color-ink)_38%,transparent)]" onClick={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="추천 근거"
        className="h-full w-full max-w-md overflow-y-auto border-l border-[var(--line)] bg-[var(--bg)] p-5 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="label !mb-1">추천 근거</p>
            <p className="text-[16px] font-semibold">{reco.displayName ?? reco.maskedLabel}</p>
          </div>
          <button className="btn btn-ghost !min-h-10 !px-3" onClick={onClose} aria-label="닫기">
            <Icon name="x" size={18} aria-hidden />
          </button>
        </div>

        <section className="mt-5">
          <p className="label">추천 이유</p>
          {reco.reasons.length === 0 ? (
            <p className="text-[13.5px] text-[var(--fg-mute)]">표시할 수 있는 근거가 없습니다.</p>
          ) : (
            <ul className="space-y-2">
              {reco.reasons.map((r, i) => (
                <li key={i} className="rounded-2xl border border-[var(--line)] p-3">
                  <p className="text-[13.5px]">{r.text}</p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--fg-mute)]">
                    <span>{SOURCE_LABEL[r.source] ?? r.source}</span>
                    {r.evidenceId && <span className="font-mono">#{r.evidenceId.slice(0, 8)}</span>}
                    {r.inferred && <AiLabel>추정</AiLabel>}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-5">
          <p className="label">원천 기록 {reco.evidence.length}건</p>
          {reco.evidence.length === 0 ? (
            <p className="text-[13.5px] text-[var(--fg-mute)]">이 후보에 연결된 기록이 없습니다. 미팅·소개 활동을 기록하면 추천이 정확해집니다.</p>
          ) : (
            <ul className="space-y-2">
              {reco.evidence.map((e) => (
                <li key={e.id} className="rounded-2xl border border-[var(--line)] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[13.5px]">{e.summary}</p>
                    <span className="shrink-0 rounded-full bg-[var(--bg-sunk)] px-2 py-0.5 text-[11px] font-semibold text-[var(--fg-mute)]">{TYPE_LABEL[e.type] ?? e.type}</span>
                  </div>
                  <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--fg-mute)]">
                    {e.occurredAt && <span>{new Date(e.occurredAt).toLocaleDateString("ko-KR")}</span>}
                    <span>신뢰도 {Math.round(e.confidence * 100)}%</span>
                    {e.inferred && <AiLabel>AI 추론</AiLabel>}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {reco.withheldReasons.length > 0 && (
          <section className="mt-5 rounded-2xl bg-[var(--bg-sunk)] p-3">
            <p className="label">공개하지 않은 정보</p>
            <ul className="space-y-1 text-[12.5px] text-[var(--fg-mute)]">
              {reco.withheldReasons.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
