/**
 * P-186 구조화 로그 + trace ID · P-130 페이지 조회 기록 — 전략 §2 **N-13**
 * (보안정책 §3 / 기술백서 §7: 로그·이벤트에 PII 원문 금지)
 *
 * 수용 기준(원장): P-186 "PII 원문이 로그에 남지 않는다" / P-130 "IP·UA 원문을 저장하지 않는다".
 *
 * 그래서 이 파일의 단정은 "무엇으로 치환되었는가"보다 **원문 조각이 결과에 남았는가**를
 * 문자열 포함으로 본다. 치환 라벨은 바뀔 수 있지만 복원 가능성은 바뀌면 안 된다.
 * `redact()` 는 로그로 가는 유일한 관문이므로 호출부가 무엇을 넘겼는지 몰라도 안전해야 한다.
 */

import { describe, expect, it } from "vitest";
import { hashVisitor, isSensitiveKey, redact, redactString } from "../src/redact";

const NOW = new Date("2026-10-22T00:00:00.000Z");

/** 리댁션 결과 전체를 한 문자열로 펼쳐 "어딘가에 남았는가"를 통째로 본다. */
function flat(value: unknown): string {
  return JSON.stringify(redact(value)) ?? "undefined";
}

/** 결과 어디에도 이 조각들이 없어야 한다 — 복원 불가능성의 조작적 정의. */
function expectNoTrace(result: string, fragments: readonly string[]): void {
  for (const f of fragments) {
    expect(result, `리댁션 결과에 원문 조각 "${f}" 이 남았다`).not.toContain(f);
  }
}

describe("P-186 / N-13: 문자열에 섞인 전화번호는 표기 방식과 무관하게 사라진다 (보안정책 §3)", () => {
  // 한국에서 실제로 입력되는 표기들. 하나라도 통과하면 로그에 전화번호가 쌓인다.
  const PHONES = [
    "010-1234-5678",
    "01012345678",
    "+82-10-1234-5678",
    "010 1234 5678",
    "０１０－１２３４－５６７８", // 한글 IME 전각 숫자
    "02-123-4567", // 국내 최단(9자리)
  ] as const;

  it("표기별로 전수 치환하고 숫자를 하나도 남기지 않는다", () => {
    for (const p of PHONES) {
      const out = redactString(p);
      expect(out, `${p} 가 치환되지 않았다`).toBe("[redacted:phone]");
      expect(out).not.toMatch(/\p{Nd}/u);
    }
  });

  it("문장 중간에 박혀 있어도 번호만 걷어내고 문맥은 남긴다", () => {
    const out = redactString("상담 요청자가 휴대폰 010-1234-5678 로 회신을 원함");
    expect(out).toContain("상담 요청자가 휴대폰");
    expect(out).toContain("로 회신을 원함");
    expectNoTrace(out, ["010", "1234", "5678"]);
  });

  it("로그 가독성에 필요한 비연락처 숫자는 보존한다 — 과도한 치환도 사고다", () => {
    // 타임스탬프가 사라지면 구조화 로그(P-186)를 읽을 수 없다.
    const line = "2026-10-22T00:00:00.000Z lead.created duration_ms=182 order=12345678";
    expect(redactString(line)).toBe(line);
    expect(redactString("2026-01-01 00:00 접수")).toBe("2026-01-01 00:00 접수");
  });
});

describe("P-186 / N-13: 이메일은 로컬파트와 도메인이 함께 사라진다", () => {
  const EMAILS = [
    "hong@example.com",
    "very.long.local+tag@sub.example.co.kr",
    "a@b.co",
    "A.B%c@EXAMPLE.io",
  ] as const;

  it("표기별로 전수 치환한다", () => {
    for (const e of EMAILS) {
      expect(redactString(e), `${e} 가 치환되지 않았다`).toBe("[redacted:email]");
    }
  });

  it("긴 문자열 안에 박힌 이메일도 도메인까지 지운다 (도메인만으로 조직이 식별된다)", () => {
    const out = redactString("문의는 hong.gil@example.co.kr 로 주세요 (utm_source=naver)");
    expect(out).toContain("utm_source=naver");
    expectNoTrace(out, ["hong.gil", "example.co.kr", "example", "@"]);
  });

  it("이메일과 전화번호가 같은 문장에 있어도 둘 다 사라진다", () => {
    const out = redactString("담당 hong@example.com / 010-1234-5678");
    expectNoTrace(out, ["hong", "example.com", "1234"]);
  });
});

