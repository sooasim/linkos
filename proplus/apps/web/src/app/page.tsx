/**
 * 랜딩 (P-180 스캐폴드 위의 첫 화면).
 *
 * 카피는 브랜드 §4(첫 화면)·§1(브랜드 구조)·§3(브랜드 원칙)을 그대로 쓴다. 지어내지 않는다.
 * 과장 표현 금지(브랜드 §5): "국내 1위"·"100% 검증"·"완벽히 신뢰" 류의 문구를 쓰지 않고,
 * 아직 만들지 않은 기능을 이미 있는 것처럼 적지 않는다 — 준비 중인 것은 준비 중이라고 적는다.
 *
 * 무거운 JS·이미지를 올리지 않는다: CSP 가 인라인 스크립트를 막고(P-042),
 * 이 화면의 모든 상호작용은 링크와 <details> 뿐이라 JS 없이 완결된다.
 */

import Link from "next/link";
import { METHOD_LABEL_KO, VERIFICATION_METHODS, type VerificationMethod } from "@proplus/domain";

/**
 * N-9: **정적 프리렌더를 쓰지 않는다.**
 *
 * 이 저장소는 어떤 화면도 빌드 시점 HTML 로 굽지 않는다. 신뢰 정보(배지·지표)는 만료·취소가
 * **읽기 시점에** 반영돼야 하고(보안정책 §4.5), 프리렌더된 페이지는 재검증 시각까지 회수된
 * 배지를 계속 보여 준다 — 그 지연은 "확인됨" 이라고 적힌 거짓이 떠 있는 시간이다.
 *
 * 랜딩은 신뢰 정보를 그리지 않지만 **예외를 만들지 않는다**: 한 페이지라도 정적이면
 * "이 앱은 정적 프리렌더를 쓴다" 가 되고, 다음 사람이 프로필 화면에도 같은 패턴을 복사한다.
 * 이 화면은 DB 를 읽지 않으므로 요청마다 렌더해도 비용이 거의 없다.
 *
 * 이 불변식은 `scripts/check-no-prerender.mjs` 가 CI 에서 기계적으로 지킨다.
 */
export const dynamic = "force-dynamic";

/** 전략 §4.3 / 보안정책 §4.1 의 강도 표를 사람이 읽을 문장으로 옮긴 것. */
const METHOD_NOTE: Readonly<Record<VerificationMethod, string>> = {
  self_declared: "사용자가 직접 적은 정보. 확인 절차를 거치지 않았습니다.",
  document_reviewed: "제출한 서류를 운영자가 검토해 확인했습니다.",
  issuer_confirmed: "자격·소속을 발급한 기관이 직접 확인했습니다.",
  system_integrated: "연동된 시스템이 보내온 데이터로 확인했습니다.",
};

/** 브랜드 §1 브랜드 구조. MVP 범위(전략 §5)에 맞춰 각 줄에 지금 상태를 적는다. */
const BRAND_STRUCTURE = [
  {
    name: "PROPLUS PEOPLE",
    title: "사람을 설명하는 페이지",
    body: "전문분야·경력·제공 가능한 일을 내 주소(/p/내아이디)에서 보여줍니다. 공개 범위는 항목마다 직접 정합니다.",
    state: "지금 사용할 수 있습니다",
  },
  {
    name: "PROPLUS VERIFIED",
    title: "확인한 것만 배지로",
    body: "본인·소속·자격·경력을 근거와 함께 확인하고, 확인 방식과 확인일을 배지에 같이 적습니다. 자기기재 항목은 배지가 되지 않습니다.",
    state: "지금 사용할 수 있습니다",
  },
  {
    name: "PROPLUS MARKET",
    title: "상담에서 거래까지",
    body: "상담 요청을 받고 진행 단계를 관리합니다. 상품·서비스 카드와 예약은 범위를 좁혀 단계적으로 엽니다.",
    state: "상담 요청은 사용 가능 · 카탈로그와 예약은 준비 중",
  },
] as const;

/** 브랜드 §3 브랜드 원칙. 문구를 바꾸지 않고 옮긴다. */
const PRINCIPLES = [
  "사람 중심, 과장보다 증거",
  "명확하고 간결한 언어",
  "검증 상태를 숨기지 않음",
  "광고·유료 노출과 일반 검색결과를 구분",
  "인증이 없는 항목은 “자기기재”로 명시",
] as const;

