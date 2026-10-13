"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel, Empty } from "@/components/Page";
import { api } from "@/lib/client";

// S10. 지침 §11:
//  * 분해 결과는 **초안**이다 — 사용자가 검토·확정해야 요구사항이 된다.
//  * 각 초안은 출처 문장을 보여준다(AI 가 지어내지 않았음을 확인할 수 있게).
//  * Gap 은 외부 데이터를 무단 결합해 채우지 않는다. 제안만 하고 외부 provider 는 승인을 받는다.

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string;
  targetRegions: string[];
  targetIndustries: string[];
  requirementsConfirmed: boolean;
  requirementCount: number;
  gapCount: number;
}

interface Requirement {
  id: string;
  kind: string;
  name: string;
  priority: number;
  sourceSentence: string | null;
  provenance: string;
  accepted: boolean;
}

interface CoverageCandidate {
  resultId: string;
  score: number;
  disclosure: string;
  hops: number | null;
  hasPath: boolean;
  displayName: string | null;
  maskedLabel: string | null;
}

interface Cell {
  requirementId: string;
  kind: string;
  name: string;
  priority: number;
  status: "covered" | "partial" | "gap";
  candidateCount: number;
  bestScore: number;
  topCandidates: CoverageCandidate[];
  reasons: string[];
}

interface Coverage {
  projectId: string;
  requirementsConfirmed: boolean;
  requirements: Requirement[];
  coverage: Cell[];
  summary: { total: number; covered: number; partial: number; gap: number; coverageRate: number; criticalGaps: { requirementId: string; name: string; priority: number }[] };
  gapSuggestions: { requirementId: string; name: string; action: string; text: string; requiresApproval: boolean }[];
}

const STATUS: Record<Cell["status"], { label: string; cls: string }> = {
  covered: { label: "충족", cls: "bg-[var(--color-mint)] text-[var(--color-ink)]" },
  partial: { label: "부분", cls: "bg-[var(--color-butter)] text-[var(--color-ink)]" },
  gap: { label: "공백", cls: "bg-[color-mix(in_srgb,var(--color-ember)_16%,transparent)] text-[var(--fg)]" },
};

function NewProject({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", description: "" });
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button className="btn btn-ink !min-h-11" onClick={() => setOpen(true)}>
        <Icon name="plus" size={17} aria-hidden />
        프로젝트 만들기
      </button>
    );
  return (
    <form
      className="space-y-2 rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)] p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const r = await api<{ projectId: string }>("/network-intel/projects", { body: { name: f.name, description: f.description } });
          onCreated(r.projectId);
          setOpen(false);
          setF({ name: "", description: "" });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="label" htmlFor="pname">
        프로젝트 이름
      </label>
      <input id="pname" className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="예: 베트남 의료기기 유통 진출" required minLength={1} />
      <label className="label" htmlFor="pdesc">
        무엇이 필요한지 적어주세요
      </label>
      <textarea
        id="pdesc"
        className="field min-h-28"
        value={f.description}
        onChange={(e) => setF({ ...f, description: e.target.value })}
        placeholder="예: 현지 유통 파트너가 필요합니다. 병원 구매 담당자를 소개받고 싶습니다. 반드시 인허가 컨설팅이 필요해요."
      />
      <p className="text-[12px] text-[var(--fg-mute)]">적어주신 문장에서 필요한 역할·조건을 뽑아 초안을 만듭니다. 문장에 없는 조건은 만들지 않습니다.</p>
      <div className="flex gap-2">
        <button className="btn btn-signal !min-h-10" disabled={busy || !f.name.trim()}>
          {busy ? "만드는 중…" : "만들기"}
        </button>
        <button type="button" className="btn btn-ghost !min-h-10" onClick={() => setOpen(false)}>
          취소
        </button>
      </div>
    </form>
  );
}

