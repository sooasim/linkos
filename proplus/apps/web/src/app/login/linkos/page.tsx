/**
 * LINKOS 복귀 화면 — `linkosSso.LINKOS_SSO_CALLBACK_PATH` ( `/login/linkos` ).
 *
 * **이 서버 컴포넌트는 `searchParams` 를 읽지 않는다.** 읽어서 prop 으로 내리면 assertion 이 RSC
 * 페이로드에 실려 나가고(= 토큰 사본이 하나 더 생긴다), 주소창을 지우기 전에 이미 새어 있다.
 * 토큰은 클라이언트가 `window.location` 에서 읽고 **즉시** `history.replaceState` 로 지운다
 * (`/login/verify` 가 같은 패턴이다 — 그 파일 주석이 근거다).
 *
 * N-9: 정적 프리렌더를 쓰지 않는다. 불변식은 `scripts/check-no-prerender.mjs` 가 지킨다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { LinkosCallback } from "./LinkosCallback";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "LINKOS 계정으로 로그인",
  // 로그인·검증 화면은 색인될 이유가 없다. 공개 대상은 /p/[slug] 뿐이다 (P-030).
  robots: { index: false, follow: false },
};

export default function LinkosLoginPage() {
  return (
    <div>
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <Link href="/" className="display text-[22px] tracking-tight">
          PROPLUS
        </Link>
      </header>

      <main id="main" className="mx-auto max-w-xl px-5 pb-20 pt-10 sm:px-8 sm:pt-20">
        <LinkosCallback />
      </main>
    </div>
  );
}
