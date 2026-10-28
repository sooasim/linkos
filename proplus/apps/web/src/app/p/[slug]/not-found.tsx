/**
 * P-027 비발행 프로필은 404 · P-030 미발행 프로필은 noindex.
 *
 * "있지만 비공개"와 "없음"을 구분해 말하지 않는다. 구분해 주면 비공개로 바꾼 사실 자체가
 * 외부에서 관측 가능해지고(주소를 넣어 보면 알 수 있다), 그건 공개 설정을 되돌린 사람의
 * 의도와 반대다. 그래서 문구는 두 경우를 함께 덮는다.
 *
 * `<meta robots>` 를 컴포넌트에서 직접 그리는 이유: not-found 경계는 메타데이터 export 로
 * 색인 금지를 보장하기 어렵다(페이지의 `generateMetadata` 가 이미 noindex 를 돌려주지만,
 * 이 화면은 그 밖의 경로로도 렌더될 수 있다). React 19 가 `<meta>` 를 head 로 올려 준다.
 */

import Link from "next/link";

export default function PublicProfileNotFound() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-5 py-16 sm:px-8">
      <meta name="robots" content="noindex, nofollow" />

      <p className="eyebrow">404</p>
      <h1 className="display mt-4 text-[32px] sm:text-[44px]">이 주소의 공개 프로필을 찾을 수 없습니다</h1>
      <p className="lede mt-5">
        주소가 바뀌었거나, 지금은 공개되지 않은 프로필입니다. 주소를 다시 확인해 주세요.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link href="/search" className="btn btn-primary btn-lg">
          전문가 찾기
        </Link>
        <Link href="/" className="btn btn-ghost btn-lg">
          PROPLUS 소개
        </Link>
      </div>
    </div>
  );
}
