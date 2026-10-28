/**
 * P-189 rate limit 공통 미들웨어 · P-004 로그인 rate limit · P-112 스팸·악성 발신 차단
 *
 * 수용 기준(원장):
 *   P-189 "행위별 한도, 초과 시 429 + retry-after"
 *   P-004 "동일 식별자·IP 기준 시도 제한, 초과 시 429 + retry-after"
 *   P-112 "rate limit + 중복 제출 억제 + 링크 스팸 패턴 거부" (이 파일은 rate limit 몫만 본다)
 * 한도 값의 출처: `proplus/docs/CONTRACTS.md` §rateLimit.ts.
 *
 * 이 파일이 지키는 것은 두 가지다 — **경계에서 한 번 더 열리지 않는가**,
 * 그리고 **이름을 잘못 적으면 한도가 조용히 사라지지 않는가**(후자가 더 위험하다).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  RATE_LIMITS,
  bucketKey,
  checkLimit,
  limitFor,
  windowStartFor,
} from "../src/rateLimit";

const NOW = new Date("2026-10-22T00:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** CONTRACTS.md §rateLimit.ts 에 적힌 값. 코드가 아니라 문서를 기준으로 적는다. */
const DOCUMENTED: readonly (readonly [name: string, limit: number, windowMs: number])[] = [
  ["login", 5, 15 * MINUTE],
  ["lead.create", 5, 10 * MINUTE],
  ["evidence.submit", 20, HOUR],
  ["profile.update", 60, HOUR],
  ["search", 60, MINUTE],
  ["public.view", 240, MINUTE],
  // P-167 신고 접수. 스팸 방어가 아니라 **표적 신고 방어**다 — 한 사람이 특정 프로필에
  // 신고를 쏟아부어 운영 큐를 막는 패턴을 막는다. 정당한 신고자가 10분에 3건을 넘길 이유는 없다.
  ["report.create", 3, 10 * MINUTE],
];

describe("P-189: 한도표가 문서와 일치한다 (CONTRACTS.md §rateLimit.ts)", () => {
  it("행위별 한도·윈도가 문서 값과 1:1 로 같다", () => {
    for (const [name, limit, windowMs] of DOCUMENTED) {
      expect(RATE_LIMITS[name], `${name}`).toEqual({ limit, windowMs });
    }
  });

  it("문서에 없는 버킷이 몰래 들어오지 않았다", () => {
    expect(Object.keys(RATE_LIMITS).sort()).toEqual(DOCUMENTED.map(([n]) => n).sort());
  });

  it("기본값은 '보수적'이어야 한다 — 무제한이 아니고 유한한 윈도를 가진다", () => {
    expect(DEFAULT_LIMIT).toEqual({ limit: 30, windowMs: MINUTE });
    expect(DEFAULT_LIMIT.limit).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_LIMIT.limit)).toBe(true);
    expect(DEFAULT_LIMIT.windowMs).toBeGreaterThan(0);
  });

  it("등록된 이름은 표의 값을, 등록되지 않은 이름은 기본값을 돌려준다", () => {
    for (const [name, limit, windowMs] of DOCUMENTED) {
      expect(limitFor(name)).toEqual({ limit, windowMs });
    }
    for (const unknown of ["", "lead.craete", "typo.lgoin", "verification.approve", "LOGIN"]) {
      // 대소문자도 다른 이름이다 — 'LOGIN' 이 login 의 한도를 물려받지 않는다.
      expect(limitFor(unknown), `${JSON.stringify(unknown)}`).toEqual(DEFAULT_LIMIT);
    }
  });
});

describe("P-189: 경계 — used === limit 에서 이미 막힌다", () => {
  it("모든 버킷에서 used < limit 은 통과, used >= limit 은 거부한다 (전수)", () => {
    for (const [name, limit] of DOCUMENTED) {
      const now = at(1_000); // 윈도 안
      expect(checkLimit(name, 0, NOW, now).allowed, `${name} / used=0`).toBe(true);
      expect(checkLimit(name, limit - 1, NOW, now).allowed, `${name} / used=limit-1`).toBe(true);
      expect(checkLimit(name, limit, NOW, now).allowed, `${name} / used=limit`).toBe(false);
      expect(checkLimit(name, limit + 1, NOW, now).allowed, `${name} / used=limit+1`).toBe(false);
      expect(checkLimit(name, limit * 10, NOW, now).allowed, `${name} / 폭주`).toBe(false);
    }
  });

  it("P-004: 로그인은 15분에 5번까지이고 6번째가 막힌다", () => {
    // consumeLimit 은 '이번 요청 전까지 쓴 양'을 넘긴다 — 5번째 요청의 used 는 4다.
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(checkLimit("login", attempt - 1, NOW, at(attempt * 1_000)).allowed, `${attempt}번째`).toBe(true);
    }
    expect(checkLimit("login", 5, NOW, at(6_000)).allowed).toBe(false);
  });

  it("P-112: 공개 상담 폼은 10분에 5건까지다", () => {
    expect(checkLimit("lead.create", 4, NOW, at(60_000)).allowed).toBe(true);
    expect(checkLimit("lead.create", 5, NOW, at(60_000)).allowed).toBe(false);
  });
});