function CoverageView({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Coverage | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const d = await api<Coverage>(`/network-intel/projects/${projectId}/coverage`);
      setData(d);
      setPicked(new Set(d.requirements.filter((r) => !r.accepted).map((r) => r.id)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "커버리지를 계산하지 못했습니다.");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (err) return <Empty title="커버리지를 계산하지 못했습니다" body={err} />;
  if (!data) return <div className="h-64 animate-pulse rounded-3xl border border-[var(--line)]" />;

  const drafts = data.requirements.filter((r) => !r.accepted);

  return (
    <div className="space-y-5">
      {data.requirements.length === 0 ? (
        <Empty
          title="아직 요구사항이 없습니다"
          body="프로젝트 설명에서 필요한 역할·조건 초안을 만들어 보세요."
          action={
            <button
              className="btn btn-ink"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/network-intel/projects/${projectId}/analyze`, { body: {} });
                  await load();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "분해 중…" : "역할·조건 뽑기"}
            </button>
          }
        />
      ) : (
        <>
          {drafts.length > 0 && (
            <section className="rounded-3xl border border-[var(--accent)] bg-[var(--accent-soft)] p-4">
              <p className="flex items-center gap-2 text-[15px] font-semibold">
                검토가 필요한 초안 {drafts.length}개 <AiLabel>AI 초안</AiLabel>
              </p>
              <p className="mt-1 text-[12.5px]">확정한 항목만 요구사항이 됩니다. 선택하지 않은 초안은 삭제됩니다.</p>
              <ul className="mt-3 space-y-2">
                {drafts.map((r) => (
                  <li key={r.id} className="rounded-2xl bg-[var(--bg-elev)] p-3">
                    <label className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        className="mt-1 size-4 shrink-0"
                        checked={picked.has(r.id)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          setPicked(next);
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block text-[14px] font-medium">
                          <span className="mr-1.5 rounded-full bg-[var(--bg-sunk)] px-2 py-0.5 text-[10.5px] font-semibold">{r.kind === "role" ? "역할" : "필요"}</span>
                          {r.name}
                          {r.priority <= 2 && <span className="ml-1.5 text-[11px] text-[var(--color-ember)]">우선순위 {r.priority}</span>}
                        </span>
                        {r.sourceSentence && <span className="mt-1 block text-[12px] text-[var(--fg-mute)]">출처: “{r.sourceSentence}”</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="btn btn-ink !min-h-10"
                  disabled={busy || picked.size === 0}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(`/network-intel/projects/${projectId}/requirements/confirm`, { body: { requirementIds: [...picked] } });
                      await load();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {picked.size}개 확정
                </button>
                <button
                  className="btn btn-ghost !min-h-10"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(`/network-intel/projects/${projectId}/analyze`, { body: {} });
                      await load();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  다시 분해
                </button>
              </div>
            </section>
          )}

          <section className="rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)] p-4 sm:p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="label !mb-1">네트워크 커버리지</p>
                <p className="text-[28px] font-semibold leading-none">{Math.round(data.summary.coverageRate * 100)}%</p>
                <p className="mt-1 text-[12px] text-[var(--fg-mute)]">우선순위 가중 · 충족 {data.summary.covered} · 부분 {data.summary.partial} · 공백 {data.summary.gap}</p>
              </div>
              <div className="flex gap-1.5" role="img" aria-label={`커버리지 ${Math.round(data.summary.coverageRate * 100)}%`}>
                {data.coverage.map((c) => (
                  <span key={c.requirementId} className={`h-8 w-3 rounded-full ${STATUS[c.status].cls}`} title={`${c.name}: ${STATUS[c.status].label}`} />
                ))}
              </div>
            </div>
            {data.summary.criticalGaps.length > 0 && (
              <p className="mt-3 rounded-2xl bg-[color-mix(in_srgb,var(--color-ember)_10%,transparent)] px-3 py-2 text-[12.5px]">
                진행을 막는 공백: {data.summary.criticalGaps.map((g) => g.name).join(", ")}
              </p>
            )}
          </section>

          <ul className="space-y-3">
            {data.coverage.map((c) => (
              <li key={c.requirementId} data-reveal className="rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[15.5px] font-semibold">
                    <span className="mr-2 rounded-full bg-[var(--bg-sunk)] px-2 py-0.5 text-[10.5px] font-semibold">{c.kind === "role" ? "역할" : "필요"}</span>
                    {c.name}
                  </p>
                  <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${STATUS[c.status].cls}`}>{STATUS[c.status].label}</span>
                </div>
                <p className="mt-1.5 text-[12.5px] text-[var(--fg-mute)]">{c.reasons.join(" · ")}</p>

                {c.topCandidates.length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                    {c.topCandidates.slice(0, 3).map((cand) => (
                      <li key={cand.resultId} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-[var(--bg-sunk)] px-3 py-2 text-[13px]">
                        <span className="flex items-center gap-2">
                          {cand.disclosure === "masked" && <Icon name="lock" size={14} className="text-[var(--fg-mute)]" aria-hidden />}
                          {cand.displayName ?? cand.maskedLabel}
                        </span>
                        <span className="flex items-center gap-2 text-[12px] text-[var(--fg-mute)]">
                          <span>{Math.round(cand.score)}점</span>
                          {cand.hasPath ? <Link className="underline" href={`/app/network/paths/${cand.resultId}`}>경로</Link> : <span>경로 없음</span>}
                          <button
                            className="underline"
                            onClick={async () => {
                              await api("/network-intel/opportunities", { body: { projectId, requirementId: c.requirementId, targetContactId: cand.resultId, score: cand.score } }).catch(() => undefined);
                            }}
                          >
                            기회로
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {(c.status === "gap" || c.status === "partial") && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[12.5px] text-[var(--fg-mute)]">공백을 메우는 방법</summary>
                    <ul className="mt-2 space-y-1.5">
                      {data.gapSuggestions
                        .filter((s) => s.requirementId === c.requirementId)
                        .map((s, i) => (
                          <li key={i} className="flex items-start gap-2 text-[12.5px]">
                            <Icon name="arrow" size={14} className="mt-0.5 shrink-0 text-[var(--fg-mute)]" aria-hidden />
                            <span>
                              {s.text}
                              {s.requiresApproval && <span className="ml-1.5 rounded-full bg-[var(--color-butter)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--color-ink)]">승인 필요</span>}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function ProjectsHub({ initialId }: { initialId: string | null }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId);

  const load = useCallback(async () => {
    const r = await api<{ projects: Project[] }>("/network-intel/projects");
    setProjects(r.projects);
    setSelected((s) => s ?? r.projects[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!projects) return <div className="h-40 animate-pulse rounded-3xl border border-[var(--line)]" />;

  return (
    <div className="space-y-5">
      <NewProject
        onCreated={async (id) => {
          await load();
          setSelected(id);
          await api(`/network-intel/projects/${id}/analyze`, { body: {} }).catch(() => undefined);
        }}
      />

      {projects.length === 0 ? (
        <Empty title="아직 프로젝트가 없습니다" body="추진 중인 일을 프로젝트로 만들면, 필요한 역할별로 내 네트워크에 누가 있고 어디가 비어 있는지 보여줍니다." />
      ) : (
        <>
          <div role="tablist" aria-label="프로젝트" className="flex gap-2 overflow-x-auto pb-1">
            {projects.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={selected === p.id}
                onClick={() => setSelected(p.id)}
                className={`shrink-0 rounded-2xl border px-4 py-2.5 text-left ${selected === p.id ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--line)] bg-[var(--bg-elev)]"}`}
              >
                <p className="text-[13.5px] font-semibold">{p.name}</p>
                <p className="mt-0.5 text-[11.5px] text-[var(--fg-mute)]">
                  요구사항 {p.requirementCount}
                  {p.gapCount > 0 && ` · 공백 ${p.gapCount}`}
                  {!p.requirementsConfirmed && " · 검토 필요"}
                </p>
              </button>
            ))}
          </div>
          {selected && <CoverageView key={selected} projectId={selected} />}
        </>
      )}
    </div>
  );
}
