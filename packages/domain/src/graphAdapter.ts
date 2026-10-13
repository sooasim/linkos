// N-012 멀티벡터 임베딩 파이프라인(어댑터) · N-013 그래프 projection · N-209 Neo4j 선택 어댑터 · N-210 Qdrant 선택 어댑터.
// 지침: docs/NETWORK_INTELLIGENCE.md §8.
//
// 사용자 결정(2026-10-13): **어댑터 인터페이스만 둔다.** Apache AGE / Neo4j / Qdrant / pgvector 임베딩 워커를
// 지금 설치하지 않는다. 기본 구현은 순수 SQL(API 모듈) + 결정적 인메모리 알고리즘(이 파일)이다.
//
// 이 파일은 I/O 가 없다. 엣지를 메모리로 읽어온 뒤의 계산만 담당하며, 실제 적재는 API 모듈이 한다.
// 나중에 AGE/Neo4j 를 붙일 때 바꿀 것은 `GraphRepository` 구현체 하나뿐이어야 한다.

import { type NetworkEdge, type Neighbor, type RawPath, discoverNeighbors, enumeratePaths } from "./pathRank";
import { textSimilarity } from "./match";

export const GRAPH_PROVIDERS = ["sql", "age", "neo4j"] as const;
export type GraphProvider = (typeof GRAPH_PROVIDERS)[number];

export interface GraphSlice {
  nodes: { id: string; type: string; label: string | null; masked: boolean; size: number; community: string | null; score: number | null }[];
  links: { source: string; target: string; type: string; strength: number; confirmed: boolean }[];
  /** 서버가 잘라낸 노드 수 — 화면이 "더 있음"을 알 수 있어야 한다 */
  truncated: number;
}

/**
 * 그래프 질의 경계. 구현체는 **후보/경로의 UUID 만** 돌려준다 —
 * 공개 판정은 canonical DB 쪽 PolicyService(evaluateDisclosure)가 다시 한다.
 */
export interface GraphRepository {
  readonly provider: GraphProvider;
  neighbors(fromId: string, maxHops: number, limit: number): Promise<Neighbor[]>;
  paths(fromId: string, toId: string, maxHops: number, maxPaths: number): Promise<RawPath[]>;
}

/**
 * 기본 구현. 호출자가 이미 적재한 엣지 집합 위에서 결정적으로 계산한다.
 * 같은 엣지 집합이면 항상 같은 결과가 나오므로 AGE/Neo4j 어댑터의 contract test 기준이 된다.
 */
export class InMemoryGraphRepository implements GraphRepository {
  readonly provider: GraphProvider = "sql";

  constructor(private readonly edges: NetworkEdge[]) {}

  async neighbors(fromId: string, maxHops = 3, limit = 500): Promise<Neighbor[]> {
    return discoverNeighbors(this.edges, fromId, maxHops, limit);
  }

  async paths(fromId: string, toId: string, maxHops = 3, maxPaths = 60): Promise<RawPath[]> {
    return enumeratePaths(this.edges, fromId, toId, maxHops, maxPaths);
  }

  /** 시각화 slice. 반드시 공개 판정을 거친 노드만 넘겨받는다 — 여기서 숨기는 것이 아니다. */
  buildSlice(centerId: string, visible: { id: string; type: string; label: string | null; masked: boolean; score: number | null; community: string | null }[], maxNodes: number): GraphSlice {
    const kept = visible.slice(0, maxNodes);
    const ids = new Set(kept.map((n) => n.id));
    return {
      nodes: kept.map((n) => ({ ...n, size: n.id === centerId ? 12 : 4 + 6 * (n.score ?? 0.3) })),
      links: this.edges
        .filter((e) => ids.has(e.fromId) && ids.has(e.toId) && e.quality > 0)
        .map((e) => ({ source: e.fromId, target: e.toId, type: e.relation, strength: e.strength, confirmed: e.confirmed })),
      truncated: Math.max(0, visible.length - kept.length),
    };
  }
}

/**
 * N-209/N-210 contract test 용 계약. 어떤 provider 든 같은 fixture 에서
 * 같은 reachable set(촌수별 노드 집합)을 만들어야 한다.
 */
