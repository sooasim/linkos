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
 * **요청마다 만든다.** ISR 캐시(`revalidate`)를 쓰지 않는 이유는 배포에서 직접 확인했다:
 *
 * 빌드 시점에는 DB 에 데이터가 없다(마이그레이션·시드는 빌드 **뒤에** 돈다). 그런데 `revalidate`
 * 를 두면 Next 가 빌드 때 한 번 생성해 캐시하므로, 배포 직후 사이트맵이 **랜딩 한 줄짜리**로
 * 굳고 첫 재검증 시각까지 그대로 있다. 실제로 그렇게 나왔다.
 *
 * 비용도 걱정만큼 크지 않다: `publishedSlugs()` 는 공개 뷰에서 slug 와 발행일만 읽고,
 * 사이트맵은 검색엔진이 가끔 가져가는 경로라 사용자 요청 경로(P-194)와 무관하다.
 */
export const dynamic = "force-dynamic";

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
