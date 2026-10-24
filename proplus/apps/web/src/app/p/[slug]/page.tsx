/**
 * P-025 공개 프로필 `/p/{slug}` (SSR, 인증 없음) · P-027 비발행 404 · P-030 SEO·OG · P-036 상담 CTA.
 *
 * M02 수용기준: "모바일에서 핵심 소개·검증 상태·상담 CTA 가 첫 화면에 표시된다."
 * 그래서 히어로 순서가 이름 → 소개 한 줄 → 상담 CTA → 확인된 항목으로 고정되어 있고,
 * 상담 CTA 는 한 손 엄지 영역(하단 고정 바)에 **한 번 더** 둔다. 둘 다 같은 주소로 간다.
 *
 * ## 왜 `getViewer()` 를 부르지 않는가
 *
 * 공개 프로필에는 **개인화 분기가 없다** — 같은 slug 는 누가 열어도 같은 화면이다
 * (`app/api/v1/public/profiles/[slug]/route.ts` 주석과 같은 이유: 응답이 보는 사람에 따라 달라지면
 * 공유 캐시에 한 사람의 데이터가 들어가 다른 사람에게 나갈 수 있다).
 * 세션을 읽으면 비회원 방문에도 세션 조회가 붙어 P-194(LCP p75 < 2.5s)만 나빠지고 얻는 것이 없다.
 *
 * ## 왜 `force-dynamic` 인가
 *
 * N-9(보안정책 §4.5): 취소·만료된 배지는 **읽는 순간** 사라져야 한다. 이 라우트가 Next 의
 * full route cache 에 들어가면 회수된 배지가 남아 보이는 창이 생기고, 읽기 시점 만료 판정
 * (`public_badge_view`)이 무의미해진다. next.config 가 `/p/:path*` 에 `Cache-Control: no-store` 를
 * 붙여 둔 것과 같은 결정이다.
 *
 * ## 데이터
 *
 * `profile.getPublicProfile()` 한 번으로 받는다. 자기 API 를 fetch 하지 않는다(같은 프로세스다).
 * 모듈이 공개 뷰 네 개를 allowlist 로 재조립해 주므로(N-4) 이 파일에는 SQL 도, 권한 판단도 없다
 * (전략 §3 계층 규칙: UI 는 서버가 걸러 준 것만 그린다).
 */

import { ApiError, profile as profileApi } from "@proplus/api";
import { METHOD_LABEL_KO, stripDangerousUrl } from "@proplus/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { MetricClaim } from "@/components/MetricClaim";
import { OfferCard } from "@/components/OfferCard";
import { TrustSection } from "@/components/TrustSection";

export const dynamic = "force-dynamic";

type PublicProfile = profileApi.PublicProfileDto;
type PublicBlock = PublicProfile["blocks"][number];

/**
 * `generateMetadata` 와 페이지 본문이 같은 요청에서 각각 DB 를 때리지 않게 한 요청 범위로 묶는다.
 * (`fetch` 가 아니라 모듈 직접 호출이므로 Next 의 fetch 중복 제거가 걸리지 않는다.)
 *
 * `viewer` 를 넘기지 않는 이유: rate limit 버킷의 재료는 호출자 IP 이고, SSR 렌더는 호출자가 아니다.
 * 공개 API 라우트는 넘긴다(P-189) — 거기서는 요청 한 건이 곧 호출자 한 명이다.
 */
