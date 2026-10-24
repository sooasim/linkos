/**
 * P-031 sitemap — **발행된 프로필만** 들어갈 수 있다.
 *
 * 목록은 `profile.publishedSlugs()` 가 돌려준다. 그 함수는 `public_profile_view` 만 읽으므로
 * 미발행·정지·삭제 계정은 뷰가 이미 걸러냈다 — 공개 기준이 **뷰 한 곳에만** 있다는 것이 핵심이다.
 * 이 파일이 `published_at IS NOT NULL` 같은 조건을 직접 쓰면 공개 기준이 두 벌이 되고,
 * 그 둘이 어긋나는 순간 비공개 프로필 주소가 사이트맵으로 새어 나간다 (전략 §3 계층 규칙).
 *
 * `search.searchProfiles()` 를 쓰지 않는 이유: 그것은 랭킹·`placement`·`dropped` 가 붙은 검색
 * 응답이고(N-15), 근거를 만들 수 없는 행은 빠진다. 사이트맵에 쓰면 "색인 대상이 검색 랭킹에 따라
 * 달라지는" 결과가 된다.
 */

import { profile } from "@proplus/api";
import type { MetadataRoute } from "next";

/** robots.ts 와 같은 기준. 왜 공유하지 않는지는 그 파일의 주석에 있다. */
const APP_ORIGIN = (process.env.APP_ORIGIN ?? "http://localhost:4400").replace(/\/+$/, "");

/**
 * 프로필이 발행·비발행될 때마다 사이트맵이 바뀐다. 매 요청 전수 조회는 비싸고(P-194),
 * 검색엔진은 몇 시간 단위로 읽으므로 1시간 캐시가 적절하다.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const entries: MetadataRoute.Sitemap = [
    { url: `${APP_ORIGIN}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
  ];

  /**
   * DB 가 없거나 느릴 때 사이트맵 요청이 500 이 되면 안 된다 — 그건 "색인하지 말라" 로 읽히고,
   * 랜딩 한 줄이라도 내보내는 쪽이 낫다. 그래서 실패를 삼키고 정적 경로만 돌려준다.
   */
  try {
    const published = await profile.publishedSlugs();
    for (const p of published) {
      entries.push({
        url: `${APP_ORIGIN}/p/${p.slug}`,
        lastModified: p.updatedAt ? new Date(p.updatedAt) : now,
        changeFrequency: "weekly",
        priority: 0.8,
      });
    }
  } catch {
    // 조용히 넘어간다. 운영 관측은 앱 로그가 담당한다.
  }

  return entries;
}
