"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";

// S09 3D Network Map (N-017).
//
// 의존성 없이 구현한다: 레이아웃은 서버가 결정적으로 계산한 3D 좌표(forceLayout3D)이고,
// 여기서는 회전 행렬 + 원근 투영으로 canvas 에 그린다. three/react-force-graph 를 넣지 않는 이유는
// 1MB+ 번들과 WebGL 가용성 문제를 안고 갈 이유가 없기 때문이다 — 500 노드 상한에서는 2D canvas 로 충분하다.
//
// 화면명세 S09 준수:
//   * 기본 최대 500 노드 (서버가 자른다)
//   * camera auto-fly 최소화 → 자동 회전은 기본 꺼짐이고 prefers-reduced-motion 이면 켤 수 없다
//   * 타입을 색만으로 구분하지 않는다 → sphere/cube/octahedron 실루엣 + 라벨
//   * masked 노드는 점선 윤곽 + 역할·산업 라벨만

export interface Node3D {
  id: string;
  type: string;
  label: string | null;
  masked: boolean;
  size: number;
  community: string | null;
  score: number | null;
  x3?: number;
  y3?: number;
  z?: number;
}
export interface Link3D {
  source: string;
  target: string;
  type: string;
  strength: number;
  confirmed: boolean;
}

const COLOR: Record<string, string> = { me: "--accent", member: "--color-signal", person: "--fg" };

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Person=구, Member=정육면체, Me=8면체. 색각 이상에서도 타입이 읽혀야 한다(지침 §13). */
function drawShape(g: CanvasRenderingContext2D, type: string, x: number, y: number, r: number, masked: boolean, fill: string, bg: string): void {
  g.beginPath();
  if (type === "member") {
    g.rect(x - r, y - r, r * 2, r * 2);
  } else if (type === "me") {
    g.moveTo(x, y - r * 1.25);
    g.lineTo(x + r * 1.25, y);
    g.lineTo(x, y + r * 1.25);
    g.lineTo(x - r * 1.25, y);
    g.closePath();
  } else {
    g.arc(x, y, r, 0, Math.PI * 2);
  }
  if (masked) {
    g.fillStyle = bg;
    g.fill();
    g.setLineDash([3, 2]);
    g.strokeStyle = fill;
    g.lineWidth = 1.6;
    g.stroke();
    g.setLineDash([]);
  } else {
    g.fillStyle = fill;
    g.fill();
    g.strokeStyle = bg;
    g.lineWidth = 1.5;
    g.stroke();
  }
}

