/**
 * P-001/P-002 매직링크 소비 화면 — `identity.LOGIN_LINK_PATH` ( `/login/verify` ).
 *
 * 토큰을 **서버 컴포넌트에서 읽지 않는다.** searchParams 로 읽어 prop 으로 내리면 토큰이 RSC
 * 페이로드에 실려 나가고, 주소창에서 지우기 전에 이미 복사본이 하나 더 생긴다. 토큰은
 * 클라이언트가 `window.location` 에서 읽고 **즉시** `history.replaceState` 로 주소창에서 지운다
 * (Referer·북마크·공유 유출 방지).
 *
 * 왜 이 화면이 필요한가: `/api/v1/auth/callback` 에는 GET 이 없다(라우트 주석). 메일 스캐너·
 * 링크 프리뷰가 GET 으로 먼저 열면 1회성 토큰이 타고, 그 스캐너에게 유효한 세션이 발급된다.
 * 그래서 소비는 사용자 브라우저의 POST 로만 일어난다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { VerifyClient } from "./VerifyClient";

/**
 * N-9: 정적 프리렌더를 쓰지 않는다 — 이 저장소의 모든 화면이 그렇다. 근거는 app/page.tsx 주석.
 * 불변식은 `scripts/check-no-prerender.mjs` 가 지킨다.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "로그인 확인",
  robots: { index: false, follow: false },
};

export default function VerifyPage() {
  return (
    <div>
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <Link href="/" className="display text-[22px] tracking-tight">
          PROPLUS
        </Link>
      </header>

      <main id="main" className="mx-auto max-w-xl px-5 pb-20 pt-10 sm:px-8 sm:pt-20">
        <VerifyClient />
      </main>
    </div>
  );
}
