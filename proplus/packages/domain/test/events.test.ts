/**
 * P-183 outbox 이벤트 봉투 (기술백서 §7 / 전략 §4.4)
 *
 * 전략 §2 의 N-13 을 지키는 테스트다. 이 봉투는 **나중에 다른 시스템이 읽는 사본**이므로
 * 한 번 PII 가 적히면 회수할 수 없다. 그래서 두 가지를 단정한다:
 *   1. 기술백서 §7 이 요구한 봉투 필드가 전부 있다 (구독자가 멱등 처리·추적을 할 수 있다).
 *   2. payload 에 이메일·전화가 섞여 들어와도 원문은 나가지 않는다.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEMA_VERSION,
  type EventEnvelopeInput,
  PROPLUS_EVENTS,
  type ProplusEvent,
  buildEnvelope,
  isProplusEvent,
} from "../src/events";

const NOW = new Date("2026-10-22T00:00:00.000Z");

/** 기술백서 §7 "예시 이벤트" 9개. 카탈로그는 더 넓을 수 있지만 이 9개는 **반드시** 있어야 한다. */
const WHITEPAPER_EVENTS = [
  "profile.published",
  "evidence.submitted",
  "verification.completed",
  "verification.expired",
  "lead.created",
  "appointment.booked",
  "product.updated",
  "transaction.verified",
  "membership.revoked",
] as const;

/** 기술백서 §7 "이벤트에는 … 를 둔다" 7개 필드. */
const REQUIRED_ENVELOPE_FIELDS = [
  "eventId",
  "occurredAt",
  "tenantId",
  "actorId",
  "aggregateId",
  "schemaVersion",
  "correlationId",
] as const;

function input(over: Partial<EventEnvelopeInput> = {}): EventEnvelopeInput {
  return {
    eventType: "lead.created",
    occurredAt: NOW,
    aggregateType: "lead",
    ...over,
  };
}

