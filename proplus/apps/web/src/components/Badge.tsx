/**
 * P-058 공개 배지 표시 · N-14 분쟁 중립 표기.
 *
 * 이 컴포넌트는 **판단을 하지 않는다.** 공개 여부·만료·자기기재 차단은 이미
 * `toPublicBadge()` 가 끝냈고(PublicBadge 가 존재한다는 것 자체가 "공개 가능"이라는 뜻),
 * UI 는 서버가 걸러 준 것만 그린다 (전략 §3 계층 규칙).
 *
 * 표시 규칙 (보안정책 §4.1 / 브랜드 §7):
 *   - 라벨 + 강도(methodLabel) + 범위 + 검증일을 **항상 함께** 보여준다. 하나를 빼면 P-058 위반이다.
 *   - 색만으로 상태를 구분하지 않는다 → 아이콘 모양 · 테두리 선 모양 · 텍스트가 모두 상태를 말한다.
 *   - 클라이언트 컴포넌트가 아니다. 공개 프로필은 JS 없이 읽혀야 한다 (N-10).
 */

import { isExpiringSoon, type PublicBadge } from "@proplus/domain";

export type BadgeTone = "verified" | "pending" | "caution";

/**
 * 분쟁 중인 배지만 'caution' 이다 — PublicBadge 는 만료·취소된 것이 이미 제외되어 있으므로
 * 공개 경로에서 나올 수 있는 색조는 두 가지뿐이다. 'pending' 은 워크스페이스/검토 큐가
 * 같은 시각 언어를 쓰도록 열어 둔 것이다.
 */
export function badgeTone(badge: Pick<PublicBadge, "disputed">): BadgeTone {
  return badge.disputed ? "caution" : "verified";
}

export function toneClassName(tone: BadgeTone): string {
  return tone === "verified" ? "badge-verified" : tone === "pending" ? "badge-pending" : "badge-caution";
}

/**
 * 상태별로 **모양이 다른** 아이콘. 색각 이상·흑백 인쇄에서도 구분되어야 한다 (브랜드 §7).
 * caution 에 경고 삼각형·느낌표를 쓰지 않는 이유: 분쟁은 "잘못"이 아니라 "재확인 중"이고,
 * 느낌표는 확정적 비난으로 읽힌다 (N-14 / 보안정책 §4.7). 그래서 중립적인 정보 표시를 쓴다.
 */
export function BadgeIcon({ tone }: { tone: BadgeTone }) {
  return (
    <svg className="badge-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.4" />
      {tone === "verified" ? (
        <polyline points="5,8.3 7.1,10.4 11,5.8" />
      ) : tone === "pending" ? (
        <polyline points="8,4.6 8,8.2 10.7,9.7" />
      ) : (
        <>
          <line x1="8" y1="7.2" x2="8" y2="11.4" />
          <circle cx="8" cy="4.9" r="0.75" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  );
}

interface BadgeProps {
  badge: PublicBadge;
  /**
   * 만료 임박 표기를 켤 때만 넘긴다. `new Date()` 를 컴포넌트 안에서 부르지 않는 이유:
   * SSR 과 클라이언트가 서로 다른 시각을 써서 표기가 흔들리면 안 되고,
   * 도메인 규칙상 시각은 항상 주입받는다 (CONTRACTS: `now: Date`).
   */
  now?: Date;
  className?: string;
}

export function Badge({ badge, now, className }: BadgeProps) {
  const tone = badgeTone(badge);
  const expiringSoon = now ? isExpiringSoon(badge.expiresAt, now) : false;

  return (
    <span
      className={`badge ${toneClassName(tone)}${className ? ` ${className}` : ""}`}
      data-badge-type={badge.type}
      data-testid="badge"
    >
      <BadgeIcon tone={tone} />
      <span className="badge-body">
        <span className="badge-label" data-testid="badge-label">
          {badge.label}
          {/* 색·아이콘을 볼 수 없는 사용자에게도 상태가 전달되어야 한다. */}
          <span className="sr-only">
            {badge.disputed ? " — 확인 절차가 다시 진행 중입니다." : " — 확인 완료"}
          </span>
        </span>
        {/*
          강도 · 범위 · 검증일 — 세 조각이 한 줄에 같이 있어야 "무엇을 어떻게 언제 확인했는지"가
          한 번에 읽힌다. 한 문자열로 합치지 않고 조각마다 testid 를 두는 이유: P-058 은
          "6필드가 함께 나간다"가 요구사항이고, 합쳐 버리면 **어느 조각이 빠졌는지** 테스트가 말할 수 없다.
        */}
        <span className="badge-meta">
          <span data-testid="badge-method">{badge.methodLabel}</span>
          {" · "}
          <span data-testid="badge-scope">{badge.scope}</span>
          {" · "}
          <span data-testid="badge-verified-at">{formatBadgeDay(badge.verifiedAt)} 확인</span>
          {badge.issuerName ? (
            <>
              {" · "}
              <span data-testid="badge-issuer">{badge.issuerName}</span>
            </>
          ) : null}
          {badge.expiresAt ? ` · ${formatBadgeDay(badge.expiresAt)}까지` : ""}
          {expiringSoon ? " · 갱신 예정" : ""}
        </span>
      </span>
    </span>
  );
}

/**
 * 검증일·만료일은 UTC 날짜를 그대로 쓴다. 보는 사람의 시간대에 따라 "확인일"이 하루 밀리면
 * 그것은 다른 사실이 되고, SSR/CSR 결과도 어긋난다.
 *
 * lib/client.ts 의 같은 함수를 import 하지 않는 것은 의도적이다 — 그 파일은 "use client" 모듈이고,
 * 서버 컴포넌트에서 그 export 를 호출하면 클라이언트 참조 프록시를 부르게 된다.
 */
export function formatBadgeDay(iso: string | null): string {
  if (!iso) return "";
  const d = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.replaceAll("-", ".") : "";
}
