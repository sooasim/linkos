/**
 * P-069 배지 설명 패널.
 *
 * 브랜드 §6: "검증 배지는 클릭하면 설명·출처 유형·검증일을 보여준다."
 * 배지가 무엇을 근거로 붙었는지 사용자가 확인할 수 없으면 그 배지는 장식일 뿐이고,
 * 그것이 PROPLUS 가 피하려는 실패 모드다 (전략 §0 "Proof Engine").
 *
 * <details>/<summary> 로 만든 이유:
 *   - 공개 프로필에는 사용자 JS 가 없고(N-10) CSP script-src 가 'self' 뿐이다(P-042).
 *     브라우저 기본 동작으로 여닫히면 JS 가 한 줄도 필요 없다.
 *   - <summary> 는 기본적으로 포커스·엔터·스페이스가 동작한다 — 접근성(브랜드 §7)을 직접 구현하지 않는다.
 *   - 인쇄 시 globals.css 가 ::details-content 를 펼친다. 검증 상태는 종이에서도 숨지 않는다.
 */

import { METHOD_LABEL_KO, type PublicBadge, type VerificationMethod } from "@proplus/domain";
import { Badge, formatBadgeDay } from "./Badge";

/**
 * 배지 유형별 설명. 문구는 브랜드 §5 "배지 카피 예시"를 따른다 —
 * 무엇을 확인했고 무엇을 확인하지 않았는지를 같이 적는다. 확대 해석을 막는 것이 설명의 목적이다.
 */
export const BADGE_DESCRIPTION_KO: Readonly<Record<string, string>> = {
  identity: "본인 확인 절차를 거친 계정입니다. 이름·연락처가 실제 본인의 것인지 확인한 것이며, 업무 능력에 대한 평가는 아닙니다.",
  affiliation: "표시된 조직에 현재 소속되어 있음을 조직이 확인했습니다. 과거 이력이 아니라 확인일 기준의 소속입니다.",
  license: "자격·면허 정보를 확인했습니다. 발급기관·범위·유효기간 안에서만 유효하며, 범위를 넘는 업무를 보장하지 않습니다.",
  career: "제출된 경력 근거를 확인했습니다. 확인된 범위는 아래 '확인 범위'에 적힌 기간·역할에 한정됩니다.",
  product_training: "제조사·공급사가 제공하는 교육 또는 인증 과정을 이수했음을 확인했습니다.",
  transaction_count: "연동된 시스템의 거래 데이터를 확인했습니다. 집계 기간과 집계 기준이 함께 표시될 때만 수치가 공개됩니다.",
  response_time: "측정 기간·업무시간·표본 수를 함께 공개하는 조건으로 산출한 응답 지표입니다. 미래의 응답 속도를 약속하지 않습니다.",
  aftercare: "사후 관리 절차를 확인했습니다. 확인 범위에 적힌 항목에 한정됩니다.",
};

const FALLBACK_DESCRIPTION = "확인된 항목입니다. 확인 방식과 확인일, 확인 범위를 아래에서 볼 수 있습니다.";

export function badgeDescription(badgeType: string): string {
  return BADGE_DESCRIPTION_KO[badgeType] ?? FALLBACK_DESCRIPTION;
}

/**
 * "출처 유형" — 강도 라벨이 곧 출처다 (보안정책 §4.1, 전략 §4.3).
 * self_declared 는 공개 배지가 될 수 없지만(N-1), Record 를 전수로 두어
 * 새 강도가 추가되면 타입 에러로 알려 주게 한다.
 */
export const SOURCE_KIND_KO: Readonly<Record<VerificationMethod, string>> = {
  self_declared: "사용자 본인이 기재한 정보 (확인되지 않음)",
  document_reviewed: "본인이 제출한 서류를 운영자가 검토",
  issuer_confirmed: "발급기관이 직접 확인",
  system_integrated: "연동된 시스템이 제공한 데이터",
};

interface DisclosureProps {
  badge: PublicBadge;
  /** Badge 로 그대로 넘긴다. 넘기지 않으면 만료 임박 표기를 하지 않는다. */
  now?: Date;
}

export function Disclosure({ badge, now }: DisclosureProps) {
  return (
    <details className="disclosure" data-testid="badge-disclosure">
      <summary data-testid="badge-disclosure-summary">
        <Badge badge={badge} now={now} />
        <span className="disclosure-hint">
          <span className="disclosure-hint-closed">설명 보기</span>
          <span className="disclosure-hint-open">설명 닫기</span>
        </span>
      </summary>

      <div className="disclosure-panel" data-testid="badge-disclosure-body">
        <p>{badgeDescription(badge.type)}</p>

        <dl className="disclosure-dl">
          <dt>출처 유형</dt>
          <dd>{SOURCE_KIND_KO[badge.method]}</dd>

          <dt>확인 방식</dt>
          <dd>{METHOD_LABEL_KO[badge.method]}</dd>

          <dt>확인 범위</dt>
          <dd>{badge.scope}</dd>

          <dt>확인일</dt>
          <dd>{formatBadgeDay(badge.verifiedAt)}</dd>

          <dt>유효기간</dt>
          {/* 만료일이 없는 것과 "무기한 보장"은 다르다. 그래서 문구로 구분해 적는다. */}
          <dd>{badge.expiresAt ? `${formatBadgeDay(badge.expiresAt)}까지` : "별도 만료일 없음 (변경 시 즉시 회수)"}</dd>

          <dt>발급기관</dt>
          <dd>{badge.issuerName ?? "해당 없음"}</dd>
        </dl>

        {/* N-14 / 보안정책 §4.7: 분쟁은 "잘못"이 아니라 "재확인 중"으로만 말한다. */}
        {badge.disputed ? (
          <p className="disclosure-note">
            이 항목에 대한 확인 요청이 접수되어 재확인 절차가 진행 중입니다. 절차가 끝나기 전까지 원래 라벨을 표시하지 않습니다.
          </p>
        ) : null}

        {/* N-5 / 보안정책 §2: 증거 원본은 공개 경로에서 접근할 수 없다. 그 사실을 보는 사람에게도 알린다. */}
        <p className="disclosure-note">
          확인에 사용한 증빙 원본은 공개되지 않습니다. 공개되는 것은 확인 결과와 위에 적힌 조건뿐입니다.
        </p>
      </div>
    </details>
  );
}
