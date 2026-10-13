// N-014 1~3촌 후보 탐색 · N-105 Top-K 소개 경로 랭킹(대안 경로 + 다양성).
// 지침: docs/NETWORK_INTELLIGENCE.md §4.
//
// PathCost = Σ[-ln(max(ε, E))] + .22·hop + .18·dormancy + .20·privacy + .15·conflict - .25·sharedContext
//
// 최단 경로가 아니라 "실제로 소개가 될 가능성이 높은 경로"를 1순위로 올린다. 반드시 대안 경로를 함께 돌려주고,
// 같은 소개자·같은 회사만 반복되지 않도록 다양성 페널티를 적용한다.
// consent_gate=0 인 엣지(= edgeQuality 0)는 경로 **구성 자체에서** 제외한다 — 내부 feature 로도 쓰지 않는다.

export const PATH_COST_WEIGHTS = { hop: 0.22, dormancy: 0.18, privacy: 0.2, conflict: 0.15, sharedContext: 0.25 } as const;
export const PATH_EPSILON = 1e-6;

/** 다양성: 이미 고른 경로와 소개자/회사가 겹칠 때 비용에 더하는 양. */
export const PATH_DIVERSITY_PENALTY = { introducer: 0.45, company: 0.25, edge: 0.15 } as const;

export interface NetworkEdge {
  fromId: string;
  toId: string;
  relation: string;
  /** edgeQuality() 결과 0..1. 0 이면 이 엣지는 쓰이지 않는다. */
  quality: number;
  strength: number;
  confirmed: boolean;
  /** 사용자 확인 없이 추론된 관계인가(지침 §3: inferred 전용은 confidence 상한) */
  inferred?: boolean;
  /** 0..1 — 1 - recency. 오래 조용한 관계일수록 높다 */
  dormancy: number;
  /** 0..1 — toId 노드의 공개 제약 정도(masked 일수록 높다) */
  privacy: number;
  /** toId 가 속한 회사. 경로 다양성 계산에 쓴다 */
  companyId?: string | null;
  /** 이 엣지를 뒷받침하는 근거(N-108) */
  evidenceId?: string | null;
}

export interface RawPath {
  /** [출발, 중개자…, 대상] */
  nodeIds: string[];
  edges: NetworkEdge[];
}

// ---------- N-014 이웃 탐색 ----------

export interface Neighbor {
  nodeId: string;
  hops: number;
  /** 그 노드까지 가는 가장 좋은 경로의 엣지 품질 곱 */
  bestQuality: number;
  /** 첫 번째 중개자(내가 직접 아는 사람). 직접 아는 사이면 null */
  viaId: string | null;
}

function adjacency(edges: NetworkEdge[]): Map<string, NetworkEdge[]> {
  const adj = new Map<string, NetworkEdge[]>();
  for (const e of edges) {
    if (e.quality <= 0) continue; // consent_gate=0 은 그래프에 올리지 않는다
    const list = adj.get(e.fromId);
    if (list) list.push(e);
    else adj.set(e.fromId, [e]);
  }
  return adj;
}

/**
 * fromId 에서 maxHops 안에 닿는 노드를 촌수와 최선 품질로 돌려준다. 같은 노드에 여러 경로가 있으면
 * 더 짧은 촌수를, 촌수가 같으면 더 좋은 품질을 남긴다.
 */