describe("P-186 / N-13: 키 이름이 민감하면 값의 모양을 믿지 않고 통째로 가린다", () => {
  const PARTS = ["email", "phone", "contact", "token", "secret", "password", "authorization"] as const;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  it("민감 키 목록 × 대소문자·camelCase 변형을 전수로 잡는다", () => {
    for (const part of PARTS) {
      const variants = [
        part,
        part.toUpperCase(),
        cap(part),
        `user${cap(part)}`,
        `${part}Hash`,
        `${part}_encrypted`,
        `x-${part}`,
      ];
      for (const key of variants) {
        expect(isSensitiveKey(key), `${key} 가 민감 키로 잡히지 않았다`).toBe(true);
      }
    }
  });

  it("실제로 들어오는 조합된 이름들을 잡는다", () => {
    for (const key of ["contactChannel", "Authorization", "apiToken", "smtpPassword", "clientSecret", "userEmail"]) {
      expect(isSensitiveKey(key), `${key}`).toBe(true);
    }
  });

  it("민감하지 않은 키는 그대로 둔다 — 전부 가리면 로그를 읽을 수 없다", () => {
    for (const key of ["leadId", "status", "slug", "createdAt", "count", "correlationId"]) {
      expect(isSensitiveKey(key), `${key}`).toBe(false);
    }
  });

  it("패턴에 걸리지 않는 값(JWT·base64url 토큰)도 키 이름으로 가린다", () => {
    const payload = {
      leadId: "ld_1",
      correlationId: "req_abc",
      contactChannel: "010-1234-5678",
      Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig",
      apiToken: "tok_live_abcdefghijklmnop",
      smtpPassword: "p@ssw0rd!",
      clientSecret: "sk_test_0123456789",
      userEmail: "hong@example.com",
    };
    const out = redact(payload) as Record<string, unknown>;

    for (const k of ["contactChannel", "Authorization", "apiToken", "smtpPassword", "clientSecret", "userEmail"]) {
      expect(out[k], `${k} 가 가려지지 않았다`).toBe("[redacted]");
    }
    // 운영자가 추적에 쓰는 식별자는 남아야 한다 (P-186 trace ID).
    expect(out.leadId).toBe("ld_1");
    expect(out.correlationId).toBe("req_abc");

    expectNoTrace(JSON.stringify(out), ["010-1234-5678", "Bearer", "eyJhbGciOiJIUzI1NiJ9", "tok_live", "p@ssw0rd", "sk_test", "hong@example.com"]);
  });

  it("민감 키의 null·undefined 는 값을 만들지 않는다 (키 존재 자체는 PII 가 아니다)", () => {
    const out = redact({ email: null, phone: undefined }) as Record<string, unknown>;
    expect(out.email).toBeNull();
    expect(out.phone).toBeUndefined();
  });
});

describe("P-186 / N-13: 중첩 객체·배열 안쪽까지 내려간다", () => {
  it("이벤트 payload 모양(객체 안 배열 안 객체)에서 전부 치환한다", () => {
    const event = {
      eventId: "ev_1",
      aggregateId: "ld_1",
      payload: {
        lead: {
          note: "전화 010-1234-5678 로 연락 요청",
          channels: [
            { kind: "email", value: "hong@example.com" },
            { kind: "phone", value: "010-8765-4321" },
          ],
        },
        history: [["메일 a@b.com 발송"], { phone: "010-9999-8888" }],
      },
    };

    const out = redact(event) as {
      eventId: string;
      payload: { lead: { note: string; channels: { value: string }[] } };
    };

    expect(out.eventId).toBe("ev_1");
    expect(out.payload.lead.note).toBe("전화 [redacted:phone] 로 연락 요청");
    // 키가 민감하지 않은 자리(`value`)에서도 값 패턴으로 잡아낸다.
    expect(out.payload.lead.channels[0]?.value).toBe("[redacted:email]");
    expect(out.payload.lead.channels[1]?.value).toBe("[redacted:phone]");

    const s = JSON.stringify(out);
    // 이메일 흔적은 '@' 하나도 남지 않는다.
    expect(s).not.toContain("@");
    expectNoTrace(s, ["1234", "8765", "9999", "hong"]);
  });

  it("민감 키가 배열·객체를 가리키면 가지째 가린다 (`contacts` 는 `contact` 부분일치)", () => {
    const out = redact({
      contacts: [{ value: "hong@example.com" }, { value: "010-1234-5678" }],
      tokens: { session: "abc" },
    }) as Record<string, unknown>;
    expect(out.contacts).toBe("[redacted]");
    expect(out.tokens).toBe("[redacted]");
  });

  it("최상위가 배열이어도 각 원소를 훑는다", () => {
    const out = redact(["hong@example.com", { userPhone: "010-1234-5678" }, ["010-1111-2222"]]) as unknown[];
    expect(out[0]).toBe("[redacted:email]");
    expectNoTrace(JSON.stringify(out), ["hong", "1234", "1111"]);
  });
});

