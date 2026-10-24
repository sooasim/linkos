/**
 * 증거 상태 칩(P-051/P-053) · 리드 단계 칩(P-104).
 *
 * 브랜드 §7 "배지 색상만으로 상태를 구분하지 말고 텍스트와 아이콘 병행" —
 * 그래서 칩은 네 가지를 함께 쓴다:
 *   1) 텍스트 라벨 (없을 수 없다)
 *   2) 상태별로 **모양이 다른** 아이콘
 *   3) 테두리 선 모양 (solid / dashed / double) — 색각 이상·흑백 인쇄에서도 구분된다
 *   4) 색 — 네 번째 단서일 뿐이다. `--verified`/`--pending`/`--caution` 세 토큰만 쓴다.
 *
 * `.badge` 클래스를 재사용하지 않는 이유: 검증 배지는 "확인된 사실"이고 이 칩은 "지금 처리 단계"다.
 * 같은 모양을 쓰면 검토 중인 제출물이 확인된 배지처럼 읽힌다 (랜딩 `page.tsx` 의 같은 판단).
 *
 * 리드 단계에는 의미색을 쓰지 않는다: 영업 단계는 신뢰도가 아니다. '성약'에 `--verified` 를 쓰면
 * 초록색이 "검증됨"으로 읽히고, 그것이 globals.css 가 의미색을 3개로 묶어 둔 이유(N-3 의 시각적 우회로 방지)를
 * 정면으로 깬다. 그래서 단계는 중성 테두리 + 텍스트로만 말하고, 행동이 필요한 '신규'만 강조색을 쓴다.
 *
 * UI 는 상태를 계산하지 않는다 — 서버가 준 `status`/`stage` 를 그대로 그린다 (전략 §3 계층 규칙).
 */

import { LEAD_STAGE_LABEL_KO, type LeadStage, type ProofStatus } from "@proplus/domain";

export type ChipTone = "verified" | "pending" | "caution" | "neutral";

/** 당사자(워크스페이스) 화면의 상태 라벨. 공개 화면의 배지 라벨과 다른 문장이다. */
export const PROOF_STATUS_LABEL_KO: Record<ProofStatus, string> = {
  submitted: "제출됨",
  under_review: "검토 중",
  needs_more_info: "추가 정보 필요",
  verified: "확인됨",
  rejected: "반려",
  expired: "기간 만료",
  revoked: "취소됨",
  // N-14: 분쟁을 "잘못"이 아니라 "재확인 중"으로만 말한다. 공개 화면의 라벨은 도메인 상수가 따로 고정한다.
  disputed: "재확인 중",
};

/** 상태가 지금 **무엇을 뜻하는지** 한 줄. 상태 이름만으로는 다음 행동을 알 수 없다. */
export const PROOF_STATUS_NOTE_KO: Record<ProofStatus, string> = {
  submitted: "검토 대기 중입니다. 검토가 시작되기 전까지는 철회할 수 있습니다.",
  under_review: "검토가 진행 중입니다. 이 상태에서는 당사자가 할 수 있는 조치가 없습니다.",
  needs_more_info: "검토자가 추가 자료를 요청했습니다. 자료를 올린 뒤 다시 검토를 요청해야 진행됩니다.",
  verified: "확인이 끝났습니다. 공개 화면에는 확인 방식과 확인일이 함께 표시됩니다.",
  rejected: "확인되지 않았습니다. 사유 코드를 확인하고 자료를 보완해 다시 제출할 수 있습니다.",
  expired: "유효기간이 지났습니다. 공개 화면에서는 이미 내려갔고, 다시 제출하면 재확인을 받습니다.",
  revoked: "취소된 항목입니다. 공개되지 않으며, 다시 제출할 수 있습니다.",
  disputed: "이의제기가 접수되어 재확인 절차가 진행 중입니다.",
};

