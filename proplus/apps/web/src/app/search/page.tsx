/**
 * P-150 전문가 검색 · P-151 검증 상태 필터 · P-152 유료 노출 구분 · P-153 랭킹 근거 공개
 *
 * 랜딩의 두 번째 CTA("검증된 전문가 찾기")가 여기로 온다.
 *
 * ## 이 화면이 지키는 것 (N-15 / 모듈명세 M11 수용기준)
 *
 * "광고/유료 노출은 일반 검색결과와 구분하고 **랭킹 근거를 공개한다**."
 *
 * 그래서 결과마다 `rankingBasis` 를 **숨기지 않고 그대로 그린다.** 보통 이런 정보는 접어 두지만,
 * 접는 순간 "근거가 있다" 와 "근거를 보여준다" 가 갈라지고 M11 이 요구하는 것은 후자다.
 * `promoted` 는 별도 영역에 "유료 노출" 라벨과 함께 그린다 — 일반 결과 배열에 섞지 않는다.
 *
 * ## N-3: 점수가 없다
 *
 * 정렬은 모듈이 정하고(`basis.sort`) 화면은 순위 숫자·별점·"매칭률 92%" 같은 것을 만들지 않는다.
 * 배지는 **보유 여부**만 보여준다 — 개수를 세어 강조하면 그게 곧 점수가 된다.
 */

import { ApiError, search as searchApi } from "@proplus/api";
import Link from "next/link";
import type { Metadata } from "next";

// N-9: 검색 결과에는 배지 보유 여부가 들어간다. 회수된 배지가 캐시된 페이지에 남으면 안 된다.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "전문가 찾기 — PROPLUS",
  description: "전문분야·지역·확인된 항목으로 전문가를 찾습니다. 각 결과에 무엇을 근거로 나왔는지 함께 표시합니다.",
};

/** 근거 코드 → 사람이 읽는 말. 코드를 그대로 보여주면 "공개"가 아니다. */
const BASIS_KO: Readonly<Record<string, string>> = {
  specialty_match: "전문분야 일치",
  region_match: "지역 일치",
  badge_present: "확인된 항목 있음",
  recently_active: "최근 활동",
  promoted_placement: "유료 노출",
};

const BADGE_KO: Readonly<Record<string, string>> = {
  identity: "본인 확인",
  affiliation: "소속 확인",
  license: "자격 확인",
  career: "경력 확인",
  product_training: "제품 교육",
  transaction_count: "거래 데이터",
  response_time: "응답 시간",
  aftercare: "사후관리",
};

function first(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return typeof raw === "string" ? raw : "";
}

type Result = Awaited<ReturnType<typeof searchApi.searchProfiles>>["results"][number];

