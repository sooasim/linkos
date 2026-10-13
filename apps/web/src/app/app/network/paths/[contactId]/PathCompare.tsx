"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel, Empty } from "@/components/Page";
import { api } from "@/lib/client";

// S16: 같은 대상에 대한 Top-3 경로를 나란히 비교한다.
// 지침 §4: **최단 경로가 아니라** 실제 소개 가능성이 높은 경로가 기본 선택이다. 1순위에 그 이유를 적는다.

interface PathNode {
  id: string;
  label: string;
  masked: boolean;
  role?: string | null;
  company?: string | null;
}
interface Path {
  rank: number;
  hops: number;
  quality: number;
  cost: number;
  disclosure: string;
  introducerId: string | null;
  nodes: PathNode[];
  edges: { fromId: string; toId: string; relation: string; strength: number; confirmed: boolean; evidenceId: string | null }[];
  reasons: string[];
  breakdown: { edgeCost: number; hop: number; dormancy: number; privacy: number; conflict: number; sharedContext: number; diversity: number };
}
interface Res {
  target: { contactId: string; disclosure: string; displayName: string | null; maskedLabel: string | null; withheldReasons: string[] };
  paths: Path[];
}

const BREAKDOWN_LABEL: Record<string, string> = {
  edgeCost: "관계 품질 비용",
  hop: "중개자 수 페널티",
  dormancy: "휴면 페널티",
  privacy: "비공개 페널티",
  conflict: "이해충돌 페널티",
  sharedContext: "공유 맥락 보너스",
  diversity: "다양성 조정",
};

