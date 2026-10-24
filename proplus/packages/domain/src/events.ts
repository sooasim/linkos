/**
 * 도메인 이벤트 봉투 — P-183 (기술백서 §7 / 전략 §4.4).
 *
 * 이벤트는 `outbox_events` 에 **쓰기와 같은 트랜잭션으로** 들어가고 워커가 나중에 소비한다
 * (0001_proplus_core.sql 의 outbox_events). 즉 이 봉투는 **나중에 다른 시스템이 읽는 사본**이다.
 * 그래서 두 가지를 여기서 못 박는다:
 *
 *   1. payload 는 `redact()` 를 통과한다 — 외부 연동(메일·CRM·웹훅)으로 PII 가 흘러나가는
 *      경로는 전부 이 봉투를 지나간다 (N-13 / 보안정책 §3). payload 에는 **식별자만** 담는 것이
 *      원칙이고, 실수로 이메일이 섞여도 여기서 지워진다.
 *   2. eventType 은 카탈로그 안에서만 — 타이포로 만들어진 이벤트는 구독자가 없어서
 *      **조용히 사라진다.** 조용한 실패보다 즉시 예외가 낫다.
 */

import { randomUUID } from "node:crypto";
import { redact } from "./redact";

/**
 * 기술백서 §7 이벤트 카탈로그. 순서는 문서의 나열 순서를 따른다.
 * 여기에 없는 이벤트를 발행할 수 없다 — 추가는 이 배열과 소비자를 같이 고치는 PR 이어야 한다.
 */
export const PROPLUS_EVENTS = [
  "profile.published",
  "profile.unpublished",
  "evidence.submitted",
  "verification.completed",
  "verification.expired",
  "verification.revoked",
  "badge.issued",
  "lead.created",
  "appointment.booked",
  "product.updated",
  "transaction.verified",
  "membership.revoked",
  "appeal.submitted",
  "report.created",
] as const;

export type ProplusEvent = (typeof PROPLUS_EVENTS)[number];

export interface EventEnvelope {
  eventId: string;
  eventType: ProplusEvent;
  /** ISO 8601. 워커·구독자가 재처리 순서를 판단하는 기준이다. */
  occurredAt: string;
  tenantId: string | null;
  actorId: string | null;
  aggregateType: string;
  aggregateId: string | null;
  schemaVersion: number;
  /** 요청 추적용 (기술백서 §7). 로그의 correlation_id 와 같은 값을 쓴다. */
  correlationId: string | null;
  payload: Record<string, unknown>;
}

export interface EventEnvelopeInput {
  eventType: ProplusEvent;
  /**
   * 주입받는다. 도메인 패키지는 `Date.now()` 를 쓰지 않는다 — 만료·순서 판정을
   * 테스트에서 재현 가능하게 만드는 것이 이 규칙의 목적이다 (CONTRACTS.md §패키지).
   */
  occurredAt: Date | string;
  aggregateType: string;
  aggregateId?: string | null;
  tenantId?: string | null;
  actorId?: string | null;
  schemaVersion?: number;
  correlationId?: string | null;
  payload?: Record<string, unknown>;
  /**
   * 재시도에서 **같은 이벤트임**을 보장해야 할 때만 넘긴다.
   * 비우면 새로 만든다 — 그래야 워커가 id 로 중복 소비를 막을 수 있다 (P-184).
   */
  eventId?: string;
}

/** 봉투의 기본 스키마 버전. payload 모양이 바뀌면 구독자가 분기할 수 있게 올린다. */
export const DEFAULT_SCHEMA_VERSION = 1;

export function isProplusEvent(v: unknown): v is ProplusEvent {
  return typeof v === "string" && (PROPLUS_EVENTS as readonly string[]).includes(v);
}

export function buildEnvelope(i: EventEnvelopeInput): EventEnvelope {
  if (!isProplusEvent(i.eventType)) {
    throw new Error(`카탈로그에 없는 이벤트다 (기술백서 §7): ${String(i.eventType)}`);
  }
  if (!i.aggregateType?.trim()) {
    // 어떤 엔터티의 사건인지 모르면 구독자가 멱등 키를 만들 수 없다 (P-184).
    throw new Error(`aggregateType 이 필요하다: ${i.eventType}`);
  }

  const occurredAt = i.occurredAt instanceof Date ? i.occurredAt : new Date(i.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error(`occurredAt 을 해석할 수 없다: ${String(i.occurredAt)}`);
  }

  return {
    eventId: i.eventId ?? randomUUID(),
    eventType: i.eventType,
    occurredAt: occurredAt.toISOString(),
    tenantId: i.tenantId ?? null,
    actorId: i.actorId ?? null,
    aggregateType: i.aggregateType,
    aggregateId: i.aggregateId ?? null,
    schemaVersion: i.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
    correlationId: i.correlationId ?? null,
    // N-13: 여기가 마지막 관문이다. 호출부가 무엇을 담았는지 몰라도 PII 원문은 나가지 않는다.
    payload: redactPayload(i.payload),
  };
}

function redactPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) return {};
  const cleaned = redact(payload);
  // redact() 는 평범한 객체를 평범한 객체로 돌려준다. 그래도 확인하는 이유는
  // payload 에 배열·Date 가 최상위로 들어오는 호출을 타입만으로 완전히 막지 못하기 때문이다.
  if (cleaned === null || typeof cleaned !== "object" || Array.isArray(cleaned)) {
    throw new Error("payload 는 객체여야 한다 (outbox_events.payload = jsonb)");
  }
  return cleaned as Record<string, unknown>;
}