const loadProfile = cache(async (slug: string): Promise<PublicProfile | null> => {
  try {
    return await profileApi.getPublicProfile(slug, new Date());
  } catch (e) {
    // 미발행·정지·오타 slug 는 모두 404 다 — "있지만 비공개"와 "없음"을 구분해 알려 주지 않는다(P-027).
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
});

/** 메타 설명은 한 줄이어야 한다. 사용자 텍스트의 줄바꿈·연속 공백을 접고 길이를 자른다. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function metaDescription(p: PublicProfile): string {
  const parts = [
    p.headline,
    p.specialties.length > 0 ? `전문 분야: ${p.specialties.join(", ")}` : null,
    p.region,
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

  const base = parts.length > 0 ? parts.join(" · ") : (p.bio ?? "");
  // 지어내지 않는다: 소개가 전혀 없으면 사실만 적는다.
  return oneLine(base.length > 0 ? base : `${p.displayName} 의 PROPLUS 공개 프로필입니다.`, 158);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const p = await loadProfile(slug);

  // P-027/P-030: 발행되지 않은 주소는 색인하지 않는다. 404 본문이 색인되면 비공개 전환이 티가 난다.
  if (!p) {
    return { title: "프로필을 찾을 수 없습니다", robots: { index: false, follow: false } };
  }

  const title = p.headline ? `${p.displayName} — ${oneLine(p.headline, 60)}` : p.displayName;
  const description = metaDescription(p);
  const url = `/p/${p.slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    // og:image 는 넣지 않는다 — 공개 DTO 에 프로필 이미지가 없고(N-4 allowlist), CSP 의 img-src 는
    // 'self' 뿐이라 외부 이미지를 쓸 수도 없다. 없는 이미지를 가리키는 태그보다 없는 편이 정확하다.
    openGraph: { type: "profile", siteName: "PROPLUS", title, description, url },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 블록 props 읽기
//
// `props` 는 저장 시 `validateBlock()` 화이트리스트를 통과한 값이지만 타입은 여전히
// `Record<string, unknown>` 이다(N-10 은 "허용 밖 키는 저장되지 않는다"까지만 보장한다).
// 그래서 읽는 쪽에서 모양을 확인한다 — 틀린 모양은 버리고, 없는 값을 만들어 넣지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

/** `objectList` 블록(FAQ·링크)의 두 필드를 쌍으로 꺼낸다. 한쪽이 비면 그 항목만 버린다. */
function pairList(v: unknown, keyA: string, keyB: string): [string, string][] {
  if (!Array.isArray(v)) return [];
  const out: [string, string][] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const first = str(row[keyA]);
    const second = str(row[keyB]);
    if (first && second) out.push([first, second]);
  }
  return out;
}

/**
 * 블록이 고르지 않은 종류의 기본 섹션.
 *
 * 블록은 **레이아웃만** 담는다(N-10) — 무엇이 공개되는지는 공개 뷰가 정한다. 그래서 소유자가
 * `metrics` 블록을 두지 않았더라도 공개 가능한 지표가 있으면 마지막에 붙인다: 공개된 사실이
 * 화면에서 사라지는 것보다 순서가 뒤로 가는 편이 낫다. 내용이 없는 섹션은 각 렌더러가 `null` 을
 * 돌려주므로 제목만 남는 빈 섹션은 생기지 않는다.
 */
const DEFAULT_SECTIONS: readonly PublicBlock[] = [
  { kind: "intro", position: 0, props: {} },
  { kind: "specialties", position: 1, props: {} },
  { kind: "metrics", position: 2, props: {} },
  { kind: "offers", position: 3, props: {} },
];

const LANGUAGE_LABEL_KO: Readonly<Record<string, string>> = {
  ko: "한국어",
  en: "영어",
  ja: "일본어",
  zh: "중국어",
};

/** 모르는 코드는 코드 그대로 보여준다 — 언어 이름을 추측해 쓰지 않는다. */
function languageLabel(code: string): string {
  return LANGUAGE_LABEL_KO[code] ?? code;
}

/** 히어로의 "제공 서비스 보기" 같은 내부 앵커가 섹션을 집을 수 있어야 하므로 id 를 한 곳에서 만든다. */
function sectionId(block: PublicBlock): string {
  return `section-${block.kind}-${block.position}`;
}

/**
 * `offers` 블록이 고른 상품. 고르지 않았으면 공개 가능한 상품 전부.
 * 렌더러와 히어로 앵커가 **같은 기준**을 써야 한다 — 기준이 갈리면 아무것도 없는 섹션으로 보내는 링크가 생긴다.
 */
function offersFor(block: PublicBlock, data: PublicProfile): PublicProfile["offers"] {
  const ids = strList(block.props.offerIds);
  return ids.length > 0 ? data.offers.filter((o) => ids.includes(o.id)) : data.offers;
}

function SectionShell({ id, heading, note, children }: {
  id: string;
  heading: string;
  note?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="px-5 py-10 sm:px-8 sm:py-14">
      <div className="mx-auto max-w-3xl">
        <h2 id={`${id}-heading`} className="display text-[24px] sm:text-[30px]">
          {heading}
        </h2>
        {note ? <p className="mt-2 whitespace-pre-line text-[14px] leading-relaxed text-[var(--fg-mute)]">{note}</p> : null}
        <div className="mt-5">{children}</div>
      </div>
    </section>
  );
}