describe("P-189: retryAfterSec 는 '윈도 끝까지 남은 시간'이다 (초과 시 429 + retry-after)", () => {
  it("windowStart + windowMs - now 를 초로 올림한다", () => {
    // login: 윈도 900초, 60초 경과 → 840초 남음
    const r = checkLimit("login", 5, NOW, at(60_000));
    expect(r.allowed === false && r.retryAfterSec).toBe(840);

    const r2 = checkLimit("search", 60, NOW, at(10_000)); // 60초 윈도, 10초 경과
    expect(r2.allowed === false && r2.retryAfterSec).toBe(50);
  });

  it("윈도 시작 직후에는 윈도 전체 길이를 돌려준다", () => {
    const r = checkLimit("lead.create", 5, NOW, NOW);
    expect(r.allowed === false && r.retryAfterSec).toBe(600);
  });

  it("남은 시간이 1초 미만이어도 0 을 돌려주지 않는다 (0 은 '즉시 재시도'로 읽힌다)", () => {
    const r = checkLimit("login", 5, NOW, at(15 * MINUTE - 500));
    expect(r.allowed === false && r.retryAfterSec).toBe(1);
    expect(r.allowed === false && r.retryAfterSec > 0).toBe(true);
  });

  it("초 단위로 올림한다 — 내림하면 아직 막혀 있는 시각에 재시도하게 된다", () => {
    const r = checkLimit("search", 60, NOW, at(10_500)); // 49.5초 남음
    expect(r.allowed === false && r.retryAfterSec).toBe(50);
  });
});

describe("P-189: 윈도가 지났으면 낡은 카운터로 막지 않는다 (고정 윈도)", () => {
  it("정확히 윈도 끝 시각부터 새 윈도로 본다", () => {
    expect(checkLimit("login", 999, NOW, at(15 * MINUTE)).allowed).toBe(true);
    expect(checkLimit("login", 999, NOW, at(15 * MINUTE + 1)).allowed).toBe(true);
    // 끝 직전 1ms 는 아직 같은 윈도다
    expect(checkLimit("login", 999, NOW, at(15 * MINUTE - 1)).allowed).toBe(false);
  });

  it("모든 버킷에서 같은 규칙이 성립한다 (전수)", () => {
    for (const [name, limit, windowMs] of DOCUMENTED) {
      expect(checkLimit(name, limit + 100, NOW, at(windowMs)).allowed, `${name} 윈도 끝`).toBe(true);
      expect(checkLimit(name, limit + 100, NOW, at(windowMs - 1)).allowed, `${name} 윈도 내`).toBe(false);
    }
  });
});

describe("P-189: 입력이 망가져도 열어 주지 않는다", () => {
  it("시각을 해석할 수 없으면 거부하고 윈도 전체를 retry-after 로 준다", () => {
    const badStart = checkLimit("login", 0, "해석불가", NOW);
    expect(badStart.allowed).toBe(false);
    expect(badStart.allowed === false && badStart.retryAfterSec).toBe(900);

    const badNow = checkLimit("login", 0, NOW, "해석불가");
    expect(badNow.allowed).toBe(false);
  });

  it("ISO 문자열과 Date 를 같은 값으로 취급한다 (DB 는 문자열로 돌려준다)", () => {
    const asString = checkLimit("login", 5, NOW.toISOString(), at(60_000).toISOString());
    const asDate = checkLimit("login", 5, NOW, at(60_000));
    expect(asString).toEqual(asDate);
  });

  it("미등록 이름이 '조용한 무제한'이 되지 않는다 — 기본값으로 막는다", () => {
    const now = at(1_000);
    expect(checkLimit("typo.lgoin", DEFAULT_LIMIT.limit - 1, NOW, now).allowed).toBe(true);
    expect(checkLimit("typo.lgoin", DEFAULT_LIMIT.limit, NOW, now).allowed).toBe(false);
    expect(checkLimit("verification.approve", 10_000, NOW, now).allowed).toBe(false);
  });

  it("Object.prototype 과 이름이 겹치는 버킷도 통과시키지 않는다", () => {
    // 'toString' 같은 이름은 RATE_LIMITS[name] 이 상속 멤버를 집어내므로 한도표를 우회한다.
    // 최소한 '막힌다'는 성질은 유지돼야 한다 (retryAfterSec 값 자체는 반환 보고 참조).
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      expect(checkLimit(name, 1_000_000, NOW, at(1_000)).allowed, `${name}`).toBe(false);
    }
  });
});

