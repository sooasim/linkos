/**
 * `GET`·`PATCH /api/v1/me/integration` — LINKOS 연동 설정 (프로필 소유자 본인).
 * 근거: `docs/05_LINKOS_INTEGRATION.md` §2·§3 / 0003 마이그레이션 ③.
 *
 * 설정 두 개는 **둘 다 기본 꺼짐**이고, 켜는 사람은 프로필 소유자뿐이다:
 *   `linkosSync`           상담 리드를 LINKOS 연락처로 전달한다 (§2)
 *   `allowDirectoryLookup` 이메일 해시로 내 배지를 조회당할 수 있게 허용한다 (§3 의 첫 번째 겹)
 *
 * 왜 `/me/profile` 의 `publicSettings` 와 **따로** 두는가: 이 둘은 외부로 데이터가 나가는
 * 스위치라서 "프로필 저장"에 묻혀 켜지면 안 된다. 켤 때 무엇이 나가는지 화면이 따로 설명해야 하고,
 * 그 화면은 따로 호출할 엔드포인트가 필요하다. (저장 위치는 같은 `profiles.public_settings` 다 —
 * 0003 이 컬럼을 추가하지 않은 이유는 그 파일의 ③ 주석에 있다.)
 *
 * 로그인 필수다(`route()` 기본값). 남의 설정을 바꾸는 경로는 아예 없다 — 모듈이 `ctx.userId` 의
 * 프로필만 본다(N-12: 조직도 개인 프로필을 소유하지 않는다).
 */

import { integration } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

/**
 * 두 키 모두 선택적이다 — 한 스위치만 토글하는 호출이 다른 스위치를 끄지 않아야 한다.
 * `null`·문자열을 받지 않는다: 켜짐/꺼짐 외의 상태가 없는 설정이고, `"false"` 같은 값이
 * 참으로 읽히는 사고가 이런 스위치에서 가장 흔하다.
 */
const Patch = z.object({
  linkosSync: z.boolean().optional(),
  allowDirectoryLookup: z.boolean().optional(),
});

export const GET = route(async ({ ctx }) => ({ integration: await integration.integrationSettings(ctx) }));

/**
 * 저장 뒤 **읽은 값**을 돌려준다 — 요청 본문을 되돌려주지 않는다.
 *
 * 모듈이 "들어온 키만 머지"하고 프로필이 없으면 아무것도 바꾸지 않으므로, 요청을 그대로 비추면
 * 화면의 스위치가 **실제로 저장되지 않은 상태를 켜진 것으로** 그릴 수 있다. 서버가 지금 무엇을
 * 들고 있는지가 유일한 진실이다.
 */
export const PATCH = route(async ({ ctx, body }) => {
  await integration.setIntegrationSettings(ctx, parse(Patch, body));
  return { integration: await integration.integrationSettings(ctx) };
});