export function discoverNeighbors(edges: NetworkEdge[], fromId: string, maxHops = 3, limit = 500): Neighbor[] {
  const adj = adjacency(edges);
  const best = new Map<string, Neighbor>();
  let frontier: { id: string; quality: number; viaId: string | null }[] = [{ id: fromId, quality: 1, viaId: null }];
  const seen = new Set<string>([fromId]);
  for (let hop = 1; hop <= maxHops; hop++) {
    const next: typeof frontier = [];
    for (const cur of frontier) {
      for (const e of adj.get(cur.id) ?? []) {
        if (e.toId === fromId) continue;
        const quality = cur.quality * e.quality;
        const viaId = hop === 1 ? e.toId : cur.viaId;
        const prev = best.get(e.toId);
        if (!prev || prev.hops > hop || (prev.hops === hop && prev.bestQuality < quality)) {
          best.set(e.toId, { nodeId: e.toId, hops: hop, bestQuality: Math.round(quality * 1000) / 1000, viaId });
        }
        // 이미 더 짧은 촌수로 닿은 노드는 다시 확장하지 않는다(단순 경로 폭발 방지)
        if (!seen.has(e.toId)) {
          seen.add(e.toId);
          next.push({ id: e.toId, quality, viaId });
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return [...best.values()].sort((a, b) => a.hops - b.hops || b.bestQuality - a.bestQuality).slice(0, limit);
}

// ---------- 경로 열거 ----------

/**
 * fromId → targetId 의 단순 경로(노드 중복 없음)를 maxHops 까지 모두 찾는다.
 * `maxPaths` 로 폭발을 막는다 — 3 hop 이내라 실무 그래프에서는 충분하다.
 */
export function enumeratePaths(edges: NetworkEdge[], fromId: string, targetId: string, maxHops = 3, maxPaths = 60): RawPath[] {
  if (fromId === targetId) return [];
  const adj = adjacency(edges);
  const out: RawPath[] = [];
  const walk = (nodeId: string, nodes: string[], used: NetworkEdge[]): void => {
    if (out.length >= maxPaths || used.length >= maxHops) return;
    for (const e of adj.get(nodeId) ?? []) {
      if (nodes.includes(e.toId)) continue;
      if (e.toId === targetId) {
        out.push({ nodeIds: [...nodes, e.toId], edges: [...used, e] });
        if (out.length >= maxPaths) return;
        continue;
      }
      walk(e.toId, [...nodes, e.toId], [...used, e]);
    }
  };
  walk(fromId, [fromId], []);
  return out;
}

// ---------- 비용과 랭킹 ----------

export interface PathPenalties {
  /** 0..1 — 이해충돌(경쟁사 소개자 등). 호출자가 판단해 넣는다. 기본 0 */
  conflict?: number;
  /** 0..1 — 경로 전체에 걸친 공유 맥락(같은 협회·행사·회사 이력) */
  sharedContext?: number;
}

export interface RankedPath {
  rank: number;
  hops: number;
  /** 엣지 품질의 곱. 보정된 설명용 지표이며 **교정된 확률이 아니다** */
  quality: number;
  cost: number;
  /** 공개 수준 — 경로에 masked 노드가 있으면 masked */
  disclosure: "full" | "masked" | "intro_only";
  nodeIds: string[];
  /** 첫 번째 중개자. 소개를 부탁할 사람이다 */
  introducerId: string | null;
  edges: { fromId: string; toId: string; relation: string; strength: number; confirmed: boolean; evidenceId: string | null }[];
  reasons: string[];
  breakdown: { edgeCost: number; hop: number; dormancy: number; privacy: number; conflict: number; sharedContext: number; diversity: number };
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** 페널티·보너스 전의 엣지 비용 합. */
export function edgeCostSum(edges: NetworkEdge[]): number {
  return edges.reduce((a, e) => a - Math.log(Math.max(PATH_EPSILON, e.quality)), 0);
}

export function pathCost(path: RawPath, p: PathPenalties = {}): { cost: number; breakdown: RankedPath["breakdown"] } {
  const W = PATH_COST_WEIGHTS;
  const edgeCost = edgeCostSum(path.edges);
  const hop = Math.max(0, path.edges.length - 1); // 1촌(직접)은 hop 페널티 없음
  const dormancy = mean(path.edges.map((e) => Math.max(0, Math.min(1, e.dormancy))));
  const privacy = mean(path.edges.map((e) => Math.max(0, Math.min(1, e.privacy))));
  const conflict = Math.max(0, Math.min(1, p.conflict ?? 0));
  const sharedContext = Math.max(0, Math.min(1, p.sharedContext ?? 0));
  const cost = edgeCost + W.hop * hop + W.dormancy * dormancy + W.privacy * privacy + W.conflict * conflict - W.sharedContext * sharedContext;
  return {
    cost: r3(cost),
    breakdown: { edgeCost: r3(edgeCost), hop: r3(W.hop * hop), dormancy: r3(W.dormancy * dormancy), privacy: r3(W.privacy * privacy), conflict: r3(W.conflict * conflict), sharedContext: r3(-W.sharedContext * sharedContext), diversity: 0 },
  };
}

export interface RankPathsOptions {
  k?: number;
  /** 경로별 추가 페널티. key 는 경로의 nodeIds.join(">") */
  penalties?: Record<string, PathPenalties>;
  /** nodeId → 그 노드가 masked 인가. 경로의 disclosure 판정과 privacy 페널티 설명에 쓴다 */
  maskedNodeIds?: ReadonlySet<string>;
  /** nodeId → 회사 id. 다양성 계산에 쓴다(엣지에 없을 때의 폴백) */
  companyOf?: Record<string, string | null>;
  /** 대상 노드의 공개 수준(evaluateDisclosure 결과). 경로에 masked 구간이 없을 때 이 값을 쓴다 */
  targetDisclosure?: "full" | "masked" | "intro_only";
}

/**
 * 비용이 낮은 순으로 고르되, 한 번 고를 때마다 남은 경로에 **다양성 페널티**를 더해 다시 정렬한다.
 * 그래서 같은 소개자만 반복되는 Top-K 가 나오지 않는다(그리디 MMR).
 *
 * 패키지 인수 게이트: 동일 fixture 에서 최단 경로 외 대안 경로가 최소 3개 나와야 한다.
 */
export function rankBusinessPaths(paths: RawPath[], opts: RankPathsOptions = {}): RankedPath[] {
  const k = opts.k ?? 3;
  const masked = opts.maskedNodeIds ?? new Set<string>();
  const scored = paths.map((path) => {
    const key = path.nodeIds.join(">");
    const { cost, breakdown } = pathCost(path, opts.penalties?.[key] ?? {});
    const introducerId = path.nodeIds.length > 2 ? (path.nodeIds[1] ?? null) : null;
    const companies = new Set(path.edges.map((e) => e.companyId ?? opts.companyOf?.[e.toId] ?? null).filter((c): c is string => !!c));
    return { path, cost, breakdown, introducerId, companies, edgeKeys: new Set(path.edges.map((e) => `${e.fromId}>${e.toId}`)) };
  });

  const chosen: typeof scored = [];
  const pool = [...scored];
  while (chosen.length < k && pool.length) {
    let bestIdx = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      let div = 0;
      for (const sel of chosen) {
        if (c.introducerId && c.introducerId === sel.introducerId) div += PATH_DIVERSITY_PENALTY.introducer;
        for (const comp of c.companies) if (sel.companies.has(comp)) div += PATH_DIVERSITY_PENALTY.company;
        for (const ek of c.edgeKeys) if (sel.edgeKeys.has(ek)) div += PATH_DIVERSITY_PENALTY.edge;
      }
      const eff = c.cost + div;
      if (eff < bestCost) {
        bestCost = eff;
        bestIdx = i;
      }
    }
    const picked = pool.splice(bestIdx, 1)[0]!;
    picked.breakdown = { ...picked.breakdown, diversity: r3(bestCost - picked.cost) };
    chosen.push(picked);
  }

  return chosen.map((c, i) => {
    const hops = c.path.edges.length;
    const quality = r3(c.path.edges.reduce((a, e) => a * e.quality, 1));
    const hasMasked = c.path.nodeIds.some((n) => masked.has(n));
    const reasons: string[] = [];
    const weakest = [...c.path.edges].sort((a, b) => a.quality - b.quality)[0];
    reasons.push(hops === 1 ? "직접 아는 사이입니다" : `중개자 ${hops - 1}명을 거치는 경로입니다`);
    if (c.path.edges.every((e) => e.confirmed)) reasons.push("경로의 모든 관계가 사용자 확인된 관계입니다");
    else reasons.push("경로에 추정된 관계가 포함되어 있습니다");
    if (weakest) reasons.push(`가장 약한 구간의 엣지 품질 ${weakest.quality.toFixed(2)}`);
    if (c.breakdown.dormancy > 0.05) reasons.push("휴면 구간이 있어 비용이 올라갔습니다");
    if (c.breakdown.sharedContext < 0) reasons.push("공유 맥락(같은 조직·행사)이 있어 비용이 내려갔습니다");
    if (hasMasked) reasons.push("경로 중 신원 비공개 구간이 있습니다");
    return {
      rank: i + 1,
      hops,
      quality,
      cost: r3(c.cost + c.breakdown.diversity),
      disclosure: hasMasked ? "masked" : (opts.targetDisclosure ?? "intro_only"),
      nodeIds: c.path.nodeIds,
      introducerId: c.introducerId,
      edges: c.path.edges.map((e) => ({ fromId: e.fromId, toId: e.toId, relation: e.relation, strength: r3(e.strength), confirmed: e.confirmed, evidenceId: e.evidenceId ?? null })),
      reasons,
      breakdown: c.breakdown,
    };
  });
}

/** pathQuality: 추천 점수(N-016)에 넣는 0..1 값. 경로가 없으면 0. */
export function pathQualityFeature(paths: RankedPath[]): number {
  if (!paths.length) return 0;
  const best = paths[0]!;
  // 비용을 0..1 로 눌러 쓴다. cost 0 → 1, cost 3 → 0.05 근방
  return r3(Math.max(0, Math.min(1, Math.exp(-best.cost / 1.5))));
}
