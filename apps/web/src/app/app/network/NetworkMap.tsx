"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Empty } from "@/components/Page";
import { api } from "@/lib/client";
import { Network3D } from "./Network3D";

// S08 2D Network Map (N-017). 지침 §13:
//  * 기본은 List — 그래프는 목적이 있을 때 쓴다.
//  * 데이터 타입을 색만으로 구분하지 않는다 → shape + label 병행.
//  * masked 노드는 이름 대신 역할/산업 카테고리만. 서버가 애초에 이름을 보내지 않는다.
//  * 레이아웃은 서버가 계산한다(결정적) — 브라우저에 전체 그래프를 숨겨두지 않는다.

interface SliceNode {
  id: string;
  type: string;
  label: string | null;
  masked: boolean;
  size: number;
  community: string | null;
  score: number | null;
  x: number;
  y: number;
  /** dim=3 으로 요청했을 때만 채워진다 */
  x3?: number;
  y3?: number;
  z?: number;
}
interface SliceLink {
  source: string;
  target: string;
  type: string;
  strength: number;
  confirmed: boolean;
}
interface Slice {
  nodes: SliceNode[];
  links: SliceLink[];
  truncated: number;
  width: number;
  height: number;
  hops: number;
  dim: number;
}

const FILL: Record<string, string> = { me: "var(--accent)", member: "var(--color-signal)", person: "var(--fg)" };
const TYPE_LABEL: Record<string, string> = { me: "나", member: "조직 멤버", person: "연락처" };

/** shape 로도 구분한다 — 색각 이상에서도 타입을 읽을 수 있어야 한다. */
function NodeShape({ n }: { n: SliceNode }) {
  const r = Math.max(4, Math.min(13, n.size));
  const common = { fill: FILL[n.type] ?? "var(--fg)", stroke: "var(--bg-elev)", strokeWidth: 2 };
  if (n.type === "me") return <polygon points={`0,${-r - 2} ${r + 2},0 0,${r + 2} ${-r - 2},0`} {...common} />;
  if (n.type === "member") return <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={2.5} {...common} />;
  // masked 연락처는 점선 윤곽으로 한 번 더 구분한다
  return <circle r={r} {...common} fill={n.masked ? "var(--bg-elev)" : common.fill} stroke={n.masked ? "var(--fg-mute)" : common.stroke} strokeDasharray={n.masked ? "3 2" : undefined} />;
}