function ResultCard({ r, promoted }: { r: Result; promoted: boolean }) {
  return (
    <li className="card p-5" data-testid={promoted ? "search-result-promoted" : "search-result"}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={`/p/${r.slug}`} className="text-[17px] font-semibold text-[var(--accent-text)] hover:underline">
          {r.displayName}
        </Link>
        {promoted ? (
          // P-152: 유료 노출은 **라벨로** 구분한다. 배치만 다르게 하면 사용자는 알 수 없다.
          <span className="chip !border-[var(--caution)] !text-[var(--caution)] !text-[12px]" data-testid="promoted-label">
            유료 노출
          </span>
        ) : null}
      </div>

      {r.headline ? <p className="mt-1.5 text-[14px] text-[var(--fg-mute)]">{r.headline}</p> : null}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {r.specialties.slice(0, 4).map((s) => (
          <span key={s} className="chip !text-[12px]">{s}</span>
        ))}
        {r.region ? <span className="chip !text-[12px]">{r.region}</span> : null}
      </div>

      {/* 배지는 **보유 여부**만. 개수를 강조하지 않는다 (N-3). */}
      {r.badgeTypes.length > 0 ? (
        <p className="mt-3 text-[13px] text-[var(--verified)]" data-testid="result-badges">
          확인된 항목: {r.badgeTypes.map((b) => BADGE_KO[b] ?? b).join(" · ")}
        </p>
      ) : (
        <p className="mt-3 text-[13px] text-[var(--fg-mute)]">확인된 항목 없음</p>
      )}

      {/* P-153: 근거를 접지 않고 그대로 보여준다. */}
      <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]" data-testid="ranking-basis">
        이 결과가 나온 근거: {r.rankingBasis.map((c) => BASIS_KO[c] ?? c).join(" · ")}
      </p>
    </li>
  );
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = first(sp.q).trim();
  const region = first(sp.region).trim();
  const verifiedOnly = first(sp.verified) === "1";
  const hasQuery = q.length > 0 || region.length > 0 || verifiedOnly;

  let data: Awaited<ReturnType<typeof searchApi.searchProfiles>> | null = null;
  let error: string | null = null;

  if (hasQuery) {
    try {
      data = await searchApi.searchProfiles({
        q: q || null,
        region: region || null,
        verifiedOnly,
        limit: 20,
      });
    } catch (e) {
      // 모듈은 조건 없는 전수 조회를 거부한다(디렉터리 덤프 방지, N-15). 그 메시지를 그대로 보여준다.
      error = e instanceof ApiError ? e.message : "검색 중 문제가 발생했습니다.";
    }
  }

  return (
    <div>
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
        <Link href="/" className="display text-[19px] tracking-tight">PROPLUS</Link>
        <Link href="/login" className="btn btn-ghost !min-h-10 text-[13.5px]">로그인</Link>
      </header>

      <main id="main" className="mx-auto max-w-3xl px-5 pb-20 pt-2 sm:px-8">
        <p className="eyebrow">전문가 찾기</p>
        <h1 className="display mt-3 text-[30px] sm:text-[38px]">믿고 거래할 사람 찾기</h1>
        <p className="mt-3 max-w-[62ch] text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
          각 결과에 <b>무엇을 근거로 나왔는지</b> 함께 표시합니다. 유료 노출은 일반 결과와 분리해 보여줍니다.
        </p>

        {/* GET 폼이라 결과 주소를 공유할 수 있다. CSP form-action 'self' 안에서 동작한다. */}
        <form method="get" action="/search" className="card mt-7 grid gap-3 p-5" data-testid="search-form">
          <label className="grid gap-1.5">
            <span className="text-[13px] font-medium">검색어</span>
            <input
              name="q"
              defaultValue={q}
              placeholder="이름 · 전문분야 (예: 의료기기)"
              className="field"
              data-testid="search-q"
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-[13px] font-medium">지역 (선택)</span>
            <input name="region" defaultValue={region} placeholder="예: 서울" className="field" data-testid="search-region" />
          </label>
          <label className="flex items-center gap-2.5">
            <input type="checkbox" name="verified" value="1" defaultChecked={verifiedOnly} data-testid="search-verified" />
            {/* P-151 / N-3: 보유 여부 필터일 뿐 점수 정렬이 아니라는 것을 문구로 못 박는다. */}
            <span className="text-[13.5px]">확인된 항목이 있는 프로필만 보기</span>
          </label>
          <button type="submit" className="btn btn-primary" data-testid="search-submit">찾기</button>
        </form>

        {error ? (
          <p className="panel mt-6 p-4 text-[14px] text-[var(--caution)]" data-testid="search-error">{error}</p>
        ) : null}

        {!hasQuery && !error ? (
          <p className="mt-6 text-[14px] text-[var(--fg-mute)]">
            검색어나 지역을 입력하거나 “확인된 항목” 필터를 켜면 결과를 보여줍니다.
            조건 없이 전체를 나열하지 않습니다 — 그런 목록에는 근거를 붙일 수 없기 때문입니다.
          </p>
        ) : null}

        {data ? (
          <section className="mt-8" aria-labelledby="results">
            <h2 id="results" className="text-[15px] font-semibold">
              결과 {data.results.length}건
            </h2>

            {/* P-152: 유료 노출 영역을 **먼저, 그러나 분리해서** 그린다. 지금은 항상 비어 있다. */}
            {data.promoted.length > 0 ? (
              <div className="mt-4">
                <p className="text-[12.5px] font-medium text-[var(--caution)]">유료 노출 — 검색 순위와 무관합니다</p>
                <ul className="mt-2 grid gap-3">
                  {data.promoted.map((r) => <ResultCard key={r.profileId} r={r} promoted />)}
                </ul>
              </div>
            ) : null}

            {data.results.length > 0 ? (
              <ul className="mt-4 grid gap-3">
                {data.results.map((r) => <ResultCard key={r.profileId} r={r} promoted={false} />)}
              </ul>
            ) : (
              <p className="mt-4 text-[14px] text-[var(--fg-mute)]">조건에 맞는 프로필이 없습니다.</p>
            )}

            {/* 투명성: 무엇이 순서를 정했고 몇 건이 왜 빠졌는지 적는다 (M11 수용기준). */}
            <p className="mt-6 text-[12.5px] leading-relaxed text-[var(--fg-mute)]" data-testid="search-basis">
              정렬 기준: {data.basis.sort} · 검색 엔진: {data.basis.engine}
              {data.dropped > 0 ? ` · 근거를 만들 수 없어 제외된 결과 ${data.dropped}건` : ""}
            </p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
