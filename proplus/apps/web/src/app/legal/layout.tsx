/**
 * 법적 고지 화면의 공통 틀.
 *
 * 왜 이 화면들이 필요한가: 상담 동의 폼(`/p/[slug]/contact`)과 로그인 화면이 이 주소를
 * **직접 링크한다.** 그 링크가 404 면 "무엇에 동의하는지 확인할 수 있다" 가 거짓이 되고,
 * 그건 N-11(동의 분리 기록)이 지키려는 것의 전제를 무너뜨린다 — 분리해서 받아 봐야
 * 내용을 볼 수 없으면 의미가 없다.
 *
 * ⚠️ 여기 적힌 것은 **법률 의견서가 아니다.** 출처 문서(04_보안_개인정보_신뢰정책.md §5)가
 * "출시 국가·서비스 역할·데이터 흐름·결제 구조가 확정된 후 전문 변호사 검토가 필요하다" 고
 * 명시한다. 그래서 이 화면은 약속을 지어내지 않고 **지금 코드가 실제로 하는 일만** 적는다.
 */

import Link from "next/link";

export const dynamic = "force-dynamic";

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
        <Link href="/" className="display text-[19px] tracking-tight">PROPLUS</Link>
        <Link href="/" className="btn btn-ghost !min-h-10 text-[13.5px]">홈으로</Link>
      </header>
      <main id="main" className="mx-auto max-w-3xl px-5 pb-20 pt-2 sm:px-8">
        {children}
      </main>
    </div>
  );
}