function PathChain({ p }: { p: Path }) {
  return (
    <ol className="space-y-2">
      {p.nodes.map((n, i) => {
        const edge = i > 0 ? p.edges[i - 1] : null;
        return (
          <li key={`${n.id}-${i}`}>
            {edge && (
              <p className="flex items-center gap-2 py-1 pl-3 text-[11.5px] text-[var(--fg-mute)]">
                <Icon name="arrow" size={13} className="rotate-90" aria-hidden />
                {edge.relation === "COLLEAGUE" ? "같은 조직" : "아는 사이"} · 강도 {edge.strength.toFixed(2)}
                {edge.confirmed ? "" : " · 추정"}
              </p>
            )}
            <div className={`flex items-center gap-2.5 rounded-2xl border px-3 py-2 ${i === 0 ? "border-[var(--accent)] bg-[var(--accent-soft)]" : n.masked ? "border-dashed border-[var(--line-strong)]" : "border-[var(--line)]"}`}>
              {n.masked ? <Icon name="lock" size={15} className="shrink-0 text-[var(--fg-mute)]" aria-hidden /> : <Icon name="me" size={15} className="shrink-0 text-[var(--fg-mute)]" aria-hidden />}
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium">{n.label}</p>
                {(n.company || n.role) && <p className="truncate text-[11.5px] text-[var(--fg-mute)]">{[n.company, n.role].filter(Boolean).join(" · ")}</p>}
              </div>
              {i === 1 && p.nodes.length > 2 && <span className="ml-auto shrink-0 rounded-full bg-[var(--bg-elev)] px-2 py-0.5 text-[10.5px] font-semibold">소개 부탁할 분</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function PathCompare({ contactId }: { contactId: string }) {
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState(0);
  const [detail, setDetail] = useState(false);
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    api<Res>("/network-intel/paths", { body: { targetContactId: contactId, k: 3, maxHops: 3 } })
      .then(setRes)
      .catch((e) => setErr(e instanceof Error ? e.message : "경로를 계산하지 못했습니다."));
  }, [contactId]);

  if (err) return <Empty title="경로를 계산하지 못했습니다" body={err} action={<Link className="btn btn-ghost" href="/app/network">네트워크로 돌아가기</Link>} />;
  if (!res) return <div className="space-y-3">{[0, 1].map((i) => <div key={i} className="h-56 animate-pulse rounded-3xl border border-[var(--line)]" />)}</div>;

  if (!res.paths.length) {
    return (
      <Empty
        title="소개 경로를 찾지 못했습니다"
        body="이 분에게 닿는 경로가 아직 없습니다. 연락처를 더 추가하거나, 조직 네트워크 공유에 동의한 동료가 있으면 경로가 생길 수 있습니다."
        action={
          <Link className="btn btn-ink" href="/app/network">
            다른 후보 보기
          </Link>
        }
      />
    );
  }

  const current = res.paths[picked]!;
  const shortest = Math.min(...res.paths.map((p) => p.hops));
  const best = res.paths[0]!;

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)] p-4 sm:p-5">
        <p className="label !mb-1">소개받을 대상</p>
        <p className="text-[17px] font-semibold">{res.target.displayName ?? res.target.maskedLabel}</p>
        {res.target.withheldReasons.length > 0 && <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]">{res.target.withheldReasons.join(" · ")}</p>}
        {best.hops > shortest && (
          <p className="mt-3 flex items-start gap-2 rounded-2xl bg-[var(--color-butter)] px-3 py-2 text-[12.5px] text-[var(--color-ink)]">
            <Icon name="bolt" size={15} className="mt-0.5 shrink-0" aria-hidden />
            가장 짧은 경로는 {shortest}촌이지만, 관계 강도·최근성·동의 상태를 반영하면 {best.hops}촌 경로의 소개 가능성이 더 높습니다.
          </p>
        )}
      </section>

      <div role="tablist" aria-label="소개 경로 후보" className="flex gap-2 overflow-x-auto pb-1">
        {res.paths.map((p, i) => (
          <button
            key={p.rank}
            role="tab"
            aria-selected={picked === i}
            onClick={() => setPicked(i)}
            className={`shrink-0 rounded-2xl border px-4 py-3 text-left transition ${picked === i ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--line)] bg-[var(--bg-elev)]"}`}
          >
            <p className="text-[13px] font-semibold">
              {i === 0 ? "추천 경로" : `대안 ${i}`} · {p.hops}촌
            </p>
            <p className="mt-0.5 text-[11.5px] text-[var(--fg-mute)]">품질 {p.quality.toFixed(2)} · 비용 {p.cost.toFixed(2)}</p>
          </button>
        ))}
      </div>

      <section className="rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)] p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15.5px] font-semibold">{picked === 0 ? "추천 경로" : `대안 경로 ${picked}`}</h2>
          <AiLabel>AI 추론</AiLabel>
        </div>

        <div className="mt-4">
          <PathChain p={current} />
        </div>

        <ul className="mt-4 space-y-1.5">
          {current.reasons.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-[13.5px]">
              <Icon name="check" size={15} className="mt-0.5 shrink-0 text-[var(--accent-text)]" aria-hidden />
              {r}
            </li>
          ))}
        </ul>

        <button className="btn btn-ghost mt-4 !min-h-10" onClick={() => setDetail(!detail)} aria-expanded={detail}>
          경로 비용 상세
        </button>
        {detail && (
          <div className="mt-3 rounded-2xl bg-[var(--bg-sunk)] p-3">
            <ul className="space-y-1 text-[12.5px]">
              {Object.entries(current.breakdown).map(([k, v]) => (
                <li key={k} className="flex justify-between gap-3">
                  <span className="text-[var(--fg-mute)]">{BREAKDOWN_LABEL[k] ?? k}</span>
                  <span className={`tabular-nums ${v < 0 ? "text-[var(--accent-text)]" : ""}`}>{v > 0 ? "+" : ""}{v.toFixed(3)}</span>
                </li>
              ))}
              <li className="flex justify-between gap-3 border-t border-[var(--line)] pt-1 font-semibold">
                <span>합계 비용 (낮을수록 좋음)</span>
                <span className="tabular-nums">{current.cost.toFixed(3)}</span>
              </li>
            </ul>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {current.introducerId ? (
            <Link className="btn btn-signal !min-h-11" href={`/app/intros?a=${current.introducerId}`}>
              <Icon name="share" size={17} aria-hidden />
              이 분께 소개 부탁하기
            </Link>
          ) : (
            <Link className="btn btn-signal !min-h-11" href={`/app/people/${contactId}`}>
              직접 연락하기
            </Link>
          )}
          <button
            className="btn btn-ghost !min-h-11"
            disabled={requested}
            onClick={async () => {
              await api("/network-intel/feedback", { body: { subjectType: "intro_path", subjectId: contactId, label: "intro_requested" } });
              setRequested(true);
            }}
          >
            {requested ? "기록됨" : "소개 요청했다고 기록"}
          </button>
        </div>
        <p className="mt-3 text-[12px] text-[var(--fg-mute)]">LINKOS 는 소개 메일을 자동으로 보내지 않습니다. 중개자에게 직접 부탁하고, 양측 동의 후에 연락처가 공개됩니다.</p>
      </section>
    </div>
  );
}
