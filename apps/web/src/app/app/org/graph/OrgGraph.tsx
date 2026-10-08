"use client";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel, Empty } from "@/components/Page";
import { api } from "@/lib/client";

interface GNode { id: string; kind: "member" | "contact" | "company"; label: string; x: number; y: number; meta: Record<string, unknown> }
interface GEdge { source: string; target: string; weight: number; kind: string; count: number }
interface Graph { width: number; height: number; nodes: GNode[]; edges: GEdge[]; privacy: string }

const FILL: Record<GNode["kind"], string> = { member: "var(--color-signal)", contact: "var(--fg)", company: "var(--color-ember)" };
const R: Record<GNode["kind"], number> = { member: 11, contact: 6, company: 9 };

// F-133 관계 그래프 (server-side deterministic force layout → SVG) · F-134 Who Knows Whom
export function OrgGraph({ orgId }: { orgId: string }) {
  const [g, setG] = useState<Graph | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [company, setCompany] = useState("");
  const [who, setWho] = useState<any>(null);
  useEffect(() => {
    api<Graph>(`/orgs/${orgId}/graph`).then(setG).catch((e) => setErr(e.message));
  }, [orgId]);

  const byId = useMemo(() => new Map((g?.nodes ?? []).map((n) => [n.id, n])), [g]);
  const neighbors = useMemo(() => {
    const s = new Set<string>();
    if (!focus || !g) return s;
    s.add(focus);
    for (const e of g.edges) {
      if (e.source === focus) s.add(e.target);
      if (e.target === focus) s.add(e.source);
    }
    return s;
  }, [focus, g]);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setWho(await api(`/orgs/${orgId}/who-knows?company=${encodeURIComponent(company)}`));
  };

  return (
    <div className="space-y-6">
      <section className="surface space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Icon name="search" size={19} />Who Knows Whom <AiLabel>관계 강도 기반 추론</AiLabel></h2>
        <form onSubmit={search} className="flex gap-2">
          <label htmlFor="whoco" className="sr-only">회사 이름</label>
          <input id="whoco" className="field flex-1" placeholder="회사 이름 (예: 삼성전자)" value={company} onChange={(e) => setCompany(e.target.value)} minLength={2} required />
          <button className="btn btn-signal">찾기</button>
        </form>
        {who && (who.results.length === 0 ? (
          <p className="text-[14px] text-[var(--fg-mute)]">팀에서 이 회사를 아는 사람을 찾지 못했어요.</p>
        ) : (
          <ol className="space-y-2">
            {who.results.map((r: any, i: number) => (
              <li key={r.memberId} className="rounded-2xl border border-[var(--line)] p-3">
                <p className="font-semibold"><span className="num mr-2 text-[var(--fg-mute)]">{i + 1}</span>{r.memberName} <span className="chip ml-1">점수 {r.score}</span></p>
                <ul className="mt-1 text-[13.5px]">
                  {r.contacts.slice(0, 5).map((c: any, j: number) => (
                    <li key={j}>{c.shared ? `${c.name}${c.jobTitle ? ` · ${c.jobTitle}` : ""}` : "비공개 개인 연락처"} <span className="text-[var(--fg-mute)]">강도 {c.strength}</span></li>
                  ))}
                </ul>
                <p className="mt-1 text-[12px] text-[var(--fg-mute)]">{r.reasons.join(" · ")}</p>
              </li>
            ))}
          </ol>
        ))}
      </section>

      {err ? <Empty title="그래프를 불러오지 못했어요" body={err} /> : !g ? <div className="surface h-80 animate-pulse" /> : g.nodes.length <= 1 ? (
        <Empty title="아직 연결이 없어요" body="팀 주소록에 연락처를 공유하면 그래프가 그려집니다." />
      ) : (
        <section className="surface overflow-hidden p-2">
          <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-[12.5px] text-[var(--fg-mute)]">
            {(["member", "contact", "company"] as const).map((k) => (
              <span key={k} className="flex items-center gap-1.5"><svg width="12" height="12" aria-hidden><circle cx="6" cy="6" r="5" fill={FILL[k]} /></svg>{{ member: "멤버", contact: "공유 연락처", company: "회사" }[k]}</span>
            ))}
            <span>· 점선 = 개인 인맥의 회사 단위 집계(이름 비공개)</span>
          </div>
          <svg viewBox={`0 0 ${g.width} ${g.height}`} className="h-auto w-full" role="img" aria-label={`조직 관계 그래프: 노드 ${g.nodes.length}개, 연결 ${g.edges.length}개`}>
            <g>
              {g.edges.map((e, i) => {
                const a = byId.get(e.source);
                const b = byId.get(e.target);
                if (!a || !b) return null;
                const dim = focus && !(neighbors.has(e.source) && neighbors.has(e.target));
                return (
                  <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--fg)" strokeOpacity={dim ? 0.06 : 0.18 + e.weight * 0.5} strokeWidth={0.6 + e.weight * 2.2} strokeDasharray={e.kind === "knows_company" ? "4 3" : undefined} />
                );
              })}
            </g>
            <g>
              {g.nodes.map((n) => {
                const dim = focus && !neighbors.has(n.id);
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x},${n.y})`}
                    opacity={dim ? 0.25 : 1}
                    tabIndex={0}
                    role="button"
                    aria-label={`${n.label} (${n.kind})`}
                    onMouseEnter={() => setFocus(n.id)}
                    onMouseLeave={() => setFocus(null)}
                    onFocus={() => setFocus(n.id)}
                    onBlur={() => setFocus(null)}
                    className="cursor-pointer outline-none focus-visible:[&>circle]:stroke-[var(--color-signal)]"
                  >
                    <circle r={R[n.kind]} fill={FILL[n.kind]} stroke="var(--bg-elev)" strokeWidth={2} />
                    {(n.kind !== "contact" || focus === n.id || g.nodes.length < 60) && (
                      <text y={-R[n.kind] - 4} textAnchor="middle" fontSize={n.kind === "member" ? 12 : 10.5} fill="var(--fg)" fontWeight={n.kind === "member" ? 600 : 400}>{n.label}</text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
          <details className="px-3 pb-3 text-[13px]">
            <summary className="cursor-pointer text-[var(--fg-mute)]">텍스트로 보기</summary>
            <ul className="mt-2 space-y-0.5">
              {g.edges.map((e, i) => (
                <li key={i}>{byId.get(e.source)?.label} → {byId.get(e.target)?.label}{e.kind === "knows_company" ? ` (${e.count}명)` : ""}</li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </div>
  );
}
