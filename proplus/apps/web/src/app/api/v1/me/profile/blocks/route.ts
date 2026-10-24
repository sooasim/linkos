/**
 * P-040/P-043 미니사이트 블록 — `GET`·`PUT /api/v1/me/profile/blocks`.
 *
 * `PUT`(전체 교체)인 이유: 순서는 블록들 **사이의** 관계이고, 한 블록만 바꾸는 PATCH 로는
 * position 충돌 없이 1↔2 교환을 표현할 수 없다. 모듈도 삭제-재삽입으로 처리한다.
 *
 * 블록 내용을 zod 로 다시 적지 않는다 (N-10). 허용 kind·허용 props 키·sanitize 는
 * `domain/blockSchema.validateBlocks()` 가 유일한 판정자이고, 여기에 schema 사본을 두면
 * 두 화이트리스트가 생겨 한쪽이 느슨해지는 순간 N-10 이 조용히 무너진다.
 * 그래서 라우트는 "blocks 라는 키가 있다"까지만 보고 값은 그대로 넘긴다.
 */

import { profile } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Body = z.object({ blocks: z.unknown() });

export const GET = route(async ({ ctx }) => ({ blocks: await profile.getBlocks(ctx) }));

export const PUT = route(async ({ ctx, body }) => {
  const { blocks } = parse(Body, body);
  return { blocks: await profile.setBlocks(ctx, blocks) };
});