describe("P-186: 객체가 아닌 입력과 특수 객체 (호출부가 무엇을 넘겨도 죽지 않는다)", () => {
  it("null·undefined·boolean 은 그대로 돌려준다", () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(true)).toBe(true);
  });

  it("숫자는 치환하지 않는다 — 지표 집계값(value_numeric)이 사라지면 안 된다", () => {
    // 뒤집어 말하면 호출부가 전화번호를 number 로 넘기면 걸러지지 않는다.
    // 스키마상 연락처는 text 이고, 그 전제가 이 결정의 근거다 (redact.ts 주석).
    expect(redact(42)).toBe(42);
    expect(redact({ sampleSize: 128 })).toEqual({ sampleSize: 128 });
  });

  it("Date 는 ISO 문자열로 살리고 잘못된 Date 는 null 로 만든다", () => {
    expect(redact(NOW)).toBe("2026-10-22T00:00:00.000Z");
    expect(redact({ occurredAt: NOW })).toEqual({ occurredAt: "2026-10-22T00:00:00.000Z" });
    expect(redact(new Date("해석불가"))).toBeNull();
  });

  it("함수는 값으로 남기지 않는다", () => {
    expect(redact(() => 1)).toBe("[function]");
    expect(redact({ cb: () => 1 })).toEqual({ cb: "[function]" });
  });

  it("Error 는 name·message 만 남기고 message 의 PII 를 지운다 (stack 비노출 — P-187)", () => {
    const err = new Error("메일 발송 실패: hong@example.com (010-1234-5678)");
    const out = redact(err) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["name", "message"]);
    expect(out.name).toBe("Error");
    expectNoTrace(String(out.message), ["hong", "example.com", "1234"]);
  });

  it("Map 의 키 이름도 민감 키 판정을 받고, Set 의 원소도 훑는다", () => {
    const m = new Map<string, unknown>([
      ["userEmail", "hong@example.com"],
      ["note", "010-1234-5678"],
    ]);
    const out = redact(m) as Record<string, unknown>;
    expect(out.userEmail).toBe("[redacted]");
    expect(out.note).toBe("[redacted:phone]");

    expect(redact(new Set(["hong@example.com", "ok"]))).toEqual(["[redacted:email]", "ok"]);
  });
});

describe("P-186: 원본을 변형하지 않는다 (같은 객체가 응답에도 쓰인다)", () => {
  it("입력 객체와 중첩된 값이 그대로 보존된다", () => {
    const src = {
      userEmail: "hong@example.com",
      nested: { note: "010-1234-5678", list: ["a@b.com"] },
    };
    const before = JSON.stringify(src);

    const out = redact(src);

    expect(JSON.stringify(src)).toBe(before);
    expect(out).not.toBe(src);
    expect(src.nested.list[0]).toBe("a@b.com");
  });
});

describe("P-186: 순환 참조·과도한 깊이에서 프로세스를 멈추지 않는다", () => {
  it("자기 참조를 만나면 무한루프 대신 표시만 남긴다", () => {
    type Node = { userEmail: string; self?: Node };
    const a: Node = { userEmail: "hong@example.com" };
    a.self = a;

    const out = redact(a) as Record<string, unknown>;
    expect(out.userEmail).toBe("[redacted]");
    expect(out.self).toBe("[circular]");
  });

  it("상호 참조(a→b→a)도 끊는다", () => {
    const x: Record<string, unknown> = { note: "010-1234-5678" };
    const y: Record<string, unknown> = { x };
    x.y = y;

    const s = flat(x);
    expect(s).toContain("[circular]");
    expectNoTrace(s, ["1234"]);
  });

  it("배열 자기 참조도 끊는다", () => {
    const arr: unknown[] = ["hong@example.com"];
    arr.push(arr);

    const out = redact(arr) as unknown[];
    expect(out[0]).toBe("[redacted:email]");
    expect(out[1]).toBe("[circular]");
  });

  it("상한보다 깊이 묻힌 PII 는 가지째 잘려 나간다", () => {
    let deep: Record<string, unknown> = { userEmail: "hong@example.com", note: "010-1234-5678" };
    for (let i = 0; i < 20; i++) deep = { level: deep };

    const s = flat(deep);
    expect(s).toContain("[depth]");
    expectNoTrace(s, ["hong", "1234"]);
  });
});

