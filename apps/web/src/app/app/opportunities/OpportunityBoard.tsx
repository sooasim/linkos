"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { STAGE_LABELS, nextOpportunityStages, type OpportunityStage } from "@linkos/domain";
import { Icon } from "@/components/Icon";
import { Empty } from "@/components/Page";
import { api } from "@/lib/client";

// S12. 지침 §12: 자동으로 상대에게 발송하지 않는다 — 모든 전이는 사용자 행동이다.
// 전이는 학습 라벨로도 기록되어 다음 추천을 개선한다(N-016).

interface Opp {
  id: string;
  projectId: string | null;
  projectName: string | null;
  requirementName: string | null;
  stage: OpportunityStage;
  score: number | null;
  introductionId: string | null;
  health: { ageDays: number; stale: boolean; nextStep: string };
  target: { contactId: string; displayName: string | null; maskedLabel: string | null } | null;
}

export function OpportunityBoard() {
  const [data, setData] = useState<{ columns: OpportunityStage[]; opportunities: Opp[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setData(await api<{ columns: OpportunityStage[]; opportunities: Opp[] }>("/network-intel/opportunities"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const advance = async (id: string, stage: OpportunityStage) => {
    setBusy(id);
    try {
      await api(`/network-intel/opportunities/${id}`, { method: "PATCH", body: { stage } });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "단계를 바꾸지 못했습니다.");
    } finally {
      setBusy(null);
    }
  };

  if (err && !data) return <Empty title="기회를 불러오지 못했습니다" body={err} />;
  if (!data) return <div className="h-64 animate-pulse rounded-3xl border border-[var(--line)]" />;

  if (!data.opportunities.length) {
    return (
      <Empty
        title="아직 추적 중인 기회가 없습니다"
        body="네트워크 검색이나 프로젝트 커버리지에서 후보를 '기회로' 보내면 여기서 소개 → 미팅 → 성사까지 추적합니다."
        action={
          <Link className="btn btn-ink" href="/app/network">
            네트워크 검색
          </Link>
        }
      />
    );
  }

  return (
    <div>
      {err && (
        <p role="alert" className="mb-4 rounded-2xl border border-[var(--color-ember)] bg-[color-mix(in_srgb,var(--color-ember)_8%,transparent)] px-4 py-3 text-[13.5px]">
          {err}
        </p>
      )}
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex gap-3" style={{ minWidth: `${data.columns.length * 16}rem` }}>
          {data.columns.map((stage) => {
            const items = data.opportunities.filter((o) => o.stage === stage);
            return (
              <section key={stage} className="w-64 shrink-0" aria-label={STAGE_LABELS[stage]}>
                <h2 className="flex items-center justify-between px-1 pb-2 text-[13px] font-semibold">
                  {STAGE_LABELS[stage]}
                  <span className="rounded-full bg-[var(--bg-sunk)] px-2 py-0.5 text-[11px] text-[var(--fg-mute)]">{items.length}</span>
                </h2>
                <ul className="space-y-2">
                  {items.map((o) => (
                    <li key={o.id} className="rounded-2xl border border-[var(--line)] bg-[var(--bg-elev)] p-3">
                      <p className="flex items-center gap-1.5 text-[14px] font-medium">
                        {!o.target?.displayName && <Icon name="lock" size={13} className="shrink-0 text-[var(--fg-mute)]" aria-hidden />}
                        <span className="truncate">{o.target?.displayName ?? o.target?.maskedLabel ?? "대상 없음"}</span>
                      </p>
                      <p className="mt-1 text-[11.5px] text-[var(--fg-mute)]">
                        {[o.projectName, o.requirementName].filter(Boolean).join(" · ") || "프로젝트 없음"}
                        {o.score != null && ` · ${Math.round(o.score)}점`}
                      </p>
                      <p className={`mt-1.5 text-[11.5px] ${o.health.stale ? "text-[var(--color-ember)]" : "text-[var(--fg-mute)]"}`}>
                        {o.health.stale ? `${o.health.ageDays}일째 멈춤 — ` : ""}
                        {o.health.nextStep}
                      </p>
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {o.target && (
                          <Link className="chip !py-1 !text-[11.5px]" href={`/app/network/paths/${o.target.contactId}`}>
                            경로
                          </Link>
                        )}
                        {nextOpportunityStages(o.stage).map((next) => (
                          <button key={next} type="button" className="chip !py-1 !text-[11.5px]" disabled={busy === o.id} onClick={() => void advance(o.id, next)}>
                            → {STAGE_LABELS[next]}
                          </button>
                        ))}
                      </div>
                    </li>
                  ))}
                  {items.length === 0 && <li className="rounded-2xl border border-dashed border-[var(--line)] px-3 py-4 text-center text-[12px] text-[var(--fg-mute)]">비어 있음</li>}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
      <p className="mt-4 text-[12px] text-[var(--fg-mute)]">
        결과(성사·무산)를 기록하면 추천 가중치가 그 신호로 재조정됩니다. LINKOS 는 어떤 단계에서도 상대에게 자동으로 메일을 보내지 않습니다.
      </p>
    </div>
  );
}
