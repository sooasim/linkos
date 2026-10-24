/**
 * M06 Catalog & Offer 통합테스트 — P-090~P-092 · P-141 (전략 §9 "통합: 트리거·뷰·제약이 실제로 막는지").
 *
 * 왜 단위테스트로 충분하지 않은가:
 *   이 모듈의 비타협 약속 세 가지가 **전부 DB 안에** 있다.
 *     · 품절·만료 판정(P-092)은 `public_offer_view` 의 `now()` 비교다 — 배치도, 애플리케이션 분기도 아니다.
 *     · 가격 완전성(P-091)은 `offer_shown_price_complete` CHECK 다 — 모듈을 우회해 INSERT 해도 막혀야 한다.
 *     · 공개 필드 경계(N-4)는 뷰의 컬럼 목록 + DTO allowlist 두 겹이다.
 *   순수 함수 테스트는 이 중 어느 것도 건드리지 못한다. 그래서 실제 Postgres 가 필요하다.
 *
 * 로컬에는 Postgres 가 없다(CI 에만 있다). DB 가 없으면 **스위트 전체를 skip** 한다 —
 * 로컬 `pnpm proplus:test` 가 빨간색이면 아무도 테스트를 돌리지 않게 되고, 그건 테스트가 없는 것보다 나쁘다.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "../src/lib/ctx";
import { closePool, one, q } from "../src/lib/db";
import { migrate } from "../src/migrate";
import * as billing from "../src/modules/billing";
import * as catalog from "../src/modules/catalog";
import * as profile from "../src/modules/profile";
import * as proof from "../src/modules/proof";

const DB = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;

/** 이 파일이 만든 사용자. afterAll 에서 CASCADE 로 걷어낸다. */
const createdUsers: string[] = [];

function ctxFor(userId: string | null): Ctx {
  // Ctx 의 `sessionId` 는 필수 필드다 (P-003: 요청 세션을 가리키는 id). 테스트 문맥에는 세션이 없다.
  return { userId, sessionId: null, ip: "127.0.0.1", userAgent: "vitest", requestId: randomUUID() };
}

/**
 * 사용자 한 명. 시드(`db/seeds/seed.ts`)와 같은 방식으로 직접 INSERT 한다 —
 * 가입 경로(로그인 링크)는 메일 발송을 끼고 있고, 이 테스트의 주제가 아니다.
 * 이메일은 `randomUUID()` 로 만들어 같은 DB 에서 반복 실행해도 UNIQUE 와 충돌하지 않게 한다.
 */
