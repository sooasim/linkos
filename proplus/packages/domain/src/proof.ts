/**
 * Proof Engine 상태 머신 — PROPLUS 의 핵심.
 *
 * 출처: dd/PROPLUS_Technical_Document_Set/
 *   02_모듈명세_제품요구사항.md M04
 *   04_보안_개인정보_신뢰정책.md §4 (증거 검증 정책 10개 항목)
 *   00_프로젝트_README.md "검증 상태, 증거 출처, 범위, 만료, 이의제기, 감사로그를 먼저 설계"
 *
 * 전략 §4.2 의 전이도를 그대로 코드로 옮긴 것이다. 여기서 막히는 것은 DB CHECK 제약으로도
 * 한 번 더 막는다(0001_proplus_core.sql) — 어느 한쪽이 틀려도 N-1 이 깨지지 않게 하려는 이중화다.
 */

import { type ProofActor, type ProofStatus, type VerificationMethod, isAtLeast } from "./types";

/**
 * 허용 전이 표. `[from][actor]` → 갈 수 있는 상태들.
 *
 * 역할을 분리한 이유: 소유자가 스스로 verified 로 올리는 길이 **표 자체에 없어야** 한다.
 * 권한 검사를 호출부에 맡기면 언젠가 빠뜨린다.
 */
const TRANSITIONS: Record<ProofStatus, Partial<Record<ProofActor, readonly ProofStatus[]>>> = {
  submitted: {
    reviewer: ["under_review", "rejected", "needs_more_info"],
    // 제출자는 검토 시작 전까지 철회(= revoked)할 수 있다.
    owner: ["revoked"],
    system: ["under_review"],
  },
  under_review: {
    reviewer: ["verified", "rejected", "needs_more_info"],
    system: ["needs_more_info"],
  },
  needs_more_info: {
    // 추가 정보를 올리면 다시 검토 대기열로 돌아간다.
    owner: ["submitted", "revoked"],
    reviewer: ["under_review", "rejected"],
  },
  verified: {
    // 만료는 시간이 결정한다 — 시스템만 기록한다. 읽기 시점 판정(N-9)과는 별개로
    // 이력을 남기기 위한 전이다.
    system: ["expired"],
    reviewer: ["revoked"],
    // 당사자는 확정된 검증에 이의를 제기할 수 있다 (보안정책 §4.6).
    owner: ["disputed", "revoked"],
  },
  rejected: {
    owner: ["disputed", "submitted"],
    reviewer: ["under_review"],
  },
  expired: {
    // 재검증 (P-062). 이전 이력은 보존된다.
    owner: ["submitted"],
    reviewer: ["under_review"],
  },
  revoked: {
    owner: ["submitted"],
  },
  disputed: {
    // 재심 결과. 보안정책 §4.7 — 분쟁 중에는 확정적 표현을 쓰지 않으므로
    // disputed 에서 바로 공개 라벨이 바뀌지 않는다(badge.ts 가 "확인 필요"로 고정).
    reviewer: ["verified", "rejected", "under_review"],
    owner: ["revoked"],
  },
};

export interface TransitionInput {
  from: ProofStatus;
  to: ProofStatus;
  actor: ProofActor;
  method: VerificationMethod;
  /** 보안정책 §4.3 — verified 에는 범위가 필수다. */
  scope?: string | null;
  /** 데이터모델 §4 — 반려·취소에는 사유 코드가 필수다. */
  reasonCode?: string | null;
  /** 이 증거 유형이 요구하는 최소 강도 (evidence_types.min_method). */
  minMethod?: VerificationMethod;
  /** 유형이 발급기관을 요구하는가 (evidence_types.requires_issuer). */
  requiresIssuer?: boolean;
  /** 발급기관의 발급 권한을 확인한 기록이 있는가 (보안정책 §4.4 / P-072). */
  issuerAuthorityChecked?: boolean;
}

export type TransitionResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * 전이 가능 여부. 거부 사유를 코드로 돌려주므로 API 가 그대로 응답에 쓸 수 있다.
 *
 * 순서가 중요하다: **강도 게이트를 전이표보다 먼저** 본다. 자기기재가 verified 로 가려는
 * 시도는 "전이표에 없음"이 아니라 "정책 위반"으로 보고돼야 운영자가 원인을 안다.
 */