/**
 * 블록 한 개를 섹션으로 그린다. 그릴 내용이 없으면 `null` 이다.
 *
 * `badges` 블록은 여기서 그리지 않는다 — 검증 상태는 첫 화면의 `TrustSection` 한 곳에만 둔다.
 * 같은 배지를 두 번 그리면 "확인된 항목이 많다"는 인상을 만드는 장식이 되고, 그것이 N-3 이 막는 것이다.
 * 대신 블록에 적어 둔 제목은 `TrustSection` 으로 넘긴다(아래 `badgeHeading`).
 *
  * `career` 블록은 공개 DTO 의 `facts` 를 쓴다(P-023). 검증된 항목과 자기기재를 라벨로 구분한다.
 * 항목이 하나도 없으면 섹션을 그리지 않는다 — 제목만 있는 빈 섹션은 "경력이 없다"는 거짓이 된다.
 */
function BlockSection({ block, data }: { block: PublicBlock; data: PublicProfile }) {
  const key = sectionId(block);
  const heading = str(block.props.heading);
  const note = str(block.props.note);

  switch (block.kind) {
    case "intro": {
      const body = str(block.props.body) ?? data.bio;
      if (!body) return null;
      return (
        <SectionShell id={key} heading={heading ?? "소개"}>
          {/* N-10: sanitize 된 평문이다. dangerouslySetInnerHTML 을 쓰지 않고 줄바꿈만 살린다. */}
          <p className="whitespace-pre-line text-[16px] leading-[1.75]">{body}</p>
        </SectionShell>
      );
    }

    case "specialties": {
      const items = strList(block.props.items);
      const list = items.length > 0 ? items : data.specialties;
      if (list.length === 0) return null;
      return (
        <SectionShell id={key} heading={heading ?? "전문 분야"}>
          <ul className="flex flex-wrap gap-2">
            {list.map((item) => (
              <li key={item} className="chip">
                {item}
              </li>
            ))}
          </ul>
        </SectionShell>
      );
    }

    case "metrics": {
      const codes = strList(block.props.metricCodes);
      // 블록이 코드를 고른 경우에만 거른다. 고르지 않았으면 공개 가능한 지표 전부를 보여준다.
      const metrics = codes.length > 0 ? data.metrics.filter((m) => codes.includes(m.metricCode)) : data.metrics;
      if (metrics.length === 0) return null;
      return (
        <SectionShell id={key} heading={heading ?? "측정 지표"} note={note}>
          <ul className="grid gap-4 sm:grid-cols-2">
            {metrics.map((m) => (
              <MetricClaim key={`${m.metricCode}-${m.periodEnd ?? ""}`} metric={m} />
            ))}
          </ul>
          <p className="mt-4 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
            수치는 위에 적힌 측정 기간·표본·집계 기준 안에서만 유효합니다. 조건 없이 숫자만 보여주지 않습니다.
          </p>
        </SectionShell>
      );
    }

    case "offers": {
      const offers = offersFor(block, data);
      if (offers.length === 0) return null;
      return (
        <SectionShell id={key} heading={heading ?? "제공 서비스"}>
          <ul className="grid gap-4 sm:grid-cols-2">
            {offers.map((o) => (
              <OfferCard key={o.id} offer={o} slug={data.slug} />
            ))}
          </ul>
        </SectionShell>
      );
    }

    case "faq": {
      // P-034: 질문·답변 쌍, 텍스트만.
      const items = pairList(block.props.items, "q", "a");
      if (items.length === 0) return null;
      return (
        <SectionShell id={key} heading={heading ?? "자주 묻는 질문"}>
          <dl className="flex flex-col gap-5">
            {items.map(([question, answer]) => (
              <div key={question} className="flex flex-col gap-1.5">
                <dt className="text-[15.5px] font-semibold">{question}</dt>
                <dd className="whitespace-pre-line text-[14.5px] leading-relaxed text-[var(--fg-mute)]">{answer}</dd>
              </div>
            ))}
          </dl>
        </SectionShell>
      );
    }

    case "links": {
      const items = pairList(block.props.items, "label", "url");
      if (items.length === 0) return null;
      return (
        <SectionShell id={key} heading={heading ?? "링크"}>
          <ul className="flex flex-col gap-2">
            {items.map(([label, rawUrl]) => {
              // P-033: 저장 때 걸렀지만 렌더 직전에 한 번 더 본다. 통과하지 못한 링크는 그리지 않는다.
              const url = stripDangerousUrl(rawUrl);
              if (!url) return null;
              return (
                <li key={`${label}-${rawUrl}`}>
                  <a
                    href={url}
                    target="_blank"
                    rel="nofollow noopener noreferrer"
                    className="text-[15px] font-semibold text-[var(--accent-text)] underline underline-offset-4"
                  >
                    {label}
                    <span className="sr-only"> (새 창으로 열립니다)</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </SectionShell>
      );
    }

    case "contact": {
      // P-036. 전화·이메일은 공개 DTO 에 없다(P-029: 별도 공개 동의가 있어야 하고, 판정은 vCard 경로가 한다).
      // 그래서 `showEmail`/`showPhone` 로 값을 만들어 그리지 않고, 상담 폼과 vCard 로 안내한다.
      const label = str(block.props.ctaLabel) ?? "상담 요청하기";
      return (
        <SectionShell id={key} heading={heading ?? "상담 요청"} note={note}>
          <div className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
              연락처를 남기면 본인이 직접 확인합니다. 상담 처리 동의와 마케팅 수신 동의는 따로 받습니다.
            </p>
            <Link href={`/p/${data.slug}/contact`} className="btn btn-primary shrink-0">
              {label}
            </Link>
          </div>
        </SectionShell>
      );
    }

    case "career": {
      /**
       * P-023 경력·학력·자격 항목. 공개 DTO 의 `facts` 를 쓴다.
       *
       * **검증된 항목과 자기기재 항목을 같은 목록에 두고 라벨로 구분한다** (기획서 §5-4 "명확한 출처").
       * 자기기재를 숨기면 프로필이 비어 보이고, 구분 없이 섞으면 확인된 것처럼 읽힌다 — 둘 다 거짓이다.
       * `method` 가 null 이면 자기기재다(N-1).
       */
      const facts = data.facts;
      if (facts.length === 0) return null;
      return (
        <SectionShell id={key} heading={heading ?? "경력"} note={note}>
          <ul className="grid gap-3">
            {facts.map((f, i) => (
              <li key={`${f.kind}-${f.label}-${i}`} className="rounded-[var(--radius-card)] border border-[var(--line)] p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[15px] font-medium">{f.label}</span>
                  {/* 색이 아니라 텍스트로 출처를 말한다 (브랜드 §7). */}
                  <span
                    className="chip !text-[12px]"
                    data-testid={f.method ? "fact-verified" : "fact-self-declared"}
                  >
                    {f.method ? METHOD_LABEL_KO[f.method] : "자기기재"}
                  </span>
                </div>
                {f.detail ? (
                  <p className="mt-1.5 whitespace-pre-line text-[13.5px] leading-relaxed text-[var(--fg-mute)]">{f.detail}</p>
                ) : null}
                {f.startedOn || f.endedOn ? (
                  <p className="mt-1.5 text-[12.5px] text-[var(--fg-mute)]">
                    {[f.startedOn, f.endedOn ?? "현재"].filter(Boolean).join(" ~ ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
            “자기기재”는 본인이 직접 적은 내용이며 확인 절차를 거치지 않았습니다.
          </p>
        </SectionShell>
      );
    }

    default:
      return null;
  }
}

export default async function PublicProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await loadProfile(slug);
  if (!data) notFound();

  // 배지 만료 임박 표기의 기준 시각. 컴포넌트가 스스로 `new Date()` 를 부르지 않는다(CONTRACTS: `now: Date`).
  const now = new Date();

  // 소유자가 정한 순서가 먼저고, 고르지 않은 기본 종류가 뒤에 붙는다 (DEFAULT_SECTIONS 주석 참조).
  const chosen = [...data.blocks].sort((a, b) => a.position - b.position);
  const chosenKinds = new Set(chosen.map((b) => b.kind));
  const sections = [...chosen, ...DEFAULT_SECTIONS.filter((d) => !chosenKinds.has(d.kind))];

  const badgeHeading = str(chosen.find((b) => b.kind === "badges")?.props.heading);
  const offersSection = sections.find((b) => b.kind === "offers");
  const offersAnchor =
    offersSection && offersFor(offersSection, data).length > 0 ? `#${sectionId(offersSection)}` : null;
  const contactHref = `/p/${data.slug}/contact`;

  return (
    // 하단 고정 CTA(모바일) 높이만큼 본문 끝을 비워 둔다 — 마지막 문단이 가려지면 안 된다.
    <div className="pb-28 sm:pb-0">
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
        <Link href="/" className="display text-[19px] tracking-tight">
          PROPLUS
        </Link>
        {/* P-035: vCard 는 공개 동의된 연락처만 담는다(판정은 모듈이 한다). 여기서는 내려받기 링크만 둔다. */}
        <a
          href={`/api/v1/public/profiles/${data.slug}/vcard`}
          className="btn btn-ghost !min-h-10 text-[13.5px]"
          download
        >
          연락처 저장
        </a>
      </header>

      <main id="main">
        {/* ── 첫 화면 (M02: 핵심 소개 · 검증 상태 · 상담 CTA) ───────────── */}
        <section className="mx-auto max-w-3xl px-5 pb-8 pt-2 sm:px-8 sm:pb-12 sm:pt-6">
          <h1 className="display text-[30px] sm:text-[46px]">{data.displayName}</h1>

          {/*
            headline 이 없어도 이 자리는 비우지 않는다 — 소개가 비었다는 사실도 정보다.
            (비어 있으면 보는 사람은 페이지가 덜 로드된 것으로 읽는다.)
          */}
          <p data-testid="profile-headline" className="mt-2 text-[17px] leading-relaxed sm:text-[19px]">
            {data.headline ?? "소개 문구가 아직 등록되지 않았습니다."}
          </p>

          {data.region || data.languages.length > 0 ? (
            <p className="mt-2 text-[13.5px] text-[var(--fg-mute)]">
              {[data.region, data.languages.length > 0 ? `상담 언어: ${data.languages.map(languageLabel).join(", ")}` : null]
                .filter((v): v is string => typeof v === "string" && v.length > 0)
                .join(" · ")}
            </p>
          ) : null}

          {data.specialties.length > 0 ? (
            <ul className="mt-4 flex flex-wrap gap-2" aria-label="전문 분야">
              {data.specialties.slice(0, 6).map((s) => (
                <li key={s} className="chip">
                  {s}
                </li>
              ))}
            </ul>
          ) : null}

          {/* 첫 화면 안에 상담 CTA 가 보여야 한다(M02). 하단 고정 바는 같은 행동의 두 번째 자리다. */}
          <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
            <Link href={contactHref} className="btn btn-primary btn-lg">
              상담 요청하기
            </Link>
            {offersAnchor ? (
              <a href={offersAnchor} className="btn btn-ghost btn-lg">
                제공 서비스 보기
              </a>
            ) : null}
          </div>

          <TrustSection badges={data.badges} now={now} heading={badgeHeading ?? undefined} className="mt-6" />
        </section>

        <hr className="rule mx-auto max-w-3xl" />

        {/* 섹션 순서는 프로필 소유자가 정한 블록 순서를 따른다(블록은 레이아웃만 담는다 — N-10). */}
        <div className="divide-y divide-[var(--line)]">
          {sections.map((block) => (
            <BlockSection key={`${block.kind}-${block.position}`} block={block} data={data} />
          ))}
        </div>
      </main>

      <footer className="border-t border-[var(--line)]">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-5 py-8 sm:px-8">
          <p className="text-[13px] leading-relaxed text-[var(--fg-mute)]">
            확인된 항목에는 확인 방식과 확인일이 함께 표시됩니다. 확인 절차를 거치지 않은 내용은 본인이 직접 적은 것입니다.
          </p>
          <nav className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-[var(--fg-mute)]" aria-label="약관 및 정책">
            <Link href="/legal/terms" className="hover:text-[var(--fg)]">
              이용약관
            </Link>
            <Link href="/legal/privacy" className="hover:text-[var(--fg)]">
              개인정보 처리방침
            </Link>
            <Link href="/" className="hover:text-[var(--fg)]">
              PROPLUS 소개
            </Link>
          </nav>
        </div>
      </footer>

      {/*
        P-036 / 브랜드 §7: 주요 행동은 한 손 엄지 영역에 둔다. 데스크톱에서는 히어로의 CTA 가 늘 보이므로
        숨긴다(sm:hidden) — 큰 화면에서 화면을 가리는 고정 바는 가치 없이 면적만 쓴다.
        배경을 반투명으로 두지 않는 이유: 뒤 텍스트와 겹치면 대비 AA 를 보장할 수 없다(P-193).
      */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--line)] bg-[var(--bg-elev)] px-5 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 sm:hidden">
        <Link href={contactHref} className="btn btn-primary btn-lg w-full">
          상담 요청하기
        </Link>
      </div>
    </div>
  );
}