async function newUser(platformRole: "none" | "reviewer" | "admin" = "none"): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO users (id, email, auth_provider, status, platform_role) VALUES ($1,$2,'email','active',$3)`,
    [id, `test-${id}@example.test`, platformRole],
  );
  createdUsers.push(id);
  return id;
}

interface Owner {
  userId: string;
  ctx: Ctx;
  profileId: string;
  slug: string;
}

/** 발행된 프로필 하나. **모듈 경로로** 만든다 — 시드와 같은 원칙(정책 경로를 우회하지 않는다). */
async function newPublishedProfile(): Promise<Owner> {
  const userId = await newUser();
  const ctx = ctxFor(userId);
  const created = await profile.createProfile(ctx, {
    slug: `cat-${randomUUID().slice(0, 18)}`,
    displayName: "카탈로그 테스트",
    headline: "의료기기 유통",
    region: "서울",
  });
  await profile.publish(ctx);
  return { userId, ctx, profileId: created.id, slug: created.slug };
}

/**
 * 거부를 단정한다. `rejects.toThrow()` 는 메시지만 보므로 ApiError 의 `code`·`status` 까지 못 박는다 —
 * 같은 400 이라도 **다른 이유로** 막히면 테스트가 통과해 버린다(예: 제목 길이 때문에 막힌 것을
 * "가격이 불완전해서 막혔다"로 읽는 사고).
 */
async function rejectedWith(p: Promise<unknown>, code: string, status?: number): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as { code?: string; status?: number; message?: string },
  );
  expect(err, `거부되지 않았다 (기대 code=${code})`).not.toBeNull();
  expect(err?.code).toBe(code);
  if (status !== undefined) expect(err?.status).toBe(status);
}

async function idsOf(slug: string): Promise<string[]> {
  return (await catalog.publicOffers(slug)).map((o) => o.id);
}

describe.skipIf(!DB)("M06 Catalog 통합 (실제 Postgres)", () => {
  beforeAll(async () => {
    // 멱등하다 — 이미 적용된 마이그레이션은 건너뛴다.
    await migrate();
  }, 60_000);

  afterAll(async () => {
    if (createdUsers.length > 0) {
      // `evidence` 는 users CASCADE 로 지워지지 않는다: `subject_id` 는 FK 가 아니고 `submitted_by` 는
      // ON DELETE 가 없다(NO ACTION). 먼저 지우지 않으면 사용자 삭제가 FK 위반으로 실패한다.
      await q(`DELETE FROM evidence WHERE submitted_by = ANY($1::uuid[])`, [createdUsers]);
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
    }
    // 부르지 않으면 vitest 가 끝나지 않는다 (풀의 연결이 살아 있다).
    await closePool();
  }, 60_000);

  describe("P-092: 품절·만료는 읽기 시점에 공개에서 빠진다", () => {
    it(
      "초안은 안 보이고, active 면 보이고, available_until 이 과거가 되면 배치 없이 사라진다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const offer = await catalog.createOffer(owner.ctx, { title: "영상진단 장비 도입 상담" });

        // 반쯤 쓴 카드가 공개되지 않아야 하므로 생성은 항상 draft 다.
        expect(offer.status).toBe("draft");
        expect(await idsOf(owner.slug)).not.toContain(offer.id);

        await catalog.setOfferStatus(owner.ctx, offer.id, "active");
        expect(await idsOf(owner.slug)).toContain(offer.id);

        // 만료. **같은 요청 안에서** 즉시 사라져야 한다 — 뷰가 `available_until > now()` 를 보기 때문이고,
        // 어떤 워커도 돌지 않았다는 사실이 이 단정의 핵심이다 (N-9 와 같은 정신).
        await catalog.updateOffer(owner.ctx, offer.id, {
          title: offer.title,
          availableUntil: new Date(Date.now() - 60_000),
        });
        expect(await idsOf(owner.slug)).not.toContain(offer.id);

        // 만료를 풀면 다시 보인다 → 판정이 저장된 플래그가 아니라 읽기 시점 비교라는 증거다.
        await catalog.updateOffer(owner.ctx, offer.id, { title: offer.title, availableUntil: null });
        expect(await idsOf(owner.slug)).toContain(offer.id);

        // 품절·보관도 뷰 조건으로 즉시 빠진다.
        await catalog.setOfferStatus(owner.ctx, offer.id, "sold_out");
        expect(await idsOf(owner.slug)).not.toContain(offer.id);

        await catalog.setOfferStatus(owner.ctx, offer.id, "active");
        expect(await idsOf(owner.slug)).toContain(offer.id);
        await catalog.setOfferStatus(owner.ctx, offer.id, "archived");
        expect(await idsOf(owner.slug)).not.toContain(offer.id);
      },
    );

    it(
      "모듈을 우회해 직접 INSERT 한 만료 상품도 공개 뷰에서 걸러진다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const row = await one<{ id: string }>(
          `INSERT INTO offers (owner_type, owner_id, profile_id, title, price_display_policy, status, published_at, available_until)
           VALUES ('profile',$1,$1,'만료된 상품','inquiry','active', now() - interval '1 day', now() - interval '1 hour')
           RETURNING id::text AS id`,
          [owner.profileId],
        );
        expect(row?.id).toBeTruthy();
        // 상태는 active 인데 기한이 지났다. 공개 판정은 상태만 보지 않는다.
        expect(await idsOf(owner.slug)).not.toContain(row?.id);
      },
    );

    it(
      "비발행 프로필의 상품은 slug 를 알아도 보이지 않는다 (N-4)",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const offer = await catalog.createOffer(owner.ctx, { title: "비공개 프로필의 상품" });
        await catalog.setOfferStatus(owner.ctx, offer.id, "active");
        expect(await idsOf(owner.slug)).toContain(offer.id);

        await profile.unpublish(owner.ctx);
        // `publicOffers` 가 `public_profile_view` 와 join 하므로 프로필이 빠지면 상품도 함께 빠진다.
        expect(await catalog.publicOffers(owner.slug)).toEqual([]);
      },
    );
  });

  describe("N-4: 공개 상품 응답은 allowlist 필드만 담는다", () => {
    it(
      "소유자 식별자·상태·발행시각이 응답에 없다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const offer = await catalog.createOffer(owner.ctx, {
          title: "초음파 장비 데모 신청",
          description: "제조사 공식 데모 일정으로 연결됩니다.",
          externalUrl: "https://demo.example.test/booking",
        });
        await catalog.setOfferStatus(owner.ctx, offer.id, "active");

        const dto = (await catalog.publicOffers(owner.slug))[0];
        expect(dto).toBeDefined();

        // 수용 기준을 코드로 옮긴 목록이다. 구현의 상수를 import 하지 않는 이유: 구현이 allowlist 를
        // 넓히면 테스트도 같이 넓어져 아무것도 막지 못하게 된다.
        expect(Object.keys(dto ?? {}).sort()).toEqual(
          [
            "description",
            "externalUrl",
            "id",
            "ownerType",
            "priceAmount",
            "priceCurrency",
            "priceDisplayPolicy",
            "title",
          ].sort(),
        );
        for (const key of ["ownerId", "profileId", "status", "publishedAt", "availableUntil", "createdAt"]) {
          expect(dto, `공개 응답에 ${key} 가 있다`).not.toHaveProperty(key);
        }

        const json = JSON.stringify(dto);
        expect(json).not.toContain(owner.profileId);
        expect(json).not.toContain(owner.userId);
      },
    );

    it(
      "가격을 숨긴 상품의 금액은 공개 응답에 들어오지 않는다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const offer = await catalog.createOffer(owner.ctx, {
          title: "가격 비공개 상품",
          priceDisplayPolicy: "shown",
          priceAmount: 1_234_567,
          priceCurrency: "KRW",
        });
        await catalog.setOfferStatus(owner.ctx, offer.id, "active");
        expect((await catalog.publicOffers(owner.slug))[0]?.priceAmount).toBe(1_234_567);

        // 정책을 '문의'로 바꾸면 저장 단계에서 금액이 지워지고, 뷰가 한 번 더 가린다(두 겹).
        await catalog.updateOffer(owner.ctx, offer.id, { title: offer.title, priceDisplayPolicy: "inquiry" });
        const after = (await catalog.publicOffers(owner.slug))[0];
        expect(after?.priceDisplayPolicy).toBe("inquiry");
        expect(after?.priceAmount).toBeNull();
        expect(after?.priceCurrency).toBeNull();
        expect(JSON.stringify(after)).not.toContain("1234567");
      },
    );
  });

  describe("P-091: 가격을 표시하겠다면 금액과 통화가 있어야 한다", () => {
    it(
      "모듈을 우회한 INSERT 는 offer_shown_price_complete CHECK 가 거부한다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();

        // 금액·통화 둘 다 없는 'shown'
        await expect(
          q(
            `INSERT INTO offers (owner_type, owner_id, profile_id, title, price_display_policy, status)
             VALUES ('profile',$1,$1,'금액 없는 표시 상품','shown','draft')`,
            [owner.profileId],
          ),
        ).rejects.toThrow(/offer_shown_price_complete/);

        // 금액만 있고 통화가 없는 경우도 같다 — "150000" 이 원인지 달러인지 모르는 표시는 표시가 아니다.
        await expect(
          q(
            `INSERT INTO offers (owner_type, owner_id, profile_id, title, price_display_policy, price_amount, status)
             VALUES ('profile',$1,$1,'통화 없는 표시 상품','shown',150000,'draft')`,
            [owner.profileId],
          ),
        ).rejects.toThrow(/offer_shown_price_complete/);

        // 통화만 있고 금액이 없는 경우도 같다.
        await expect(
          q(
            `INSERT INTO offers (owner_type, owner_id, profile_id, title, price_display_policy, price_currency, status)
             VALUES ('profile',$1,$1,'금액 없는 통화 상품','shown','KRW','draft')`,
            [owner.profileId],
          ),
        ).rejects.toThrow(/offer_shown_price_complete/);

        // 'inquiry' 는 금액 없이도 저장된다 (제약은 'shown' 에만 걸린다).
        const inquiry = await one<{ id: string }>(
          `INSERT INTO offers (owner_type, owner_id, profile_id, title, price_display_policy, status)
           VALUES ('profile',$1,$1,'문의형 상품','inquiry','draft')
           RETURNING id::text AS id`,
          [owner.profileId],
        );
        expect(inquiry?.id).toBeTruthy();

        // 'hidden' 도 마찬가지다.
        const hidden = await one<{ id: string }>(
          `INSERT INTO offers (owner_type, owner_id, profile_id, title, price_display_policy, status)
           VALUES ('profile',$1,$1,'가격 숨김 상품','hidden','draft')
           RETURNING id::text AS id`,
          [owner.profileId],
        );
        expect(hidden?.id).toBeTruthy();
      },
    );

    it(
      "모듈 경로는 같은 판정을 입력 오류로 돌려준다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();

        await rejectedWith(
          catalog.createOffer(owner.ctx, { title: "가격 표시 상품", priceDisplayPolicy: "shown" }),
          "price_incomplete",
          400,
        );
        await rejectedWith(
          catalog.createOffer(owner.ctx, {
            title: "통화 없는 가격 표시",
            priceDisplayPolicy: "shown",
            priceAmount: 150_000,
          }),
          "price_incomplete",
          400,
        );
        await rejectedWith(
          catalog.createOffer(owner.ctx, {
            title: "통화 형식이 틀린 상품",
            priceDisplayPolicy: "shown",
            priceAmount: 150_000,
            priceCurrency: "원",
          }),
          "price_incomplete",
          400,
        );

        const ok = await catalog.createOffer(owner.ctx, {
          title: "현장 실측 포함 상담",
          priceDisplayPolicy: "shown",
          priceAmount: 150_000,
          priceCurrency: "krw",
        });
        expect(ok.priceAmount).toBe(150_000);
        // ISO 4217 은 대문자 3자다. 저장 전에 접어 두지 않으면 같은 통화가 두 모양으로 쌓인다.
        expect(ok.priceCurrency).toBe("KRW");

        // 문의형은 금액 없이 통과한다.
        const inquiry = await catalog.createOffer(owner.ctx, { title: "견적 문의 상품" });
        expect(inquiry.priceDisplayPolicy).toBe("inquiry");
        expect(inquiry.priceAmount).toBeNull();
      },
    );
  });

  describe("P-141 / N-2: 요금제 한도는 노출 공간만 막는다 — 배지에는 닿지 않는다", () => {
    it(
      "free 한도를 넘으면 createOffer 가 거부되고, 같은 사용자의 배지는 그대로다",
      { timeout: 30_000 },
      async () => {
        const reviewerCtx = ctxFor(await newUser("reviewer"));
        const owner = await newPublishedProfile();

        // 배지는 **정책 경로로만** 만든다(증거 → 검증 → 배지). 직접 INSERT 로 만들면
        // 이 테스트가 "한도가 배지를 건드리지 않는다"가 아니라 "내가 심은 행이 그대로다"를 증명한다.
        const submitted = await proof.submitEvidence(owner.ctx, {
          evidenceType: "career",
          sourceType: "user",
          scope: "2015-03 ~ 재직 중",
        });
        await proof.transition(reviewerCtx, submitted.evidenceId, "under_review");
        const verified = await proof.transition(reviewerCtx, submitted.evidenceId, "verified", {
          method: "document_reviewed",
          scope: "2015-03 ~ 재직 중",
        });
        expect(verified.badgeId).toBeTruthy();

        const badgesBefore = await proof.listBadges(owner.profileId);
        expect(badgesBefore).toHaveLength(1);

        // 한도 값은 코드 상수가 아니라 `plans.limits` 레코드에서 온다 (P-140). 테스트도 레코드를 묻는다.
        const plan = await billing.planLimitsFor(owner.ctx);
        expect(plan.planCode).toBe("free");
        expect(plan.limits.offers).toBeGreaterThan(0);

        for (let i = 0; i < plan.limits.offers; i++) {
          await catalog.createOffer(owner.ctx, { title: `한도 안 상품 ${i + 1}` });
        }
        await rejectedWith(
          catalog.createOffer(owner.ctx, { title: "한도를 넘는 상품" }),
          "plan_limit",
          409,
        );

        // N-2 의 핵심: 요금제가 막은 것은 상품 카드 개수뿐이다. 신뢰 자산은 영향을 받지 않는다.
        expect(await proof.listBadges(owner.profileId)).toEqual(badgesBefore);

        // 보관(archived)은 공개되지 않으므로 한도에서 빠진다 → 자리를 비우면 다시 만들 수 있다.
        const mine = await catalog.listMyOffers(owner.ctx);
        const first = mine[0];
        expect(first).toBeDefined();
        if (first) await catalog.setOfferStatus(owner.ctx, first.id, "archived");
        const afterArchive = await catalog.createOffer(owner.ctx, { title: "자리를 비운 뒤의 상품" });
        expect(afterArchive.id).toBeTruthy();
        expect(await proof.listBadges(owner.profileId)).toEqual(badgesBefore);
      },
    );
  });
});
