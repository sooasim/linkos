/**
 * PROPLUS 도메인 공통 타입.
 *
 * 출처: dd/PROPLUS_Technical_Document_Set/03_데이터모델_API명세.md §1
 *       + 04_보안_개인정보_신뢰정책.md §4.1 (검증 강도)
 *
 * 이 패키지는 I/O 를 하지 않는다. 시각이 필요한 함수는 `now` 를 인자로 받는다 —
 * 만료 판정(N-9)을 테스트에서 재현 가능하게 만드는 것이 목적이다.
 */

/** 보안정책 §4.1 — 검증 방식과 강도. 순서가 곧 강도 순이다. */
export const VERIFICATION_METHODS = ["self_declared", "document_reviewed", "issuer_confirmed", "system_integrated"] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/** 모듈명세 M04 / 기획서 §7 검증 상태 */
export const PROOF_STATUSES = ["submitted", "under_review", "needs_more_info", "verified", "rejected", "expired", "revoked", "disputed"] as const;
export type ProofStatus = (typeof PROOF_STATUSES)[number];

/** 기획서 §5-4 "명확한 출처" */
export type EvidenceSource = "user" | "platform" | "organization" | "third_party";

/** 보안정책 §3 — 목적별로 분리 기록한다 (N-11) */
export const CONSENT_PURPOSES = ["service", "privacy", "marketing", "verification", "recording"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** 누가 전이를 시도하는가. 역할별 허용 전이가 다르다. */
export type ProofActor = "owner" | "reviewer" | "system";

export type MemberRole = "member" | "manager" | "owner";
export type PlatformRole = "none" | "reviewer" | "admin";

export const LEAD_STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/**
 * 기획서 §5-4 provenance. LINKOS 의 provenance 와 의미가 다르다 —
 * 여기서는 "검증 강도"가 곧 provenance 이므로 VerificationMethod 를 그대로 쓴다.
 * 검증되지 않은 값은 method 가 없다(null)는 뜻이고, 공개 시 "자기기재"로 표기한다.
 */
export type Provenance = VerificationMethod | null;

/** 브랜드 §5 — 강도별 공개 표기. 색만으로 상태를 구분하지 않으므로 텍스트가 필수다 (브랜드 §7). */
export const METHOD_LABEL_KO: Record<VerificationMethod, string> = {
  self_declared: "자기기재",
  document_reviewed: "서류 확인",
  issuer_confirmed: "발급기관 확인",
  system_integrated: "시스템 연동",
};

/** 강도 비교용 순위. 높을수록 강하다. */
export const METHOD_RANK: Record<VerificationMethod, number> = {
  self_declared: 0,
  document_reviewed: 1,
  issuer_confirmed: 2,
  system_integrated: 3,
};

export function isAtLeast(method: VerificationMethod, min: VerificationMethod): boolean {
  return METHOD_RANK[method] >= METHOD_RANK[min];
}