/**
 * 상태 → 색조. `disputed` 가 `caution` 이 아니라 `pending` 인 것은 의도다 (N-14):
 * 분쟁은 재확인이 진행 중인 상태이고, 경고색으로 그리면 당사자에게 책임이 있다는 뜻으로 읽힌다.
 */
export const PROOF_STATUS_TONE: Record<ProofStatus, ChipTone> = {
  submitted: "pending",
  under_review: "pending",
  needs_more_info: "caution",
  verified: "verified",
  rejected: "caution",
  expired: "caution",
  revoked: "neutral",
  disputed: "pending",
};

/** 당사자가 **움직여야** 진행되는 상태. 목록에서 맨 위로 올리는 기준이다. */
export const OWNER_ACTION_STATUSES: readonly ProofStatus[] = ["needs_more_info"];

const CHIP_BASE = "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-semibold leading-tight";

/** 선 모양이 색과 **독립적으로** 상태를 말한다. 그래서 테두리 폭·스타일이 색조마다 다르다. */
const TONE_CLASS: Record<ChipTone, string> = {
  verified: "border border-solid border-[color:var(--verified)] text-[var(--verified)]",
  pending: "border border-dashed border-[color:var(--pending)] text-[var(--pending)]",
  caution: "border-[3px] border-double border-[color:var(--caution)] text-[var(--caution)]",
  neutral: "border border-solid border-[color:var(--line-strong)] text-[var(--fg-mute)]",
};

/**
 * 색조별로 **모양이 다른** 아이콘. caution 에 느낌표·경고 삼각형을 쓰지 않는 이유는
 * `Badge.tsx` 와 같다 — 느낌표는 확정적 비난으로 읽힌다 (N-14 / 보안정책 §4.7).
 */
function ChipIcon({ tone }: { tone: ChipTone }) {
  return (
    <svg
      className="size-[14px] shrink-0"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.4" />
      {tone === "verified" ? (
        <polyline points="5,8.3 7.1,10.4 11,5.8" />
      ) : tone === "pending" ? (
        <polyline points="8,4.6 8,8.2 10.7,9.7" />
      ) : tone === "caution" ? (
        <>
          <line x1="8" y1="7.2" x2="8" y2="11.4" />
          <circle cx="8" cy="4.9" r="0.75" fill="currentColor" stroke="none" />
        </>
      ) : (
        <line x1="5.2" y1="8" x2="10.8" y2="8" />
      )}
    </svg>
  );
}

interface StatusChipProps {
  status: ProofStatus;
  className?: string;
}

/** 증거 상태 칩. 라벨 텍스트가 항상 함께 나가므로 색을 못 보는 환경에서도 상태가 전달된다. */
export function StatusChip({ status, className }: StatusChipProps) {
  const tone = PROOF_STATUS_TONE[status];
  return (
    <span
      className={`${CHIP_BASE} ${TONE_CLASS[tone]}${className ? ` ${className}` : ""}`}
      data-status={status}
      data-testid="status-chip"
    >
      <ChipIcon tone={tone} />
      {PROOF_STATUS_LABEL_KO[status]}
    </span>
  );
}

/**
 * 리드 단계 칩. '신규'만 강조색(브랜드 강조색이고 검증 의미색이 아니다)으로 올린다 —
 * inbox 에서 "아직 아무도 손대지 않은 것"이 먼저 보여야 한다 (P-103).
 */
export function LeadStageChip({ stage, className }: { stage: LeadStage; className?: string }) {
  const emphasise = stage === "new";
  return (
    <span
      className={`${CHIP_BASE} border border-solid ${
        emphasise
          ? "border-[color:var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]"
          : "border-[color:var(--line-strong)] text-[var(--fg-mute)]"
      }${className ? ` ${className}` : ""}`}
      data-stage={stage}
      data-testid="lead-stage-chip"
    >
      {LEAD_STAGE_LABEL_KO[stage]}
    </span>
  );
}