export function Network3D({ nodes, links, truncated }: { nodes: Node3D[]; links: Link3D[]; truncated: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [yaw, setYaw] = useState(0.5);
  const [pitch, setPitch] = useState(-0.25);
  const [spin, setSpin] = useState(false);
  const [hover, setHover] = useState<Node3D | null>(null);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const reduceMotion = useRef(false);

  useEffect(() => {
    reduceMotion.current = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion.current) setSpin(false);
  }, []);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  /** 노드를 화면 좌표로 투영한다. 깊이 순으로 정렬해 뒤쪽을 먼저 그린다. */
  const project = useCallback(
    (w: number, h: number) => {
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const focal = 820;
      const out: { n: Node3D; sx: number; sy: number; r: number; depth: number }[] = [];
      for (const n of nodes) {
        const x = n.x3 ?? 0;
        const y = n.y3 ?? 0;
        const z = n.z ?? 0;
        // Y축(yaw) → X축(pitch) 회전
        const x1 = x * cy - z * sy;
        const z1 = x * sy + z * cy;
        const y2 = y * cp - z1 * sp;
        const z2 = y * sp + z1 * cp;
        const d = focal + z2;
        if (d <= 1) continue;
        const k = focal / d;
        out.push({
          n,
          sx: w / 2 + x1 * k,
          sy: h / 2 + y2 * k,
          r: Math.max(2.5, Math.min(14, n.size) * k),
          depth: z2,
        });
      }
      return out.sort((a, b) => a.depth - b.depth);
    },
    [nodes, yaw, pitch],
  );

  // 렌더 루프. spin 이 꺼져 있으면 상태 변화가 있을 때만 그린다(배터리·멀미 고려).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let stopped = false;
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      const g = canvas.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const fg = cssVar("--fg", "#1B1B24");
      const bg = cssVar("--bg-elev", "#ffffff");
      const placed = project(w, h);
      const pos = new Map(placed.map((p) => [p.n.id, p]));

      for (const l of links) {
        const a = pos.get(l.source);
        const b = pos.get(l.target);
        if (!a || !b) continue;
        g.beginPath();
        g.moveTo(a.sx, a.sy);
        g.lineTo(b.sx, b.sy);
        g.strokeStyle = fg;
        g.globalAlpha = 0.07 + Math.min(0.3, l.strength * 0.3);
        g.lineWidth = 0.5 + l.strength * 1.6;
        if (!l.confirmed) g.setLineDash([4, 3]);
        g.stroke();
        g.setLineDash([]);
        g.globalAlpha = 1;
      }

      for (const p of placed) {
        const color = cssVar(COLOR[p.n.type] ?? "--fg", fg);
        drawShape(g, p.n.type, p.sx, p.sy, p.r, p.n.masked, color, bg);
        const showLabel = p.n.type !== "person" || hover?.id === p.n.id || placed.length < 40;
        if (showLabel && p.n.label) {
          g.font = `${p.n.type === "me" ? 600 : 400} ${Math.max(9, Math.min(12.5, 11 * (p.r / 6)))}px Inter Tight, Pretendard, sans-serif`;
          g.fillStyle = fg;
          g.globalAlpha = 0.85;
          g.textAlign = "center";
          g.fillText(p.n.label.slice(0, 22), p.sx, p.sy - p.r - 4);
          g.globalAlpha = 1;
        }
      }

      if (spin && !reduceMotion.current && !drag.current) setYaw((v) => v + 0.0025);
      if (!stopped) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [project, links, spin, hover]);

  const pick = (ev: React.PointerEvent<HTMLCanvasElement>): Node3D | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const placed = project(canvas.clientWidth, canvas.clientHeight);
    // 앞쪽(나중에 그려진) 노드를 먼저 집는다
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i]!;
      if ((mx - p.sx) ** 2 + (my - p.sy) ** 2 <= (p.r + 4) ** 2) return p.n;
    }
    return null;
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 pb-2 text-[12px] text-[var(--fg-mute)]">
        <button
          type="button"
          className="chip"
          aria-pressed={spin}
          disabled={reduceMotion.current}
          onClick={() => setSpin(!spin)}
          title={reduceMotion.current ? "동작 줄이기 설정이 켜져 있어 회전을 사용할 수 없습니다" : undefined}
        >
          <Icon name="bolt" size={13} aria-hidden />
          {spin ? "회전 멈춤" : "자동 회전"}
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => {
            setYaw(0.5);
            setPitch(-0.25);
          }}
        >
          시점 초기화
        </button>
        <span>드래그로 돌려 보세요 · 노드 {nodes.length}개{truncated > 0 && ` (${truncated}개 생략)`}</span>
      </div>

      <canvas
        ref={canvasRef}
        className="h-[clamp(320px,62vh,620px)] w-full touch-none rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)]"
        role="img"
        aria-label={`내 네트워크 3D 그래프: 노드 ${nodes.length}개, 연결 ${links.length}개. 아래 목록에서 같은 내용을 텍스트로 확인할 수 있습니다.`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, yaw, pitch };
        }}
        onPointerMove={(e) => {
          if (drag.current) {
            setYaw(drag.current.yaw + (e.clientX - drag.current.x) * 0.006);
            setPitch(Math.max(-1.2, Math.min(1.2, drag.current.pitch + (e.clientY - drag.current.y) * 0.006)));
            return;
          }
          setHover(pick(e));
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          drag.current = null;
        }}
        onPointerLeave={() => {
          drag.current = null;
          setHover(null);
        }}
      />

      <p className="mt-2 min-h-5 text-[12.5px] text-[var(--fg-mute)]" aria-live="polite">
        {hover ? `${hover.label}${hover.masked ? " · 신원 비공개" : ""}${hover.community ? ` · ${hover.community.startsWith("co:") ? "같은 회사 그룹" : hover.community}` : ""}` : ""}
      </p>

      {/* 캔버스는 스크린리더가 읽을 수 없다. 같은 데이터를 텍스트로도 제공한다. */}
      <details className="mt-1 text-[13px]">
        <summary className="cursor-pointer text-[var(--fg-mute)]">텍스트로 보기</summary>
        <ul className="mt-2 space-y-0.5">
          {links.map((l, i) => (
            <li key={i}>
              {byId.get(l.source)?.label} → {byId.get(l.target)?.label}
              {!l.confirmed && " (추정)"}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