describe("P-130 / N-13: hashVisitor — IP·UA 원문을 저장하지 않는다 (원장 수용기준)", () => {
  const IP = "203.0.113.9";
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
  const SALT = "pp_salt_2026";

  it("128bit(32자) 소문자 hex 만 돌려준다", () => {
    expect(hashVisitor(IP, UA, SALT)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("결과에 IP·UA 조각이 남지 않는다", () => {
    expectNoTrace(hashVisitor(IP, UA, SALT), ["203", "113", "iPhone", "Mozilla"]);
  });

  it("같은 방문자는 같은 값이어야 집계가 성립한다", () => {
    expect(hashVisitor(IP, UA, SALT)).toBe(hashVisitor(IP, UA, SALT));
  });

  it("IP·UA·salt 중 하나만 달라도 값이 달라진다 (salt 교체로 과거 해시가 무력화된다)", () => {
    const base = hashVisitor(IP, UA, SALT);
    expect(hashVisitor("203.0.113.10", UA, SALT)).not.toBe(base);
    expect(hashVisitor(IP, `${UA} Safari`, SALT)).not.toBe(base);
    expect(hashVisitor(IP, UA, "pp_salt_2027")).not.toBe(base);
  });

  it("구분자가 있어 조각 경계가 섞이지 않는다 (ip+ua 합치기 충돌 방지)", () => {
    // salt 가 같을 때 ("a","b") 와 ("ab","") 가 같은 해시가 되면 서로 다른 방문자가 하나로 집계된다.
    expect(hashVisitor("a", "b", SALT)).not.toBe(hashVisitor("ab", "", SALT));
  });
});

describe("N-13: 공백으로 이어 붙인 연락처 (후보 재분할)", () => {
  // `PHONE_RE` 의 문자 클래스에 `\s` 가 있어 두 번호가 **한 후보**로 잡힌다. 그러면 총 22자리가
  // 되어 9~15 범위를 벗어나고, 재분할이 없으면 "전화가 아니다"로 판정돼 둘 다 원문으로 남는다.
  // 메모·문의 본문에 연락처를 나란히 적는 입력은 드물지 않으므로 이 경로를 열어 둘 수 없다.
  it("공백으로 이어 붙인 전화번호 두 개가 모두 치환된다", () => {
    const out = redactString("연락처 010-1234-5678 010-8765-4321 입니다");
    expectNoTrace(out, ["1234", "8765"]);
  });

  it("세 개 이상도 모두 치환된다", () => {
    const out = redactString("010-1111-2222 010-3333-4444 010-5555-6666");
    expectNoTrace(out, ["1111", "3333", "5555"]);
  });

  it("공백으로 구분된 **한 개**의 번호는 여전히 치환된다 (재분할이 단일 번호를 깨지 않는다)", () => {
    // `\s` 를 정규식에서 빼는 방식으로 고치면 이 케이스를 놓친다.
    expectNoTrace(redactString("전화 010 1234 5678 로 주세요"), ["1234", "5678"]);
  });

  it("전화가 아닌 긴 숫자열은 그대로 둔다 (로그 가독성)", () => {
    const out = redactString("주문번호 20260101 00012345 입니다");
    expect(out).toContain("20260101");
  });
});

describe("N-13: uuid 식별자는 전화번호로 오인되지 않는다", () => {
  // `PHONE_RE` 의 문자 클래스에 하이픈이 있어서 uuid 뒷부분이 전화번호 후보로 잡힌다.
  // 실측으로 uuid 의 약 35% 가 그 경로를 탔다. audit_logs·outbox payload 는 PII 대신
  // **식별자만** 담는 설계인데(N-13 / 기술백서 §7), 그 식별자가 지워지면 조사도 연동도 불가능해진다.
  const SAMPLES = [
    "123e4567-e89b-12d3-a456-426614174000",
    "00000000-0000-4000-8000-000000000000",
    "9f8e7d6c-5b4a-4938-8271-615243342516",
    "11111111-2222-4333-8444-555555555555",
  ];

  it("uuid 가 그대로 보존된다", () => {
    for (const u of SAMPLES) {
      expect(redactString(u), `${u} 가 치환됐다`).toBe(u);
    }
  });

  it("문장 안에 섞인 uuid 도 보존된다", () => {
    const s = `evidenceId=123e4567-e89b-12d3-a456-426614174000 상태=verified`;
    expect(redactString(s)).toContain("123e4567-e89b-12d3-a456-426614174000");
  });

  it("uuid 를 보존하면서 같은 문자열의 연락처는 여전히 지운다", () => {
    const s = "userId=9f8e7d6c-5b4a-4938-8271-615243342516 연락처 010-1234-5678 a@b.com";
    const out = redactString(s);
    expect(out).toContain("9f8e7d6c-5b4a-4938-8271-615243342516");
    expect(out).not.toContain("1234");
    expect(out).not.toContain("a@b.com");
  });

  it("redact() 객체 경로에서도 uuid 가 보존된다", () => {
    const out = redact({ aggregateId: "123e4567-e89b-12d3-a456-426614174000", phone: "010-1234-5678" }) as Record<string, unknown>;
    expect(out.aggregateId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(String(out.phone)).not.toContain("1234");
  });
});