describe("P-183: 이벤트 카탈로그는 기술백서 §7 을 모두 담는다", () => {
  it("기술백서 §7 의 9개 이벤트가 전부 카탈로그에 있다", () => {
    for (const e of WHITEPAPER_EVENTS) {
      expect((PROPLUS_EVENTS as readonly string[]).includes(e), `${e} 가 카탈로그에 없다`).toBe(true);
    }
  });

  it("카탈로그에 중복된 이름이 없다 — 중복은 구독자 분기를 조용히 깨뜨린다", () => {
    expect(new Set(PROPLUS_EVENTS).size).toBe(PROPLUS_EVENTS.length);
  });

  it("모든 이름이 'aggregate.verb' 소문자 형식이다 (생산자·소비자 계약)", () => {
    for (const e of PROPLUS_EVENTS) {
      expect(e, `${e} 의 형식이 다르다`).toMatch(/^[a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*$/);
    }
  });

  it("카탈로그의 모든 이벤트로 봉투를 조립할 수 있다 (전수)", () => {
    for (const eventType of PROPLUS_EVENTS) {
      const env = buildEnvelope(input({ eventType }));
      expect(env.eventType, `${eventType} 가 변형됐다`).toBe(eventType);
    }
  });
});

describe("P-183: 봉투는 기술백서 §7 의 필수 필드를 전부 채운다", () => {
  it("최소 입력으로도 7개 필드가 모두 존재한다 (값이 없으면 null, 키 누락은 아니다)", () => {
    const env = buildEnvelope(input());
    for (const k of REQUIRED_ENVELOPE_FIELDS) {
      expect(k in env, `${k} 키가 없다`).toBe(true);
      expect(env[k], `${k} 가 undefined 다`).not.toBeUndefined();
    }
  });

  it("jsonb 로 저장했다 꺼내도 7개 필드가 살아 있다 — undefined 면 여기서 사라진다", () => {
    const env = buildEnvelope(input());
    const roundTrip = JSON.parse(JSON.stringify(env)) as Record<string, unknown>;
    for (const k of REQUIRED_ENVELOPE_FIELDS) {
      expect(k in roundTrip, `${k} 가 직렬화에서 사라졌다`).toBe(true);
    }
  });

  it("주지 않은 식별자는 null 이다 — 빈 문자열로 채우지 않는다", () => {
    const env = buildEnvelope(input());
    expect(env.tenantId).toBeNull();
    expect(env.actorId).toBeNull();
    expect(env.aggregateId).toBeNull();
    expect(env.correlationId).toBeNull();
  });

  it("준 식별자는 그대로 실린다", () => {
    const env = buildEnvelope(
      input({ tenantId: "org_1", actorId: "u_1", aggregateId: "lead_1", correlationId: "req_1" }),
    );
    expect(env.tenantId).toBe("org_1");
    expect(env.actorId).toBe("u_1");
    expect(env.aggregateId).toBe("lead_1");
    expect(env.correlationId).toBe("req_1");
    expect(env.aggregateType).toBe("lead");
  });

  it("occurredAt 은 Date 든 문자열이든 같은 ISO 문자열이 된다", () => {
    expect(buildEnvelope(input({ occurredAt: NOW })).occurredAt).toBe("2026-10-22T00:00:00.000Z");
    expect(buildEnvelope(input({ occurredAt: "2026-10-22T00:00:00.000Z" })).occurredAt).toBe("2026-10-22T00:00:00.000Z");
    // 타임존 표기가 달라도 같은 순간이면 같은 값으로 정규화된다 (구독자가 순서를 판단할 수 있다).
    expect(buildEnvelope(input({ occurredAt: "2026-10-22T09:00:00+09:00" })).occurredAt).toBe("2026-10-22T00:00:00.000Z");
  });

  it("해석할 수 없는 occurredAt 은 던진다 — Invalid Date 가 봉투에 들어가지 않는다", () => {
    expect(() => buildEnvelope(input({ occurredAt: "어제" }))).toThrow(/occurredAt/);
    expect(() => buildEnvelope(input({ occurredAt: new Date("nonsense") }))).toThrow(/occurredAt/);
  });
});

describe("P-183: schemaVersion 과 eventId", () => {
  it("schemaVersion 기본값은 1 이다", () => {
    expect(DEFAULT_SCHEMA_VERSION).toBe(1);
    expect(buildEnvelope(input()).schemaVersion).toBe(DEFAULT_SCHEMA_VERSION);
  });

  it("schemaVersion 을 주면 그 값을 쓴다 — payload 모양이 바뀌면 구독자가 분기한다", () => {
    expect(buildEnvelope(input({ schemaVersion: 2 })).schemaVersion).toBe(2);
  });

  it("eventId 는 호출마다 다르다 — 같은 이벤트를 두 번 넣어도 두 건으로 구분된다", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(buildEnvelope(input()).eventId);
    expect(ids.size).toBe(50);
  });

  it("eventId 를 주면 보존한다 — 재시도에서 '같은 이벤트'임을 보장한다 (P-184)", () => {
    const fixed = "11111111-2222-3333-4444-555555555555";
    expect(buildEnvelope(input({ eventId: fixed })).eventId).toBe(fixed);
    // 두 번 조립해도 같은 id → 워커가 멱등 키로 쓸 수 있다
    expect(buildEnvelope(input({ eventId: fixed })).eventId).toBe(fixed);
  });

  it("자동 생성 eventId 는 UUID 형식이다", () => {
    expect(buildEnvelope(input()).eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("P-183 / N-13: payload 에 PII 원문이 남지 않는다 (기술백서 §7 / 보안정책 §3)", () => {
  it("문장에 섞인 이메일·전화를 치환한다", () => {
    const env = buildEnvelope(
      input({ payload: { message: "연락 주세요 010-1234-5678", note: "메일은 kim@example.com 입니다" } }),
    );
    const dumped = JSON.stringify(env.payload);
    expect(dumped).not.toContain("kim@example.com");
    expect(dumped).not.toContain("010-1234-5678");
    expect(env.payload.message).toBe("연락 주세요 [redacted:phone]");
    expect(env.payload.note).toBe("메일은 [redacted:email] 입니다");
  });

  it("구분기호 없는 번호·전각 숫자도 치환한다", () => {
    const env = buildEnvelope(input({ payload: { a: "01012345678", b: "０１０－１２３４－５６７８" } }));
    const dumped = JSON.stringify(env.payload);
    expect(dumped).not.toContain("01012345678");
    expect(dumped).not.toContain("１２３４");
  });

  it("중첩 payload 도 끝까지 훑는다", () => {
    const env = buildEnvelope(
      input({
        payload: {
          lead: {
            stage: "new",
            contactEmail: "a@b.com",
            memo: "부재중, 010-9999-8888 로 재통화",
            nested: { deeper: { phoneText: "02-123-4567" } },
          },
          tags: ["z@w.com", "정상태그"],
        },
      }),
    );
    const dumped = JSON.stringify(env.payload);
    expect(dumped).not.toContain("a@b.com");
    expect(dumped).not.toContain("z@w.com");
    expect(dumped).not.toContain("9999-8888");
    expect(dumped).not.toContain("123-4567");
    expect(dumped).not.toMatch(/@/);
    // 식별자·코드는 살아남아야 한다 — 전부 가리면 구독자가 아무것도 못 한다
    expect(dumped).toContain("new");
    expect(dumped).toContain("정상태그");
  });

  it("민감한 키 이름은 값의 모양을 보지 않고 통째로 가린다 (token·password 등)", () => {
    const env = buildEnvelope(
      input({ payload: { tokenHash: "abc123", smtpPassword: "p", authorization: "Bearer x", email: "a@b.com" } }),
    );
    expect(env.payload.tokenHash).toBe("[redacted]");
    expect(env.payload.smtpPassword).toBe("[redacted]");
    expect(env.payload.authorization).toBe("[redacted]");
    expect(env.payload.email).toBe("[redacted]");
  });

  it("호출부가 넘긴 payload 객체를 변형하지 않는다 — 봉투용 사본만 가린다", () => {
    const original = { note: "kim@example.com" };
    const env = buildEnvelope(input({ payload: original }));
    expect(original.note).toBe("kim@example.com");
    expect(env.payload.note).toBe("[redacted:email]");
    expect(env.payload).not.toBe(original);
  });

  it("payload 를 주지 않으면 빈 객체이고, 봉투끼리 공유되지 않는다", () => {
    const a = buildEnvelope(input());
    const b = buildEnvelope(input());
    expect(a.payload).toEqual({});
    expect(a.payload).not.toBe(b.payload);
  });

  it("payload 가 객체가 아니면 던진다 (outbox_events.payload = jsonb 객체)", () => {
    const asArray = [{ id: 1 }] as unknown as Record<string, unknown>;
    expect(() => buildEnvelope(input({ payload: asArray }))).toThrow(/payload/);
  });
});

describe("P-183: 카탈로그 밖 이벤트는 발행할 수 없다", () => {
  it("카탈로그에 없는 이름이면 던진다 — 구독자 없는 이벤트는 조용히 사라진다", () => {
    const unknownEvent = "profile.deleted" as unknown as ProplusEvent;
    expect(() => buildEnvelope(input({ eventType: unknownEvent }))).toThrow(/§7/);
  });

  it("타이포·대문자·빈 문자열도 거부한다", () => {
    for (const bad of ["lead.create", "LEAD.CREATED", "lead.created ", ""]) {
      expect(() => buildEnvelope(input({ eventType: bad as ProplusEvent })), `"${bad}" 가 통과했다`).toThrow();
    }
  });

  it("eventType 이 아예 없으면 던진다", () => {
    expect(() => buildEnvelope({ occurredAt: NOW, aggregateType: "lead" } as unknown as EventEnvelopeInput)).toThrow();
  });
});

describe("P-183: aggregateType 이 없으면 멱등 키를 만들 수 없다 (P-184)", () => {
  it("빈 문자열·공백만이면 던진다", () => {
    expect(() => buildEnvelope(input({ aggregateType: "" }))).toThrow(/aggregateType/);
    expect(() => buildEnvelope(input({ aggregateType: "   " }))).toThrow(/aggregateType/);
  });

  it("아예 없으면 던진다", () => {
    const noAggregate = { eventType: "lead.created", occurredAt: NOW } as unknown as EventEnvelopeInput;
    expect(() => buildEnvelope(noAggregate)).toThrow(/aggregateType/);
  });

  it("검사 순서: 카탈로그 밖 이벤트가 aggregateType 누락보다 먼저 보고된다", () => {
    const both = { eventType: "nope.nope", occurredAt: NOW, aggregateType: "" } as unknown as EventEnvelopeInput;
    expect(() => buildEnvelope(both)).toThrow(/§7/);
  });
});

describe("P-183: isProplusEvent 타입가드", () => {
  it("카탈로그의 모든 이름에 true 다 (전수)", () => {
    for (const e of PROPLUS_EVENTS) expect(isProplusEvent(e), `${e}`).toBe(true);
  });

  it("문자열이 아니거나 카탈로그 밖이면 false 다", () => {
    for (const bad of [null, undefined, 42, {}, [], true, "", "lead", "lead.created2", "profile.deleted"]) {
      expect(isProplusEvent(bad), `${String(bad)} 가 통과했다`).toBe(false);
    }
  });

  it("Object.prototype 의 속성 이름에 속지 않는다", () => {
    expect(isProplusEvent("toString")).toBe(false);
    expect(isProplusEvent("constructor")).toBe(false);
  });
});
