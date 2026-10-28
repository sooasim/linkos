/**
 * 공개 배지 정책.
 *
 * 출처: 00_통합기획서 §7 신뢰 증명 모델 / 04_보안_개인정보_신뢰정책 §4 / 07_브랜드_UX_카피가이드 §5
 *
 * 핵심 규칙 세 개:
 *   N-2  배지는 유료 구매만으로 획득할 수 없다 → 이 모듈의 함수는 **구독 상태를 인자로 받지 않는다.**
 *   N-14 분쟁 중에는 확정적 비난 표현을 쓰지 않는다 → disputed 라벨이 상수로 고정돼 있다.
 *   P-058 공개 배지는 6필드를 항상 함께 내보낸다. 하나라도 비면 배지를 숨긴다.
 */

import { METHOD_LABEL_KO, type VerificationMethod } from "./types";
import { isEffectivelyExpired } from "./proof";

/** 브랜드 §5 — 분쟁 중 공개 라벨. 코드 상수로 고정해 임의 문구가 끼어들 수 없게 한다 (N-14). */
export const DISPUTED_LABEL_KO = "확인 필요";

/**
 * 브랜드 §5 가 금지한 표현. 배지 라벨·프로필 문구 검사에 쓴다.
 * "근거가 부족하거나 오해를 부르는 표현은 사용하지 않는다."
 */
export const FORBIDDEN_CLAIM_PATTERNS: readonly RegExp[] = [
  /국내\s*1\s*위/,
  /업계\s*1\s*위/,
  /100\s*%\s*검증/,
  /완벽(히|하게)?\s*신뢰/,
  /최고의?\s*전문가/,
  /유일(한)?\s*공인/,
  /\b(no\.?\s*1|number\s*one)\b/i,
];

export function findForbiddenClaim(text: string): string | null {
  for (const re of FORBIDDEN_CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** 저장된 배지 행 (DB badges). */
export interface BadgeRow {
  id: string;
  badgeType: string;
  publicLabel: string;
  method: VerificationMethod;
  scope: string;
  issuerName: string | null;
  status: "active" | "expired" | "revoked" | "disputed";
  verifiedAt: Date | string | null;
  expiresAt: Date | string | null;
  revokedAt?: Date | string | null;
}

/** 공개 응답에 들어가는 배지. 6필드가 모두 채워진 것만 만들 수 있다 (P-058). */
export interface PublicBadge {
  id: string;
  type: string;
  /** 사용자에게 보이는 라벨. disputed 면 "확인 필요"로 치환된다. */
  label: string;
  /** 검증 강도 코드와 한글 표기 — 색만으로 구분하지 않기 위해 둘 다 보낸다 (브랜드 §7). */
  method: VerificationMethod;
  methodLabel: string;
  scope: string;
  issuerName: string | null;
  verifiedAt: string;
  expiresAt: string | null;
  /** 분쟁 중임을 UI 가 알아야 중립적으로 그릴 수 있다 (N-14). */
  disputed: boolean;
}

/**
 * 배지 하나를 공개 형태로 바꾼다. 공개할 수 없으면 null.
 *
 * `null` 을 돌려주는 경우가 곧 정책이다:
 *   - 자기기재 (N-1)
 *   - 취소됨
 *   - 만료됨 (N-9 — 읽기 시점 판정)
 *   - 6필드 중 하나라도 빔 (P-058)
 *   - 발급기관을 요구하는 유형인데 발급기관이 없음
 */
export function toPublicBadge(
  b: BadgeRow,
  now: Date,
  opts: { requiresIssuer?: boolean } = {},
): PublicBadge | null {
  // N-1: 자기기재 배지는 존재해서도 안 되지만, 존재하더라도 공개하지 않는다.
  if (b.method === "self_declared") return null;

  if (b.status === "revoked" || b.revokedAt) return null;
  if (b.status === "expired") return null;
  if (isEffectivelyExpired(b.expiresAt, now)) return null;

  // P-058: 6필드 완결성. verifiedAt 이 없는 배지는 "언제 확인했는지"를 말할 수 없으므로 숨긴다.
  const verifiedAt = asIso(b.verifiedAt);
  if (!verifiedAt) return null;
  if (!b.publicLabel?.trim()) return null;
  if (!b.scope?.trim()) return null;
  if (opts.requiresIssuer && !b.issuerName?.trim()) return null;

  const disputed = b.status === "disputed";

  return {
    id: b.id,
    type: b.badgeType,
    // N-14: 분쟁 중에는 원래 라벨("현재 소속 확인")을 쓰지 않는다.
    label: disputed ? DISPUTED_LABEL_KO : b.publicLabel,
    method: b.method,
    methodLabel: METHOD_LABEL_KO[b.method],
    scope: b.scope,
    issuerName: b.issuerName?.trim() || null,
    verifiedAt,
    expiresAt: asIso(b.expiresAt),
    disputed,
  };
}

/**
 * 프로필의 공개 배지 목록. 숨겨야 할 것은 걸러지고 안정적인 순서로 정렬된다.
 *
 * 정렬 기준에 **강도를 쓰지 않는다** — 강도로 정렬하면 "강한 배지가 많은 사람이 위"라는
 * 암묵적 점수가 생기고 그것이 N-3(단일 신뢰점수 금지)의 실질적 위반이 된다.
 * 유형 순서는 기획서 §7 의 나열 순서를 고정 배열로 쓴다.
 */
const TYPE_ORDER: readonly string[] = [
  "identity",
  "affiliation",
  "license",
  "career",
  "product_training",
  "transaction_count",
  "response_time",
  "aftercare",
];

export function toPublicBadges(
  rows: readonly BadgeRow[],
  now: Date,
  issuerRequired: ReadonlySet<string> = new Set(),
): PublicBadge[] {
  const out: PublicBadge[] = [];
  for (const r of rows) {
    const p = toPublicBadge(r, now, { requiresIssuer: issuerRequired.has(r.badgeType) });
    if (p) out.push(p);
  }
  return out.sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a.type);
    const ib = TYPE_ORDER.indexOf(b.type);
    if (ia !== ib) return (ia < 0 ? TYPE_ORDER.length : ia) - (ib < 0 ? TYPE_ORDER.length : ib);
    return a.type.localeCompare(b.type);
  });
}

/**
 * N-2 (보안정책 §4.10): 배지 발급 자격.
 *
 * 이 함수의 인자에 **구독·결제·요금제가 없다는 것이 규칙 자체다.**
 * 누가 나중에 "Pro 전용 배지"를 만들려 하면 이 시그니처를 바꿔야 하고, 그 PR 은
 * `badge.test.ts` 의 N-2 테스트를 깨뜨린다.
 */
export function canIssueBadge(input: {
  verificationStatus: string;
  method: VerificationMethod;
  scope: string | null;
  verifiedAt: Date | null;
}): { ok: true } | { ok: false; code: string; message: string } {
  if (input.verificationStatus !== "verified") {
    return { ok: false, code: "not_verified", message: "검증이 완료되지 않았습니다." };
  }
  if (input.method === "self_declared") {
    return { ok: false, code: "self_declared_cannot_verify", message: "자기기재 항목은 배지를 받을 수 없습니다." };
  }
  if (!input.scope?.trim()) {
    return { ok: false, code: "scope_required", message: "검증 범위가 없습니다." };
  }
  if (!input.verifiedAt) {
    return { ok: false, code: "verified_at_required", message: "검증 기준일이 없습니다." };
  }
  return { ok: true };
}

function asIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
