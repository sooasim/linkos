// N-013 그래프 projection 과 outbox 동기화에 쓰는 이벤트.
//
// `events.ts` 의 `DomainEvents` 는 `dd/LINKOS_Product_Blueprint_v1/06_EVENT_CATALOG.yaml` 과 1:1 이고
// 이름·페이로드를 바꿀 수 없다. 이 패키지(인적네트워크 v3.0)에서 온 이벤트는 그 카탈로그에 없으므로
// **별도 네임스페이스**로 둔다 — Feature ID 를 `N-xxx` 로 분리한 것과 같은 이유다.
//
// 같은 `outbox_events` 테이블에 쓰고 같은 워커가 소비한다. 이름은 `network.` 접두사로 구분한다.
// 지침: docs/NETWORK_INTELLIGENCE.md §8.

export interface NetworkEvents {
  /** 관계 엣지가 생기거나 바뀜 → 그래프 projection 갱신 */
  "network.edge.upserted": { edge_id: string; from_contact_id: string; to_contact_id: string; relation: string; confirmed: boolean; inferred: boolean };
  "network.edge.removed": { edge_id: string; from_contact_id: string; to_contact_id: string };
  /** 관계강도 재계산 완료 → 경로 비용 재계산 대상 */
  "network.strength.recomputed": { edge_id: string; score: number; model_version: string };
  /** 공개 권한이 바뀜 → 캐시된 masked/full payload 무효화 */
  "network.disclosure.changed": { contact_id: string; share_permission: string };
  /** 프로젝트 요구사항이 확정됨 → 커버리지 재계산 */
  "network.project.requirements.confirmed": { project_id: string; requirement_ids: string[] };
  /** 기회가 탐지됨 → 사용자에게 알림(자동 발송 아님) */
  "network.opportunity.detected": { opportunity_id: string; project_id: string | null; score: number };
  /** 소개 결과가 기록됨 → 추천 가중치 학습 신호 */
  "network.outcome.recorded": { subject_type: string; subject_id: string; label: string };
  /** 임베딩 재생성이 필요함(N-012 어댑터가 붙으면 소비한다) */
  "network.embedding.invalidated": { entity_type: string; entity_id: string; embedding_type: string };
}

export type NetworkEventName = keyof NetworkEvents;

export const NETWORK_EVENT_CONSUMERS: Record<NetworkEventName, string[]> = {
  "network.edge.upserted": ["graph-projector", "search-index"],
  "network.edge.removed": ["graph-projector", "search-index"],
  "network.strength.recomputed": ["graph-projector"],
  "network.disclosure.changed": ["graph-projector", "search-index"],
  "network.project.requirements.confirmed": ["coverage-worker"],
  "network.opportunity.detected": ["notification"],
  "network.outcome.recorded": ["analytics", "ranker-training"],
  "network.embedding.invalidated": ["embedding-worker"],
};

export const NETWORK_EVENT_NAMES = Object.keys(NETWORK_EVENT_CONSUMERS) as NetworkEventName[];

export function isNetworkEventName(name: string): name is NetworkEventName {
  return (NETWORK_EVENT_NAMES as readonly string[]).includes(name);
}
