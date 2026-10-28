/**
 * P-025/P-026 공개 프로필 — `GET /api/v1/public/profiles/{slug}` (인증 없음).
 *
 * **개인화 분기가 없다.** 같은 slug 는 누가 불러도 같은 응답이고, 로그인 사용자에게 더 많은 필드를
 * 주는 경로도 없다 (기술백서 §6). 이유는 캐시 안전성이다: 응답이 보는 사람에 따라 달라지면
 * 공유 캐시(CDN·프록시)에 한 사람의 비공개 데이터가 들어가 다른 사람에게 나갈 수 있다.
 * 소유자용 데이터는 `GET /me/profile` 이 따로 있다.
 *
 * 모듈은 공개 뷰 네 개만 읽고 allowlist 로 응답을 **재구성**한다(N-4) — 라우트는 필드를 더하지 않는다.
 * 만료·취소 배지는 뷰가 읽기 시점에 걸러낸다(N-9).
 */

import { profile } from "@proplus/api";
import { route } from "@/lib/server";

/**
 * P-194 공개 프로필 성능 — 60초 재검증.
 *
 * 다만 `route()` 가 세션 쿠키를 읽으므로 이 핸들러는 실제로는 동적으로 평가된다
 * (Next 는 request 객체를 쓰는 GET 핸들러를 캐시하지 않는다). 그래서 이 선언은 지금 성능을
 * 바꾸지 않고 **상한을 명시하는 의도 표시**다 — N-9 가 60초를 넘는 캐시를 허용하지 않기 때문에
 * 나중에 캐시 계층(CDN·`fetch` 재검증)을 붙이는 쪽이 이 값보다 긴 TTL 을 고르지 못하게 한다.
 * 실제 브라우저 캐시는 next.config 의 `/api/:path*` → `no-store` 가 막고 있다.
 */
export const revalidate = 60;

export const GET = route<{ slug: string }>(
  // `now` 를 넘기지 않는다 — 모듈 기본값(현재 시각)이 만료 판정 기준이고, 호출자가 기준 시각을
  // 고를 수 있으면 "만료 전 시점"을 넣어 회수된 배지를 되살릴 수 있다 (N-9).
  // P-189: 비회원 경로이므로 한도의 유일한 재료가 IP 다. 모듈이 버킷을 정한다(라우트는 정책을 계산하지 않는다).
  async ({ params, ctx }) => profile.getPublicProfile(params.slug, new Date(), { ip: ctx.ip }),
  { auth: false },
);