export async function reachableSet(repo: GraphRepository, fromId: string, maxHops = 3): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (const n of await repo.neighbors(fromId, maxHops, 5000)) {
    const list = out.get(n.hops);
    if (list) list.push(n.nodeId);
    else out.set(n.hops, [n.nodeId]);
  }
  for (const list of out.values()) list.sort();
  return out;
}

// ---------- N-017 3D 레이아웃 ----------

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 결정적 3D force-directed 레이아웃(Fruchterman–Reingold 의 3차원 확장).
 * `graph.ts` 의 2D `forceLayout()` 과 같은 알고리즘·같은 시드 규칙을 쓰므로 같은 입력이면 항상 같은 좌표가 나온다.
 *
 * 서버에서 계산한다 — 브라우저는 그릴 좌표만 받는다(지침 §2: 숨길 노드를 클라이언트로 보내지 않는다).
 * 3D 는 노드가 많으면 읽을 수 없으므로 호출자가 상한(기본 500)을 지켜서 넘겨야 한다.
 */
export function forceLayout3D(
  nodes: { id: string }[],
  edges: { source: string; target: string; weight?: number }[],
  opts: { size?: number; iterations?: number; seed?: number } = {},
): Record<string, Point3> {
  const S = opts.size ?? 600;
  const n = nodes.length;
  if (!n) return {};
  let s = (opts.seed ?? 29) >>> 0 || 1;
  const rand = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
  const k = Math.cbrt((S * S * S) / n) * 0.75;
  const pos: Point3[] = nodes.map(() => ({ x: (rand() - 0.5) * S * 0.8, y: (rand() - 0.5) * S * 0.8, z: (rand() - 0.5) * S * 0.8 }));
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  const E = edges
    .map((e) => [idx.get(e.source), idx.get(e.target), e.weight ?? 1] as const)
    .filter((e): e is readonly [number, number, number] => e[0] !== undefined && e[1] !== undefined);
  const iters = opts.iterations ?? Math.min(240, 60 + n * 2);
  let t = S / 10;
  for (let it = 0; it < iters; it++) {
    const disp: Point3[] = pos.map(() => ({ x: 0, y: 0, z: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i]!.x - pos[j]!.x;
        let dy = pos[i]!.y - pos[j]!.y;
        let dz = pos[i]!.z - pos[j]!.z;
        let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 0.01) {
          dx = rand() - 0.5;
          dy = rand() - 0.5;
          dz = rand() - 0.5;
          d = 0.5;
        }
        const f = (k * k) / d;
        disp[i]!.x += (dx / d) * f;
        disp[i]!.y += (dy / d) * f;
        disp[i]!.z += (dz / d) * f;
        disp[j]!.x -= (dx / d) * f;
        disp[j]!.y -= (dy / d) * f;
        disp[j]!.z -= (dz / d) * f;
      }
    }
    for (const [a, b, w] of E) {
      const dx = pos[a]!.x - pos[b]!.x;
      const dy = pos[a]!.y - pos[b]!.y;
      const dz = pos[a]!.z - pos[b]!.z;
      const d = Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const f = ((d * d) / k) * (0.5 + Math.min(1, w));
      disp[a]!.x -= (dx / d) * f;
      disp[a]!.y -= (dy / d) * f;
      disp[a]!.z -= (dz / d) * f;
      disp[b]!.x += (dx / d) * f;
      disp[b]!.y += (dy / d) * f;
      disp[b]!.z += (dz / d) * f;
    }
    const half = S / 2;
    for (let i = 0; i < n; i++) {
      // 중심으로 당겨 분리된 성분이 화면 밖으로 날아가지 않게 한다
      disp[i]!.x -= pos[i]!.x * 0.004;
      disp[i]!.y -= pos[i]!.y * 0.004;
      disp[i]!.z -= pos[i]!.z * 0.004;
      const d = Math.max(0.01, Math.sqrt(disp[i]!.x ** 2 + disp[i]!.y ** 2 + disp[i]!.z ** 2));
      const step = Math.min(d, t);
      pos[i]!.x = Math.max(-half, Math.min(half, pos[i]!.x + (disp[i]!.x / d) * step));
      pos[i]!.y = Math.max(-half, Math.min(half, pos[i]!.y + (disp[i]!.y / d) * step));
      pos[i]!.z = Math.max(-half, Math.min(half, pos[i]!.z + (disp[i]!.z / d) * step));
    }
    t = Math.max(0.5, t * 0.965);
  }
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  return Object.fromEntries(nodes.map((nd, i) => [nd.id, { x: r1(pos[i]!.x), y: r1(pos[i]!.y), z: r1(pos[i]!.z) }]));
}