export function NetworkMap() {
  // 기본은 목록이다 — 그래프는 목적이 있을 때 쓴다(지침 §13).
  const [view, setView] = useState<"list" | "map" | "map3d">("list");
  const [hops, setHops] = useState(2);
  const [slice, setSlice] = useState<Slice | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  // 3D 는 좌표를 더 계산해야 하므로 필요한 보기에서만 dim=3 으로 요청한다.
  const dim = view === "map3d" ? 3 : 2;
  const maxNodes = view === "map3d" ? 300 : 300;
  useEffect(() => {
    setSlice(null);
    setErr(null);
    api<Slice>(`/network-intel/graph?hops=${hops}&maxNodes=${maxNodes}&dim=${dim}`)
      .then(setSlice)
      .catch((e) => setErr(e instanceof Error ? e.message : "불러오지 못했습니다."));
  }, [hops, dim, maxNodes]);

  const byId = useMemo(() => new Map((slice?.nodes ?? []).map((n) => [n.id, n])), [slice]);
  const near = useMemo(() => {
    const s = new Set<string>();
    if (!focus || !slice) return s;
    s.add(focus);
    for (const l of slice.links) {
      if (l.source === focus) s.add(l.target);
      if (l.target === focus) s.add(l.source);
    }
    return s;
  }, [focus, slice]);

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="chip">
        <span className="text-[var(--fg-mute)]">보기</span>
        {(["list", "map", "map3d"] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => setView(v)}
            className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${view === v ? "bg-[var(--accent-soft)] text-[var(--accent-text)]" : "text-[var(--fg-mute)]"}`}
          >
            {v === "list" ? "목록" : v === "map" ? "2D" : "3D"}
          </button>
        ))}
      </span>
      <span className="chip">
        <span className="text-[var(--fg-mute)]">촌수</span>
        {[1, 2, 3].map((h) => (
          <button
            key={h}
            type="button"
            aria-pressed={hops === h}
            onClick={() => setHops(h)}
            className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${hops === h ? "bg-[var(--accent-soft)] text-[var(--accent-text)]" : "text-[var(--fg-mute)]"}`}
          >
            {h}
          </button>
        ))}
      </span>
    </div>
  );

  if (err) return <div>{controls}<div className="mt-4"><Empty title="네트워크를 불러오지 못했습니다" body={err} /></div></div>;
  if (!slice) return <div>{controls}<div className="mt-4 h-80 animate-pulse rounded-3xl border border-[var(--line)]" /></div>;
  if (slice.nodes.length <= 1) {
    return (
      <div>
        {controls}
        <div className="mt-4">
          <Empty
            title="아직 연결이 없습니다"
            body="명함을 스캔하거나 연락처를 가져오면 네트워크가 만들어집니다."
            action={
              <Link className="btn btn-ink" href="/app/scan">
                명함 스캔
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const people = slice.nodes.filter((n) => n.type !== "me");

  return (
    <div>
      {controls}
      <p className="mt-3 text-[12.5px] text-[var(--fg-mute)]">
        노드 {slice.nodes.length}개 · 연결 {slice.links.length}개
        {slice.truncated > 0 && ` · ${slice.truncated}개는 표시하지 않았습니다(상한 300)`}
        {" · 신원 비공개 노드는 역할·산업만 표시됩니다"}
      </p>

      {view === "map3d" ? (
        <div className="mt-4">
          <Network3D nodes={slice.nodes} links={slice.links} truncated={slice.truncated} />
        </div>
      ) : view === "list" ? (
        <ul className="mt-4 divide-y divide-[var(--line)] overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)]">
          {people.map((n) => (
            <li key={n.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden className="shrink-0">
                  <NodeShape n={{ ...n, size: 5 }} />
                </svg>
                <div className="min-w-0">
                  <p className="truncate text-[14.5px] font-medium">{n.label}</p>
                  <p className="text-[12px] text-[var(--fg-mute)]">
                    {TYPE_LABEL[n.type] ?? n.type}
                    {n.masked && " · 신원 비공개"}
                    {n.community && ` · ${n.community.startsWith("co:") ? "같은 회사 그룹" : n.community}`}
                  </p>
                </div>
              </div>
              {n.type === "person" && (
                <Link className="btn btn-ghost !min-h-9 !px-3 !text-[13px]" href={`/app/network/paths/${n.id}`}>
                  경로
                </Link>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <section className="mt-4 overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)] p-2">
          <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-[12px] text-[var(--fg-mute)]">
            {(["me", "member", "person"] as const).map((k) => (
              <span key={k} className="flex items-center gap-1.5">
                <svg width="14" height="14" viewBox="-8 -8 16 16" aria-hidden>
                  <NodeShape n={{ id: k, type: k, label: null, masked: false, size: 5, community: null, score: null, x: 0, y: 0 }} />
                </svg>
                {TYPE_LABEL[k]}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="-8 -8 16 16" aria-hidden>
                <circle r="5" fill="var(--bg-elev)" stroke="var(--fg-mute)" strokeWidth="2" strokeDasharray="3 2" />
              </svg>
              신원 비공개
            </span>
          </div>
          <svg viewBox={`0 0 ${slice.width} ${slice.height}`} className="h-auto w-full" role="img" aria-label={`내 네트워크 ${hops}촌 그래프: 노드 ${slice.nodes.length}개, 연결 ${slice.links.length}개`}>
            <g>
              {slice.links.map((l, i) => {
                const a = byId.get(l.source);
                const b = byId.get(l.target);
                if (!a || !b) return null;
                const dim = focus != null && !(near.has(l.source) && near.has(l.target));
                return (
                  <line
                    key={i}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="var(--fg)"
                    strokeOpacity={dim ? 0.05 : 0.14 + l.strength * 0.45}
                    strokeWidth={0.6 + l.strength * 2}
                    strokeDasharray={l.confirmed ? undefined : "4 3"}
                  />
                );
              })}
            </g>
            <g>
              {slice.nodes.map((n) => {
                const dim = focus != null && !near.has(n.id);
                const showLabel = n.type !== "person" || focus === n.id || slice.nodes.length < 50;
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x},${n.y})`}
                    opacity={dim ? 0.25 : 1}
                    tabIndex={0}
                    role="button"
                    aria-label={`${n.label} (${TYPE_LABEL[n.type] ?? n.type}${n.masked ? ", 신원 비공개" : ""})`}
                    onMouseEnter={() => setFocus(n.id)}
                    onMouseLeave={() => setFocus(null)}
                    onFocus={() => setFocus(n.id)}
                    onBlur={() => setFocus(null)}
                    className="cursor-pointer outline-none"
                  >
                    <NodeShape n={n} />
                    {showLabel && (
                      <text y={-(Math.max(4, Math.min(13, n.size)) + 5)} textAnchor="middle" fontSize={n.type === "me" ? 12.5 : 10.5} fill="var(--fg)" fontWeight={n.type === "me" ? 600 : 400}>
                        {(n.label ?? "").slice(0, 24)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
          <details className="px-3 pb-3 text-[13px]">
            <summary className="cursor-pointer text-[var(--fg-mute)]">
              <Icon name="eye" size={14} className="mr-1 inline" aria-hidden />
              텍스트로 보기
            </summary>
            <ul className="mt-2 space-y-0.5">
              {slice.links.map((l, i) => (
                <li key={i}>
                  {byId.get(l.source)?.label} → {byId.get(l.target)?.label}
                  {!l.confirmed && " (추정)"}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </div>
  );
}
