/**
 * M11 Search 통합테스트 — P-150 전문가 검색 · P-152/P-153 (N-15) 노출 구분·랭킹 근거 ·
 * P-155 삭제·비공개 동기화 · P-197 검색 인덱스 PII 차단.
 *
 * 왜 실제 DB 가 필요한가:
 *   P-197("인덱싱 입력이 public_profile_view 뿐이다")과 P-155("비공개·삭제 시 즉시 제거")는
 *   **뷰의 WHERE 절**이 지키는 약속이다. 소스를 읽어 `FROM profiles` 가 없음을 확인하는 테스트는
 *   이미 `architecture.test.ts` 에 있고, 여기서는 그 뷰가 실제로 무엇을 내보내고 무엇을 감추는지를
 *   행 단위로 확인한다 — 비공개 필드를 **가진** 프로필을 만들어 두고 결과 어디에도 그 값이 없는지 본다.
 *
 * 로컬에는 Postgres 가 없다(CI 에만 있다). DB 가 없으면 스위트 전체를 skip 한다.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "../src/lib/ctx";
import { closePool, one, q } from "../src/lib/db";
import { migrate } from "../src/migrate";
import * as profile from "../src/modules/profile";
import * as search from "../src/modules/search";

const DB = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;

/** N-15 의 닫힌 근거 코드 집합. 수용 기준을 테스트에 적어 둔다 — 구현 상수를 import 하면 둘이 같이 틀린다. */
const ALLOWED_BASIS_CODES = [
  "specialty_match",
  "region_match",
  "badge_present",
  "recently_active",
  "promoted_placement",
];

const createdUsers: string[] = [];

function ctxFor(userId: string | null): Ctx {
  // `sessionId` 는 Ctx 의 필수 필드다 (P-003). 테스트 문맥에는 세션 행이 없다.
  return { userId, sessionId: null, ip: "127.0.0.1", userAgent: "vitest", requestId: randomUUID() };
}

interface Subject {
  userId: string;
  ctx: Ctx;
  profileId: string;
  slug: string;
  /** 공개되면 **안 되는** 값들. 결과 JSON 에 이 문자열이 하나라도 있으면 P-197 위반이다. */
  secrets: { email: string; phone: string };
}

/**
 * 비공개 필드를 가진 사용자 + 발행된 프로필.
 *
 * 이메일·전화를 **일부러 유일한 토큰**으로 만든다. 흔한 값(`test@example.com`)으로 두면
 * "응답에 없다"가 우연히 참이 될 수 있고, 그러면 테스트가 아무것도 증명하지 못한다.
 */
async function newSubject(input: {
  specialties?: string[];
  region?: string | null;
  showRegion?: boolean;
  displayName?: string;
}): Promise<Subject> {
  const userId = randomUUID();
  const email = `secret-${userId}@example.test`;
  const phone = `phone-${randomUUID()}`;
  await q(`INSERT INTO users (id, email, phone, auth_provider, status) VALUES ($1,$2,$3,'email','active')`, [
    userId,
    email,
    phone,
  ]);
  createdUsers.push(userId);

  const ctx = ctxFor(userId);
  const created = await profile.createProfile(ctx, {
    slug: `se-${randomUUID().slice(0, 18)}`,
    displayName: input.displayName ?? "검색 테스트",
    specialties: input.specialties ?? [],
    region: input.region ?? null,
    publicSettings: { showRegion: input.showRegion === true, showEmail: false, showPhone: false },
  });
  await profile.publish(ctx);
  return { userId, ctx, profileId: created.id, slug: created.slug, secrets: { email, phone } };
}

async function slugsFor(specialty: string): Promise<string[]> {
  const res = await search.searchProfiles({ specialties: [specialty] });
  return res.results.map((r) => r.slug);
}

