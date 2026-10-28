// P-086: 조직 단건 조회. 멤버만 읽을 수 있고, 멤버가 아니면 모듈이 404 를 준다(존재 여부를 흘리지 않는다).
//
// `id` 를 라우트에서 uuid 로 검증하는 이유: 잘못된 형식은 Postgres 까지 내려갈 필요가 없고,
// 입력 검증은 라우트의 책임이다 (전략 §3).

import { org } from "@proplus/api";
import { z } from "zod";
import { route } from "@/lib/server";

const orgId = z.uuid();

export const GET = route<{ id: string }>(async ({ ctx, params }) =>
  org.getOrganization(ctx, orgId.parse(params.id)),
);
