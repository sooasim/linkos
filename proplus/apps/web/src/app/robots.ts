/**
 * P-031 robots.
 *
 * 공개해도 되는 것만 열고 나머지는 전부 닫는다. 색인에서 닫는 것이 접근 통제는 아니지만
 * (권한은 서버가 본다 — 전략 §3), 워크스페이스·검증 콘솔·API 응답이 검색 결과에 남으면
 * 비공개로 바꾼 뒤에도 캐시된 조각이 떠돌게 된다.
 *
 * 개별 프로필의 색인 여부는 여기서 정하지 않는다 — `/p/[slug]` 의 `generateMetadata` 가
 * 발행 상태를 보고 `robots: { index: false }` 를 내려보낸다(P-030). 미발행 프로필 주소를
 * 이 파일에 적어 두는 방식이면 **파일 자체가 비공개 주소 목록**이 되어 버린다.
 */

import type { MetadataRoute } from "next";

/**
 * layout.tsx 의 `metadataBase` 와 같은 기준을 쓴다 — 두 값이 어긋나면 sitemap 호스트가 틀어진다.
 * sitemap.ts 가 같은 상수를 따로 들고 있는 것은 중복이 아니라 제약이다: 메타데이터 라우트 파일은
 * 규정된 export 만 둬야 하므로(Next 가 export 를 검사한다) 여기서 꺼내 쓰게 만들 수 없다.
 */
const APP_ORIGIN = (process.env.APP_ORIGIN ?? "http://localhost:4400").replace(/\/+$/, "");

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/", // JSON 응답은 색인 대상이 아니다. 공개 데이터라도 HTML 페이지가 정본이다.
          "/app/", // 워크스페이스 (로그인 필요)
          "/admin/", // 검증 콘솔 (운영자 전용)
          "/login",
          "/p/*/contact", // 개인정보를 입력하는 폼 화면 (페이지 메타데이터도 noindex 다)
        ],
      },
    ],
    sitemap: `${APP_ORIGIN}/sitemap.xml`,
    host: APP_ORIGIN,
  };
}