async function rejectedWith(p: Promise<unknown>, code: string, status?: number): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as { code?: string; status?: number },
  );
  expect(err, `거부되지 않았다 (기대 code=${code})`).not.toBeNull();
  expect(err?.code).toBe(code);
  if (status !== undefined) expect(err?.status).toBe(status);
}

describe.skipIf(!DB)("M11 Search 통합 (실제 Postgres)", () => {
  beforeAll(async () => {
    await migrate();
  }, 60_000);

  afterAll(async () => {
    if (createdUsers.length > 0) {
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
    }
    await closePool();
  }, 60_000);

  describe("P-197 / N-4: 인덱싱 입력이 public_profile_view 뿐이다", () => {
    it(
      "비공개 필드를 가진 프로필을 검색해도 그 값이 응답 어디에도 없다",
      { timeout: 20_000 },
      async () => {
        const specialty = `spec-${randomUUID().slice(0, 12)}`;
        const region = `region-${randomUUID().slice(0, 12)}`;
        const subject = await newSubject({ specialties: [specialty], region, showRegion: false });

        const res = await search.searchProfiles({ specialties: [specialty] });
        expect(res.results.map((r) => r.slug)).toContain(subject.slug);

        // 응답 **전체**를 문자열로 바꿔 검사한다. 필드를 하나씩 보면 중첩에 섞여 나온 값을 놓친다.
        const json = JSON.stringify(res);
        expect(json, "이메일이 검색 응답에 들어갔다").not.toContain(subject.secrets.email);
        expect(json, "전화번호가 검색 응답에 들어갔다").not.toContain(subject.secrets.phone);
        expect(json, "사용자 id 가 검색 응답에 들어갔다").not.toContain(subject.userId);
        // showRegion=false 면 공개 뷰가 지역을 지운다 (P-024/P-029). 결과에도 들어올 길이 없다.
        expect(json, "비공개 지역이 검색 응답에 들어갔다").not.toContain(region);

        const hit = res.results.find((r) => r.slug === subject.slug);
        expect(hit?.region).toBeNull();
        // 결과 객체의 키 집합도 공개 계약과 같아야 한다 — 뷰에 컬럼이 늘어도 응답은 그대로다.
        expect(Object.keys(hit ?? {}).sort()).toEqual(
          [
            "badgeTypes",
            "displayName",
            "headline",
            "placement",
            "profileId",
            "rankingBasis",
            "region",
            "slug",
            "specialties",
          ].sort(),
        );
      },
    );

    it(
      "공개 설정을 켠 지역은 정상적으로 검색·노출된다 (가리는 것이 '전부 숨김'은 아니다)",
      { timeout: 20_000 },
      async () => {
        const specialty = `spec-${randomUUID().slice(0, 12)}`;
        const region = `region-${randomUUID().slice(0, 12)}`;
        const subject = await newSubject({ specialties: [specialty], region, showRegion: true });

        const res = await search.searchProfiles({ region });
        const hit = res.results.find((r) => r.slug === subject.slug);
        expect(hit, "showRegion=true 인데 지역 필터로 찾지 못했다").toBeDefined();
        expect(hit?.region).toBe(region);
        expect(hit?.rankingBasis).toContain("region_match");
        // 지역을 공개했다고 연락처가 함께 열리지는 않는다.
        expect(JSON.stringify(res)).not.toContain(subject.secrets.email);
      },
    );

    it(
      "색인 갱신도 공개 뷰만 읽는다: 뷰에 없으면 '제거'로 끝난다",
      { timeout: 20_000 },
      async () => {
        const subject = await newSubject({ specialties: [`spec-${randomUUID().slice(0, 12)}`] });
        expect(await search.reindexProfile(subject.profileId)).toEqual({ indexed: true, removed: false });

        await profile.unpublish(subject.ctx);
        // 왜 비공개가 되었는지 알아내려고 `profiles` 를 읽으면 그 순간 P-197 이 깨진다 →
        // 구현은 "뷰에 없다 = 제거"로 답한다.
        expect(await search.reindexProfile(subject.profileId)).toEqual({ indexed: false, removed: true });
        // 존재하지 않는 프로필도 같은 답이다(존재 여부를 알려 주지 않는다).
        expect(await search.reindexProfile(randomUUID())).toEqual({ indexed: false, removed: true });
      },
    );
  });

  describe("P-155: 비공개·삭제는 다음 조회에서 즉시 반영된다", () => {
    it(
      "발행된 프로필은 검색되고, unpublish 하면 즉시 사라진다",
      { timeout: 20_000 },
      async () => {
        const specialty = `spec-${randomUUID().slice(0, 12)}`;
        const subject = await newSubject({ specialties: [specialty] });

        expect(await slugsFor(specialty)).toContain(subject.slug);

        await profile.unpublish(subject.ctx);
        // 동기화 작업을 돌리지 않았다. Postgres 폴백에서는 **공개 뷰가 곧 색인**이므로 지연 창이 없다.
        expect(await slugsFor(specialty)).not.toContain(subject.slug);

        // 다시 발행하면 다시 검색된다 (제거가 영구 삭제가 아니다).
        await profile.publish(subject.ctx);
        expect(await slugsFor(specialty)).toContain(subject.slug);
      },
    );

    it(
      "삭제된 사용자의 프로필도 사라진다 (뷰가 users.status 를 본다)",
      { timeout: 20_000 },
      async () => {
        const specialty = `spec-${randomUUID().slice(0, 12)}`;
        const subject = await newSubject({ specialties: [specialty] });
        expect(await slugsFor(specialty)).toContain(subject.slug);

        // 모듈 경로(`identity.requestAccountDeletion`)는 `published_at` 까지 지운다. 그러면 두 조건이
        // 섞여서 "users.status 조건이 실제로 동작하는지"를 확인할 수 없다 — 그래서 상태만 바꾼다.
        await q(`UPDATE users SET status = 'deleted', deleted_at = now() WHERE id = $1`, [subject.userId]);

        expect(await slugsFor(specialty)).not.toContain(subject.slug);
        // published_at 은 그대로다 → 사라진 이유가 발행 취소가 아니라 계정 상태라는 증거.
        const row = await one<{ published_at: Date | null }>(`SELECT published_at FROM profiles WHERE id = $1`, [
          subject.profileId,
        ]);
        expect(row?.published_at).not.toBeNull();
      },
    );

    it(
      "정지된 계정의 프로필도 사라진다",
      { timeout: 20_000 },
      async () => {
        const specialty = `spec-${randomUUID().slice(0, 12)}`;
        const subject = await newSubject({ specialties: [specialty] });
        await q(`UPDATE users SET status = 'suspended' WHERE id = $1`, [subject.userId]);
        expect(await slugsFor(specialty)).not.toContain(subject.slug);
      },
    );
  });

  describe("P-152 / P-153 / N-15: 모든 결과에 노출 구분과 랭킹 근거가 있다", () => {
    it(
      "결과마다 placement 와 비어 있지 않은 rankingBasis 가 있고, 코드는 허용 집합 안이다",
      { timeout: 20_000 },
      async () => {
        const specialty = `spec-${randomUUID().slice(0, 12)}`;
        const a = await newSubject({ specialties: [specialty], displayName: "검색 결과 가" });
        const b = await newSubject({ specialties: [specialty], displayName: "검색 결과 나" });

        const res = await search.searchProfiles({ specialties: [specialty] });
        expect(res.results.map((r) => r.slug).sort()).toEqual([a.slug, b.slug].sort());

        for (const r of res.results) {
          expect(r.placement).toBe("organic");
          expect(Array.isArray(r.rankingBasis)).toBe(true);
          expect(r.rankingBasis.length, `근거 없는 결과: ${r.slug}`).toBeGreaterThan(0);
          for (const code of r.rankingBasis) {
            expect(ALLOWED_BASIS_CODES, `허용 집합 밖 근거 코드: ${code}`).toContain(code);
          }
          // 전문분야로 찾았으므로 그 사실이 근거에 적혀 있어야 한다(재현 가능한 근거).
          expect(r.rankingBasis).toContain("specialty_match");
        }

        // 유료 노출 자리는 **지금 비어 있다**. 광고 상품도, 노출 판매 테이블도 없다.
        expect(res.promoted).toEqual([]);
        // 응답만 보고도 무엇이 순서를 정했는지 알 수 있어야 한다.
        expect(res.basis.sort.length).toBeGreaterThan(0);
        expect(res.basis.engine.length).toBeGreaterThan(0);
        expect(res.basis.codes.length).toBeGreaterThan(0);
        for (const code of res.basis.codes) expect(ALLOWED_BASIS_CODES).toContain(code);
        // 질의를 그대로 되돌려 준다 — 화면이 "무엇으로 찾았는지" 보여줄 수 있어야 한다.
        expect(res.query.specialties).toEqual([specialty]);
      },
    );

    it(
      "근거를 만들 수 없는 행은 응답에서 버려지고, 모듈은 터지지 않는다",
      { timeout: 20_000 },
      async () => {
        // 이름만 스쳐 맞는 프로필: 전문분야·지역·배지가 없다.
        // 이름에 다른 테스트의 표시명과 겹치는 조각을 넣지 않는다 — pg_trgm 유사도가 남의 프로필을
        // 끌어오면 이 테스트가 보려는 "근거 없는 단 한 행"이 흐려진다.
        const name = `noevidence-${randomUUID().slice(0, 12)}`;
        const subject = await newSubject({ displayName: name, specialties: [], region: null });

        // 발행 직후에는 `recently_active` 근거가 붙어 결과로 나온다.
        const fresh = await search.searchProfiles({ q: name });
        expect(fresh.results).toHaveLength(1);
        expect(fresh.results[0]?.slug).toBe(subject.slug);
        expect(fresh.results[0]?.rankingBasis).toEqual(["recently_active"]);

        // `now` 를 앞으로 밀면 그 근거도 사라진다 — 근거가 시각에 의존하므로 `now` 를 주입받는다.
        const far = new Date(Date.now() + 400 * 86_400_000);
        const stale = await search.searchProfiles({ q: name }, far);
        expect(stale.results).toEqual([]);
        // 버렸다는 사실이 수치로 남는다(투명성). `validateSearchResults` 가 터지지 않는 이유다.
        expect(stale.dropped).toBeGreaterThanOrEqual(1);

        // 필터가 하나도 없는 전수 조회는 400 으로 **거부**된다 — 근거를 만들 수 없는 응답이기 때문이고,
        // 예외로 터지는 것이 아니라 입력 오류로 끝난다.
        await rejectedWith(search.searchProfiles({}), "query_required", 400);
        await rejectedWith(search.searchProfiles({ q: "   " }), "query_required", 400);
      },
    );
  });

  describe("N-3: 검색 응답에 점수·순위 필드가 없다", () => {
    it(
      "결과에 score·rank 류 키가 없다",
      { timeout: 20_000 },
      async () => {
        const specialty = `spec-${randomUUID().slice(0, 12)}`;
        const subject = await newSubject({ specialties: [specialty] });

        const res = await search.searchProfiles({ specialties: [specialty] });
        const hit = res.results.find((r) => r.slug === subject.slug);
        expect(hit).toBeDefined();

        for (const key of ["score", "trustScore", "rank", "weight", "relevance", "similarity", "sortKey"]) {
          expect(hit, `결과에 ${key} 가 있다`).not.toHaveProperty(key);
        }
        // 중첩 어디에도 없어야 한다 — 점수가 생기면 그것이 곧 단일 신뢰점수다.
        expect(JSON.stringify(res)).not.toMatch(/"(score|trustScore|rank|weight|relevance|similarity)"\s*:/);
      },
    );
  });
});