export function canTransition(input: TransitionInput): TransitionResult {
  const { from, to, actor, method } = input;

  if (from === to) return { ok: false, code: "no_op", message: "상태가 같습니다." };

  // ── N-1 (보안정책 §4.2): 자기기재 값은 "검증됨" 배지를 받을 수 없다. ──────────
  // 이것이 PROPLUS 신뢰 모델의 바닥이다. 전이표보다 먼저 검사한다.
  if (to === "verified" && method === "self_declared") {
    return { ok: false, code: "self_declared_cannot_verify", message: "자기기재 항목은 검증 완료로 표시할 수 없습니다." };
  }

  // 유형별 최소 강도 (evidence_types.min_method)
  if (to === "verified" && input.minMethod && !isAtLeast(method, input.minMethod)) {
    return {
      ok: false,
      code: "method_too_weak",
      message: `이 증거 유형은 더 강한 검증 방식을 요구합니다.`,
    };
  }

  // 보안정책 §4.4 — 발급기관의 신뢰와 발급 권한을 확인한다.
  if (to === "verified" && input.requiresIssuer && !input.issuerAuthorityChecked) {
    return { ok: false, code: "issuer_authority_unchecked", message: "발급기관의 발급 권한이 확인되지 않았습니다." };
  }

  // 보안정책 §4.3 — 검증에는 범위와 기준일이 있어야 한다.
  if (to === "verified" && !nonEmpty(input.scope)) {
    return { ok: false, code: "scope_required", message: "검증 범위를 입력해야 합니다." };
  }

  // 데이터모델 §4 — 반려 사유 코드 필수. P-061 — 취소도 같다.
  if ((to === "rejected" || to === "revoked") && !nonEmpty(input.reasonCode)) {
    return { ok: false, code: "reason_required", message: "사유 코드를 입력해야 합니다." };
  }

  const allowed = TRANSITIONS[from]?.[actor] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, code: "transition_not_allowed", message: `${from} → ${to} 전이는 허용되지 않습니다.` };
  }

  return { ok: true };
}

/** 특정 역할이 이 상태에서 할 수 있는 전이 목록. 관리자 콘솔의 버튼 구성에 쓴다. */
export function allowedTransitions(from: ProofStatus, actor: ProofActor): readonly ProofStatus[] {
  return TRANSITIONS[from]?.[actor] ?? [];
}

/** 더 이상 전이가 없는 상태인가. (revoked 는 재제출이 가능하므로 종착이 아니다) */
export function isTerminal(status: ProofStatus): boolean {
  const t = TRANSITIONS[status];
  return !t || Object.values(t).every((xs) => (xs ?? []).length === 0);
}

/**
 * N-9 (보안정책 §4.5): 만료는 **읽기 시점**에 판정한다.
 *
 * 워커의 배치가 늦게 돌아도 공개 프로필에 만료된 배지가 남아 있어서는 안 된다.
 * 그래서 `expires_at` 를 지금과 비교하는 이 함수가 유일한 진실이고,
 * DB `public_badge_view` 가 같은 조건을 SQL 로 한 번 더 걸러 준다.
 */
export function isEffectivelyExpired(expiresAt: Date | string | null | undefined, now: Date): boolean {
  if (!expiresAt) return false;
  const t = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(t.getTime())) return false;
  return t.getTime() <= now.getTime();
}

/** 공개에 쓸 수 있는 실효 상태. 저장된 status 와 시간을 합쳐 판정한다. */
export function effectiveStatus(status: ProofStatus, expiresAt: Date | string | null | undefined, now: Date): ProofStatus {
  if (status === "verified" && isEffectivelyExpired(expiresAt, now)) return "expired";
  return status;
}

/**
 * 만료 예정 알림 대상인가 (P-060).
 * 알림 실패가 만료 판정에 영향을 주지 않는다 — 이 함수는 알림용이고, 판정은 위 함수다.
 */
export function isExpiringSoon(expiresAt: Date | string | null | undefined, now: Date, withinDays = 30): boolean {
  if (!expiresAt) return false;
  const t = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(t.getTime())) return false;
  const ms = t.getTime() - now.getTime();
  return ms > 0 && ms <= withinDays * 86_400_000;
}

/**
 * 유형의 기본 TTL 로 만료일을 계산한다. TTL 이 없으면 만료 없음(null).
 * 보안정책 §4.3 "만료일 또는 재검증 조건" — TTL 이 없는 유형(본인확인·자격)은
 * 만료 대신 발급기관 상태 변경으로 취소된다.
 */
export function computeExpiry(verifiedAt: Date, ttlDays: number | null | undefined): Date | null {
  if (ttlDays == null || ttlDays <= 0) return null;
  return new Date(verifiedAt.getTime() + ttlDays * 86_400_000);
}

function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}
