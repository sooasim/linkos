/**
 * P-028 버전 목록·복원 — `GET`·`POST /api/v1/me/profile/versions`.
 *
 * 복원을 `POST`(복원 요청)로 두고 `PUT /versions/{n}` 같은 모양을 쓰지 않는 이유:
 * 복원은 과거 버전을 **덮어쓰지 않고 새 버전을 하나 더 만든다**(모듈 주석). 즉 특정 버전 리소스를
 * 수정하는 것이 아니라 컬렉션에 항목이 추가되는 동작이다.
 *
 * 목록에 스냅샷 본문이 없는 것도 의도다 — 버전 N개의 본문을 한 응답에 싣지 않는다.
 */

import { profile } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Restore = z.object({
  // 상한을 둔다: 버전은 저장 횟수만큼 증가하므로 현실적인 범위를 넘는 값은 조회 전에 거른다.
  version: z.number().int().min(1).max(1_000_000),
});

export const GET = route(async ({ ctx }) => ({ versions: await profile.listVersions(ctx) }));

export const POST = route(async ({ ctx, body }) => {
  const { version } = parse(Restore, body);
  return { profile: await profile.restoreVersion(ctx, version) };
});