export default function Landing() {
  return (
    <div>
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <Link href="/" className="display text-[22px] tracking-tight">
          PROPLUS
        </Link>
        <nav className="flex items-center gap-1" aria-label="주요 메뉴">
          <a href="#structure" className="hidden rounded-full px-3 py-2 text-[14px] text-[var(--fg-mute)] hover:text-[var(--fg)] sm:inline">
            무엇을 하는 곳인가
          </a>
          <a href="#verification" className="hidden rounded-full px-3 py-2 text-[14px] text-[var(--fg-mute)] hover:text-[var(--fg)] sm:inline">
            확인 방식
          </a>
          <Link href="/login" className="btn btn-ghost !min-h-10 text-[14px]">
            로그인
          </Link>
        </nav>
      </header>

      <main id="main">
        {/* ── Hero (브랜드 §4 카피) ───────────────────────────── */}
        <section className="mx-auto max-w-6xl px-5 pb-16 pt-10 sm:px-8 sm:pb-24 sm:pt-16">
          <p className="eyebrow">제품을 광고하는 곳이 아니라, 믿고 거래할 사람을 찾는 곳</p>
          <h1 className="display mt-5 text-[40px] sm:text-[64px] lg:text-[76px]">사람이 브랜드가 되는 곳, PROPLUS</h1>
          <p className="lede mt-6 text-[18px] sm:text-[20px]">
            경력과 전문성을 보여주고, 확인 가능한 신뢰를 쌓고, 나만의 페이지에서 고객과 연결하세요.
          </p>

          {/* 모바일에서 주요 행동이 한 손에 닿도록 세로 스택부터 시작한다 (브랜드 §7 모바일 우선). */}
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link href="/login" className="btn btn-primary btn-lg">
              내 프로필 만들기
            </Link>
            <Link href="/search" className="btn btn-ghost btn-lg">
              검증된 전문가 찾기
            </Link>
          </div>

          <p className="mt-6 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
            확인된 항목에는 확인 방식과 확인일을 함께 적습니다. 확인 절차를 거치지 않은 항목은 “자기기재”로 표시하고,
            확인이 취소되거나 기간이 지난 배지는 공개 화면에서 바로 내려갑니다.
          </p>
        </section>

        <hr className="rule mx-auto max-w-6xl" />

        {/* ── 브랜드 구조 (브랜드 §1) ────────────────────────── */}
        <section id="structure" className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
          <h2 className="display text-[30px] sm:text-[42px]">세 가지로 나눠 생각합니다</h2>
          <p className="lede mt-4">
            사람을 설명하는 일(PEOPLE), 그 설명을 확인하는 일(VERIFIED), 확인된 사람과 거래하는 일(MARKET)을 분리했습니다.
            확인이 설명에 섞이면 “보기 좋게 쓴 글”과 “확인된 사실”을 구분할 수 없게 되기 때문입니다.
          </p>

          <ul className="mt-10 grid gap-5 md:grid-cols-3">
            {BRAND_STRUCTURE.map((item) => (
              <li key={item.name} className="card flex flex-col gap-3 p-6">
                <p className="eyebrow">{item.name}</p>
                <h3 className="text-[19px] font-semibold">{item.title}</h3>
                <p className="text-[14.5px] leading-relaxed text-[var(--fg-mute)]">{item.body}</p>
                <p className="mt-auto pt-2 text-[12.5px] font-semibold text-[var(--fg-mute)]">{item.state}</p>
              </li>
            ))}
          </ul>

          <p className="mt-6 text-[13px] text-[var(--fg-mute)]">
            브랜드 구조에는 PROPLUS BUSINESS(조직 단위 운영)와 PROPLUS INSIGHTS(지표 제공)도 포함되지만, 아직 열지 않았습니다.
          </p>
        </section>

        <hr className="rule mx-auto max-w-6xl" />

        {/* ── 확인 방식 4단계 (전략 §4.3 / 보안정책 §4.1) ───── */}
        <section id="verification" className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
          <h2 className="display text-[30px] sm:text-[42px]">무엇을 어떻게 확인했는지 같이 적습니다</h2>
          <p className="lede mt-4">
            확인 방식은 네 가지뿐이고, 배지에는 늘 방식과 확인일이 붙습니다. 하나의 숫자로 사람을 점수 매기지 않습니다.
          </p>

          <ul className="mt-10 grid gap-4 sm:grid-cols-2">
            {VERIFICATION_METHODS.map((method) => {
              // N-1: 자기기재는 어떤 경로로도 배지가 되지 않는다. 그 사실을 화면에서도 숨기지 않는다.
              const issuable = method !== "self_declared";
              return (
                <li key={method} className="panel flex flex-col gap-2 p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[17px] font-semibold">{METHOD_LABEL_KO[method]}</h3>
                    {/* 실제 배지가 아니라 설명용 칩이므로 .badge 클래스를 쓰지 않는다 —
                        배지 모양을 설명 UI 에 재사용하면 "예시"와 "확인된 사실"이 섞인다. */}
                    <span className="chip font-semibold">{issuable ? "배지 발급 가능" : "배지 발급 불가"}</span>
                  </div>
                  <p className="text-[14px] leading-relaxed text-[var(--fg-mute)]">{METHOD_NOTE[method]}</p>
                </li>
              );
            })}
          </ul>

          <p className="mt-6 max-w-[62ch] text-[13px] leading-relaxed text-[var(--fg-mute)]">
            거래 실적이나 응답 시간 같은 수치는 측정 기간·표본 수·집계 기준을 함께 보여줄 수 있을 때만 공개합니다.
            조건 없이 숫자만 보여주는 화면은 만들지 않습니다.
          </p>
        </section>

        <hr className="rule mx-auto max-w-6xl" />

        {/* ── 원칙 (브랜드 §3) ───────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
          <h2 className="display text-[30px] sm:text-[42px]">우리가 지키는 것</h2>
          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {PRINCIPLES.map((p) => (
              <li key={p} className="flex items-start gap-3 text-[15.5px]">
                <span aria-hidden="true" className="mt-[9px] size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                <span>{p}</span>
              </li>
            ))}
          </ul>

          <div className="card mt-10 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[15px] text-[var(--fg-mute)]">
              먼저 내 페이지를 만들고, 확인받을 항목을 하나씩 올리면 됩니다.
            </p>
            <Link href="/login" className="btn btn-primary">
              내 프로필 만들기
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--line)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div>
            <p className="display text-[18px]">PROPLUS</p>
            <p className="mt-1 text-[13px] text-[var(--fg-mute)]">proplus.linkos.com</p>
          </div>
          <nav className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-[var(--fg-mute)]" aria-label="약관 및 정책">
            <Link href="/legal/terms" className="hover:text-[var(--fg)]">
              이용약관
            </Link>
            <Link href="/legal/privacy" className="hover:text-[var(--fg)]">
              개인정보 처리방침
            </Link>
            <Link href="/search" className="hover:text-[var(--fg)]">
              전문가 찾기
            </Link>
            <Link href="/login" className="hover:text-[var(--fg)]">
              로그인
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
