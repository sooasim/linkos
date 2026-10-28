// P-080: 조직 생성 / 내 소속 목록 (데이터모델 §4 Organization — `POST /organizations`).
//
// 라우트는 얇은 어댑터다 (전략 §3): zod 검증 → 모듈 호출 → 직렬화. 권한·SQL·분기는 `org` 모듈이 한다.
// 생성이 201 인 이유는 응답이 새 리소스(조직)를 가리키기 때문이다.

import { org } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const createInput = z.strictObject({
  name: z.string().min(1).max(200),
  // 생략하면 모듈이 이름에서 만든다. 길이 상한은 slug 규칙(≤40)보다 넉넉히 두고 판정은 도메인에 맡긴다 —
  // 여기서 규칙을 복제하면 `validateSlug` 와 둘로 갈린다.
  slug: z.string().max(80).nullish(),
  // 사업자번호 **원문이 아니라** 외부 참조 키다 (데이터모델 §1).
  legalIdentifierRef: z.string().max(200).nullish(),
});

export const POST = route(async ({ ctx, body }) => org.createOrganization(ctx, parse(createInput, body)), {
  status: 201,
});

export const GET = route(async ({ ctx }) => ({ organizations: await org.myOrganizations(ctx) }));
