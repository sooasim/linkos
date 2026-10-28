/**
 * P-025 첫 화면 검증 상태 · P-058 배지 6필드 · P-069 배지 설명 패널 · 브랜드 §3 "검증 상태를 숨기지 않음".
 *
 * **배지가 없어도 이 영역은 사라지지 않는다.** 비었을 때 섹션을 지우면 보는 사람은
 * "확인된 것이 없다"와 "이 서비스는 확인 정보를 보여주지 않는다"를 구분할 수 없고,
 * 그 모호함이 자기기재를 확인된 사실처럼 읽히게 만든다. 그래서 빈 상태를 **문장으로** 그린다.
 *
 * N-3: 개수·점수·순위를 그리지 않는다. "배지 3개"처럼 세어 강조하는 UI 는 단일 신뢰점수의
 * 시각적 우회로이고(globals.css 의 의미색 3개 주석과 같은 취지), 이 섹션에 그 숫자가 없는 것이 규칙이다.
 *
 * 판단도 하지 않는다 — 만료·취소·자기기재 배지는 `toPublicBadge()` 가 이미 빼 놓았다(N-1/N-9).
 * `PublicBadge` 가 손에 있다는 것 자체가 "공개 가능"이라는 뜻이다 (전략 §3 계층 규칙).
 */

import type { PublicBadge } from "@proplus/domain";
import { Disclosure } from "./Disclosure";

interface TrustSectionProps {
  badges: readonly PublicBadge[];
  /** 만료 임박 표기 기준 시각. 도메인 규칙대로 호출부가 넘긴다 (CONTRACTS: `now: Date`). */
  now: Date;
  /** 프로필 소유자가 `badges` 블록에 적은 제목. 없으면 기본값을 쓴다 (블록은 레이아웃만 담는다 — N-10). */
  heading?: string;
  className?: string;
}

export function TrustSection({ badges, now, heading, className }: TrustSectionProps) {
  return (
    <section
      data-testid="trust-section"
      aria-labelledby="trust-heading"
      className={`panel p-4 sm:p-5${className ? ` ${className}` : ""}`}
    >
      <h2 id="trust-heading" className="eyebrow">
        {heading ?? "확인된 항목"}
      </h2>

      {badges.length === 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          <p className="text-[15px] font-semibold">확인된 항목이 없습니다.</p>
          <p className="text-[13px] leading-relaxed text-[var(--fg-mute)]">
            이 페이지의 소개는 본인이 직접 적은 내용입니다. 확인 절차를 거친 항목이 생기면 확인 방식과 확인일이 함께 표시됩니다.
          </p>
        </div>
      ) : (
        <>
          <ul className="mt-3 flex flex-col gap-2">
            {badges.map((badge) => (
              <li key={badge.id}>
                {/* P-069: 배지 하나하나가 설명을 열 수 있어야 한다. <details> 라서 JS 없이 동작한다. */}
                <Disclosure badge={badge} now={now} />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-mute)]">
            각 항목의 “설명 보기”를 열면 확인 방식·확인 범위·확인일을 볼 수 있습니다. 확인에 쓴 증빙 원본은 공개되지 않습니다.
          </p>
        </>
      )}
    </section>
  );
}
