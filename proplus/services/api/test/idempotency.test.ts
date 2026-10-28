/**
 * Idempotency-Key 통합테스트 — P-185 (데이터모델 §5 / CLAUDE.md §5).
 *
 * 수용기준: "모든 create/update API 가 재시도 시 첫 응답을 재생한다."
 *
 * 왜 실제 Postgres 가 필요한가:
 *   이 기능의 보증은 전부 저장소에 있다 — `idempotency_keys` 의 PK(scope, key) 가 경쟁 상태에서
 *   한 응답만 남기고, `request_hash` 가 "같은 키로 다른 요청"을 구분하고, `response` 컬럼에는
 *   **암호문만** 들어간다(N-13: 리드 생성 응답이 멱등 캐시에 들어가면 그 테이블이 PII 사본
 *   저장소가 된다). 순수 함수로 확인할 수 있는 부분이 없다.
 *
 * 로컬에는 Postgres 가 없다(CI 전용). DB 가 없으면 스위트 전체를 skip 한다.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, one, q } from "../src/lib/db";
import { idempotencyLookup, idempotencyStore, isValidIdempotencyKey } from "../src/lib/idempotency";
import { migrate } from "../src/migrate";

const DB = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB)("P-185 Idempotency-Key (통합 · Postgres 필요)", () => {
  const scopes: string[] = [];

  beforeAll(async () => {
    await migrate();
  }, 60_000);

  afterAll(async () => {
    // 이 테이블은 users 에 매달려 있지 않다. 내가 만든 scope 만 지운다.
    if (scopes.length) await q(`DELETE FROM idempotency_keys WHERE scope = ANY($1::text[])`, [scopes]);
    await closePool();
  }, 30_000);

  /** scope 는 caller+method+path 다 — 같은 키를 다른 호출자가 써도 섞이지 않게 하는 경계다. */
  function newScope(path = "/api/v1/leads"): string {
    const scope = `vitest:user-${randomUUID()}:POST:${path}`;
    scopes.push(scope);
    return scope;
  }

  /** 클라이언트가 만드는 불투명 키. 길이·문자 집합은 `isValidIdempotencyKey` 가 정한다. */
  function newKey(): string {
    return randomUUID();
  }

  async function rejection(p: Promise<unknown>): Promise<{ status: number | undefined; code: string | undefined }> {
    try {
      await p;
    } catch (e) {
      const err = e as { status?: number; code?: string };
      return { status: err.status, code: err.code };
    }
    return expect.unreachable("거부될 것으로 기대한 호출이 성공했다");
  }

  it(
    "같은 키·같은 본문이면 첫 응답을 그대로 재생한다",
    { timeout: 20_000 },
    async () => {
      const scope = newScope();
      const key = newKey();
      const request = { contactName: "박고객", offerId: null };
      const response = { id: randomUUID(), stage: "new", contactMasked: "pa***@example.test" };

      // 저장 전에는 캐시가 없다 — 라우트는 이때 실제 처리를 한다.
      expect(await idempotencyLookup(scope, key, request)).toBeNull();

      await idempotencyStore(scope, key, request, 201, response);

      const replayed = await idempotencyLookup<typeof response>(scope, key, request);
      expect(replayed).not.toBeNull();
      expect(replayed?.status).toBe(201);
      // 상태코드까지 같아야 "재생"이다. 201 을 200 으로 바꿔 주면 클라이언트 분기가 달라진다.
      expect(replayed?.body).toEqual(response);
    },
  );

  it(
    "같은 키에 다른 본문이 오면 재생하지 않고 409 로 끊는다",
    { timeout: 20_000 },
    async () => {
      const scope = newScope();
      const key = newKey();
      const first = { contactName: "박고객", contact: "a@example.test" };
      await idempotencyStore(scope, key, first, 201, { id: randomUUID() });

      // 같은 키로 **다른 요청**을 보내는 것은 재시도가 아니라 클라이언트 버그다.
      // 조용히 첫 응답을 돌려주면 사용자는 보내지도 않은 결과를 받는다 — 그게 더 위험하다.
      const reused = await rejection(
        idempotencyLookup(scope, key, { contactName: "김고객", contact: "b@example.test" }),
      );
      expect(reused.status).toBe(409);
      expect(reused.code).toBe("idempotency_key_reused");

      // 지문은 JSON 직렬화 결과다 — 필드 순서만 바뀌어도 "다른 요청"으로 본다.
      // 조용한 오재생 대신 409 를 내는 쪽(fail-closed)이 현재 계약이다.
      const reordered = await rejection(
        idempotencyLookup(scope, key, { contact: "a@example.test", contactName: "박고객" }),
      );
      expect(reordered.code).toBe("idempotency_key_reused");

      // 원래 본문으로는 여전히 재생된다 — 실패한 조회가 저장된 응답을 망가뜨리지 않는다.
      expect((await idempotencyLookup(scope, key, first))?.status).toBe(201);
    },
  );

  it(
    "다른 scope 의 같은 키는 서로 간섭하지 않는다",
    { timeout: 20_000 },
    async () => {
      const key = newKey();
      const mine = newScope("/api/v1/leads");
      const other = newScope("/api/v1/leads");
      const otherPath = `vitest:same-caller:POST:/api/v1/offers/${randomUUID()}`;
      scopes.push(otherPath);

      await idempotencyStore(mine, key, { a: 1 }, 201, { who: "mine" });

      // 다른 호출자: 같은 키를 써도 내 응답을 보지 못하고, 409 도 나지 않는다(그의 첫 요청이다).
      expect(await idempotencyLookup(other, key, { a: 2 })).toBeNull();
      // 같은 호출자라도 다른 method+path 면 다른 scope 다.
      expect(await idempotencyLookup(otherPath, key, { a: 2 })).toBeNull();

      // 내 캐시는 그대로다.
      expect((await idempotencyLookup<{ who: string }>(mine, key, { a: 1 }))?.body.who).toBe("mine");
    },
  );

  it(
    "같은 키로 두 번 저장해도 첫 응답이 유지된다 (경쟁 상태에서 먼저 쓴 쪽이 이긴다)",
    { timeout: 20_000 },
    async () => {
      const scope = newScope();
      const key = newKey();
      const request = { contactName: "박고객" };

      await idempotencyStore(scope, key, request, 201, { attempt: "first" });
      // 두 응답 중 하나를 고르는 것보다, 재시도가 **항상 같은 값**을 받는 것이 중요하다.
      await idempotencyStore(scope, key, request, 200, { attempt: "second" });

      const hit = await idempotencyLookup<{ attempt: string }>(scope, key, request);
      expect(hit?.status).toBe(201);
      expect(hit?.body.attempt).toBe("first");

      const rows = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM idempotency_keys WHERE scope = $1 AND key = $2`,
        [scope, key],
      );
      expect(rows[0]?.n).toBe("1");
    },
  );

  it(
    "N-13: 저장된 응답과 요청 지문에 PII 원문이 남지 않는다",
    { timeout: 20_000 },
    async () => {
      const scope = newScope();
      const key = newKey();
      const email = "hong.gildong@example.test";
      const phone = "010-9876-5432";
      // 리드 생성 응답·요청에는 연락처와 일회성 토큰이 들어갈 수 있다. 그게 이 테이블을
      // 위험하게 만드는 이유이고, 그래서 구현이 응답을 암호화한다 (lib/idempotency.ts).
      const request = { contact: email, contactName: "홍길동" };
      const response = { id: randomUUID(), contact: phone, inviteToken: "one-time-token-value" };

      await idempotencyStore(scope, key, request, 201, response);

      const row = await one<{ response: string; request_hash: string }>(
        `SELECT response::text AS response, request_hash FROM idempotency_keys WHERE scope = $1 AND key = $2`,
        [scope, key],
      );
      expect(row).not.toBeNull();
      // 저장된 것은 봉인된 문자열 하나뿐이다 (키 회전을 위한 v1: 접두사 — lib/crypto.ts).
      expect(row?.response).toContain("v1:");
      expect(row?.response).not.toContain(email);
      expect(row?.response).not.toContain("hong.gildong");
      expect(row?.response).not.toContain(phone);
      expect(row?.response).not.toContain("9876");
      expect(row?.response).not.toContain("one-time-token-value");

      // 요청 본문도 평문으로 남지 않는다 — 지문(sha256)만 저장한다.
      expect(row?.request_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.request_hash).not.toContain("hong");

      // 리댁션이 아니라 **암호화**다: 호출자에게는 원래 응답이 손실 없이 돌아온다.
      const replayed = await idempotencyLookup<typeof response>(scope, key, request);
      expect(replayed?.body).toEqual(response);
    },
  );

  describe("isValidIdempotencyKey: 너무 짧거나 길거나 이상한 키는 거부한다", () => {
    it("받아들이는 키", () => {
      expect(isValidIdempotencyKey(randomUUID())).toBe(true); // 클라이언트의 일반적인 선택
      expect(isValidIdempotencyKey("a".repeat(8))).toBe(true); // 하한
      expect(isValidIdempotencyKey("a".repeat(128))).toBe(true); // 상한
      expect(isValidIdempotencyKey("lead-create.2026:01_01")).toBe(true);
    });

    it("거부하는 키", () => {
      // 짧은 키는 **다른 사용자의 재시도와 충돌**할 수 있다(scope 가 caller 를 포함해도
      // 같은 사용자의 서로 다른 요청이 같은 키를 쓰면 응답이 섞인다).
      expect(isValidIdempotencyKey("abc")).toBe(false);
      expect(isValidIdempotencyKey("a".repeat(7))).toBe(false);
      expect(isValidIdempotencyKey("a".repeat(129))).toBe(false);
      expect(isValidIdempotencyKey("")).toBe(false);
      expect(isValidIdempotencyKey(null)).toBe(false);
      expect(isValidIdempotencyKey(undefined)).toBe(false);
      // 공백·경로문자·비ASCII 는 로그·헤더 파싱에서 다루기 어렵고 키 공간을 모호하게 만든다.
      expect(isValidIdempotencyKey("has space 12345")).toBe(false);
      expect(isValidIdempotencyKey("abc/def/ghij")).toBe(false);
      expect(isValidIdempotencyKey("키키키키키키키키")).toBe(false);
      expect(isValidIdempotencyKey("new\nline-key")).toBe(false);
    });
  });
});
