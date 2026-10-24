// P-183 트랜잭셔널 outbox (기술백서 §7 / 전략 §4.4).
//
// **이 파일에 pool 오버로드를 추가하지 마라.** `enqueue` 가 트랜잭션 client 만 받는 것이 P-183 의 전부다.
// 풀로 넣을 수 있게 되는 순간, 도메인 쓰기는 커밋됐는데 이벤트는 사라지는(또는 그 반대) 경로가 생긴다.
// 그러면 "배지를 취소했는데 외부 연동은 여전히 유효하다고 안다" 같은 신뢰 사고가 조용히 발생한다.
// 타입이 그걸 막는다: 호출부는 `tx(async (c) => { ...쓰기...; await enqueue(c, ...) })` 형태가 강제된다.
//
// 봉투 조립은 도메인의 `buildEnvelope()` 가 한다 — 카탈로그 밖 이벤트 이름 거부와 payload redact 가
// 그 함수 안에 있어서, 여기서 SQL 만 바꿔치기해도 N-13 이 깨지지 않는다.
import { buildEnvelope } from "@proplus/domain";
import type { ProplusEvent } from "@proplus/domain";
import type { PoolClient } from "pg";

export interface OutboxInput {
  /** 이벤트 카탈로그(`PROPLUS_EVENTS`)에 있는 이름만. 카탈로그 밖 이름은 buildEnvelope 이 던진다. */
  eventType: ProplusEvent;
  aggregateType: string;
  aggregateId?: string | null;
  /** 기술백서 §5 멀티테넌시. 개인 소유 집합체는 null 이다. */
  tenantId?: string | null;
  actorId?: string | null;
  /** P-187: 로그·감사로그의 correlation_id 와 같은 값을 쓴다. 한 요청을 세 곳에서 같이 찾을 수 있어야 한다. */
  correlationId?: string | null;
  /** 페이로드 모양이 바뀌면 올린다. 소비자가 모르는 버전을 만났을 때 추측하지 않고 보류할 수 있어야 한다. */
  schemaVersion?: number;
  /** 식별자와 코드만. buildEnvelope 이 redact() 를 통과시키므로 PII 원문은 남지 않는다 (N-13 / 기술백서 §7). */
  payload?: Record<string, unknown>;
  /**
   * 재시도에서 같은 이벤트임을 보장해야 할 때만 넘긴다. 행 id 로 그대로 쓰이고 `ON CONFLICT DO NOTHING` 이 걸려 있어
   * 같은 eventId 로 두 번 기록해도 이벤트는 하나다 (P-184 를 생산자 쪽에서도 지키는 수단).
   */
  eventId?: string;
  /** 테스트에서 시각을 고정할 때만 넘긴다. 기본값은 지금이다. */
  occurredAt?: Date;
}

/**
 * 도메인 쓰기와 **같은 트랜잭션에** 이벤트를 기록한다. 발행은 워커(`relayOutbox`)가 한다.
 * @param client `tx()` 가 넘겨 준 트랜잭션 client. 풀을 넘기면 타입에서 거부된다 — 위 주석 참조.
 * @returns 기록된 outbox 행 id (= 봉투의 eventId)
 */
export async function enqueue(client: PoolClient, input: OutboxInput): Promise<string> {
  const env = buildEnvelope({ ...input, occurredAt: input.occurredAt ?? new Date() });
  await client.query(
    `INSERT INTO outbox_events
       (id, event_type, tenant_id, actor_id, aggregate_type, aggregate_id, schema_version, correlation_id, payload, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO NOTHING`,
    [
      env.eventId,
      env.eventType,
      env.tenantId,
      env.actorId,
      env.aggregateType,
      env.aggregateId,
      env.schemaVersion,
      env.correlationId,
      JSON.stringify(env.payload),
      env.occurredAt,
    ],
  );
  return env.eventId;
}