/** 3D 는 정보 밀도가 높아 노드가 많으면 읽을 수 없다(화면명세 S09: 기본 최대 500). */
export const MAX_3D_NODES = 500;

// ---------- N-012 임베딩 파이프라인 계약 ----------

export const EMBEDDING_TYPES = ["profile", "industry", "capability", "need", "relationship", "interaction", "project_fit", "composite"] as const;
export type EmbeddingType = (typeof EMBEDDING_TYPES)[number];

export const EMBEDDABLE_ENTITIES = ["person", "company", "organization", "project", "need", "capability"] as const;
export type EmbeddableEntity = (typeof EMBEDDABLE_ENTITIES)[number];

export interface EmbeddingRequest {
  entityType: EmbeddableEntity;
  entityId: string;
  embeddingType: EmbeddingType;
  /** 임베딩할 텍스트. 전화·이메일·비공개 메모는 포함하지 않는다 */
  content: string;
  /** model + version + contentHash 가 캐시 키다 */
  model: string;
  contentHash: string;
}

export interface ScoredEntity {
  entityId: string;
  score: number;
}

export const VECTOR_PROVIDERS = ["lexical", "pgvector", "qdrant"] as const;
export type VectorProvider = (typeof VECTOR_PROVIDERS)[number];

export interface VectorIndex {
  readonly provider: VectorProvider;
  /** 후보 pool 안에서 의미적으로 가까운 것을 돌려준다 */
  search(query: string, pool: { entityId: string; content: string }[], limit: number): Promise<ScoredEntity[]>;
}

/**
 * 기본 구현: 어휘 유사도(`textSimilarity` — CJK 문자 바이그램 + 라틴 어간). 임베딩 모델이 없어도 동작하고,
 * 결정적이라 테스트가 안정적이다. pgvector/Qdrant 어댑터가 붙으면 이 클래스만 교체한다.
 */
export class LexicalVectorIndex implements VectorIndex {
  readonly provider: VectorProvider = "lexical";

  constructor(private readonly minScore = 0.12) {}

  async search(query: string, pool: { entityId: string; content: string }[], limit = 50): Promise<ScoredEntity[]> {
    const best = new Map<string, number>();
    for (const item of pool) {
      const s = textSimilarity(query, item.content);
      if (s < this.minScore) continue;
      if ((best.get(item.entityId) ?? 0) < s) best.set(item.entityId, s);
    }
    return [...best.entries()]
      .map(([entityId, score]) => ({ entityId, score: Math.round(score * 1000) / 1000 }))
      .sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId))
      .slice(0, limit);
  }
}

// ---------- projection 상태 ----------

export interface ProjectionLag {
  /** 아직 발행되지 않은 outbox 이벤트 수 */
  pending: number;
  /** 가장 오래된 미발행 이벤트의 경과 초. 없으면 null */
  oldestAgeSeconds: number | null;
  /** 운영 알람 임계값을 넘었는가 */
  degraded: boolean;
}

export const PROJECTION_LAG_ALERT_SECONDS = 300;

export function projectionLag(pending: number, oldestOccurredAt: Date | null, now: Date = new Date()): ProjectionLag {
  const age = oldestOccurredAt ? Math.round((now.getTime() - oldestOccurredAt.getTime()) / 1000) : null;
  return { pending, oldestAgeSeconds: age, degraded: age != null && age > PROJECTION_LAG_ALERT_SECONDS };
}