describe("P-189 / N-13: bucketKey 는 주체를 평문으로 남기지 않는다 (보안정책 §3)", () => {
  const WHOS = ["hong@example.com", "203.0.113.9", "usr_01HZX", "+82-10-1234-5678"] as const;

  it("행위 이름은 평문, 주체는 32자 hex 해시다", () => {
    expect(bucketKey("login", "hong@example.com")).toMatch(/^login:[0-9a-f]{32}$/);
    expect(bucketKey("lead.create", "203.0.113.9")).toMatch(/^lead\.create:[0-9a-f]{32}$/);
  });

  it("이메일·IP·전화번호 조각이 키에 남지 않는다 (전수)", () => {
    for (const who of WHOS) {
      const key = bucketKey("login", who);
      expect(key, `${who} 가 평문으로 남았다`).not.toContain(who);
      for (const frag of ["hong", "example", "203", "113", "1234", "usr_01", "@"]) {
        expect(key, `${who} / 조각 ${frag}`).not.toContain(frag);
      }
    }
  });

  it("같은 주체·같은 행위는 항상 같은 키다 — UPSERT 가 성립해야 한다", () => {
    for (const who of WHOS) {
      expect(bucketKey("login", who)).toBe(bucketKey("login", who));
    }
  });

  it("주체가 다르면 키가 다르고, 행위가 다르면 버킷이 섞이지 않는다", () => {
    expect(bucketKey("login", "a@b.com")).not.toBe(bucketKey("login", "c@d.com"));
    expect(bucketKey("login", "a@b.com")).not.toBe(bucketKey("lead.create", "a@b.com"));
  });

  it("빈 주체도 키를 만든다 (IP 를 못 읽는 요청을 통째로 통과시키지 않는다)", () => {
    expect(bucketKey("public.view", "")).toMatch(/^public\.view:[0-9a-f]{32}$/);
  });
});

describe("P-189: windowStartFor 는 윈도 경계로 내림한다", () => {
  it("login(15분) 경계", () => {
    expect(windowStartFor("login", "2026-10-22T00:07:30.000Z").toISOString()).toBe("2026-10-22T00:00:00.000Z");
    expect(windowStartFor("login", "2026-10-22T00:14:59.999Z").toISOString()).toBe("2026-10-22T00:00:00.000Z");
    expect(windowStartFor("login", "2026-10-22T00:15:00.000Z").toISOString()).toBe("2026-10-22T00:15:00.000Z");
  });

  it("lead.create(10분)·search(1분)·evidence.submit(1시간) 경계", () => {
    expect(windowStartFor("lead.create", "2026-10-22T00:09:59.999Z").toISOString()).toBe("2026-10-22T00:00:00.000Z");
    expect(windowStartFor("lead.create", "2026-10-22T00:10:00.000Z").toISOString()).toBe("2026-10-22T00:10:00.000Z");
    expect(windowStartFor("search", "2026-10-22T00:07:30.500Z").toISOString()).toBe("2026-10-22T00:07:00.000Z");
    expect(windowStartFor("evidence.submit", "2026-10-22T00:59:59.999Z").toISOString()).toBe("2026-10-22T00:00:00.000Z");
  });

  it("미등록 이름은 기본 윈도(1분)로 내림한다", () => {
    expect(windowStartFor("typo.lgoin", "2026-10-22T00:07:30.500Z").toISOString()).toBe("2026-10-22T00:07:00.000Z");
  });

  it("전수: 시작 시각은 now 를 넘지 않고, now 와의 간격이 윈도보다 작다", () => {
    for (const [name, , windowMs] of DOCUMENTED) {
      for (const offset of [0, 1, 999, 61_000, 3_599_999]) {
        const now = at(offset);
        const start = windowStartFor(name, now);
        const gap = now.getTime() - start.getTime();
        expect(gap, `${name} / +${offset}ms`).toBeGreaterThanOrEqual(0);
        expect(gap, `${name} / +${offset}ms`).toBeLessThan(windowMs);
        // 같은 윈도 안에서 다시 물어도 같은 행을 가리킨다 (멱등).
        expect(windowStartFor(name, start).getTime()).toBe(start.getTime());
      }
    }
  });

  it("시각을 해석할 수 없으면 조용히 엉뚱한 행을 만들지 않고 던진다", () => {
    expect(() => windowStartFor("login", "해석불가")).toThrow();
    expect(() => windowStartFor("login", new Date("해석불가"))).toThrow();
  });

  it("checkLimit 과 짝이 맞는다 — windowStartFor 가 준 시작 시각은 항상 '현재 윈도'다", () => {
    const now = new Date("2026-10-22T00:07:30.000Z");
    const start = windowStartFor("login", now);
    expect(checkLimit("login", 5, start, now).allowed).toBe(false); // 아직 같은 윈도 → 막힌다
    expect(checkLimit("login", 5, start, new Date("2026-10-22T00:15:00.000Z")).allowed).toBe(true);
  });
});
