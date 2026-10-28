/**
 * 공개 DTO allowlist — ADR-002 / N-4.
 *
 * 출처: 01_기술백서_시스템아키텍처.md §6 "공개 DTO는 공개 허용 필드의 명시적 allowlist로 구성"
 *       03_데이터모델_API명세.md §3 공개/비공개 경계
 *
 * 왜 블랙리스트가 아니라 allowlist 인가:
 *   블랙리스트는 **새 컬럼이 추가될 때마다 조용히 뚫린다.** 프로필에 `internal_note` 를
 *   하나 붙이는 마이그레이션이 공개 API 에 그 값을 흘려보낸다. allowlist 는 반대로
 *   새 컬럼이 기본적으로 비공개이고, 공개하려면 이 파일을 고쳐야 한다 — 리뷰가 걸린다.
 *
 * 그래서 이 모듈은 "거를 키 목록"이 아니라 "남길 키 목록"만 안다.
 */

/** 공개 프로필에 내보낼 수 있는 필드 (데이터모델 §3 "공개 가능 예"). */
export const PUBLIC_PROFILE_FIELDS = [
  "slug",
  "displayName",
  "headline",
  "bio",
  "specialties",
  "languages",
  "region",
  "publishedAt",
] as const;

/** 공개 상품 카드 (M06). 가격은 정책에 따라 이미 null 로 마스킹된 뒤 들어온다. */
export const PUBLIC_OFFER_FIELDS = [
  "id",
  "title",
  "description",
  "priceDisplayPolicy",
  "priceAmount",
  "priceCurrency",
  "externalUrl",
  "ownerType",
] as const;

/** 공개 지표 (N-8). 기간·표본·근거가 필수로 포함된다 — 수치만 떼서 보낼 수 없다. */
export const PUBLIC_METRIC_FIELDS = [
  "metricCode",
  "value",
  "unit",
  "periodStart",
  "periodEnd",
  "sampleSize",
  "basis",
  "verified",
] as const;

/**
 * **절대 공개되지 않아야 하는 키.** allowlist 가 이미 막지만, 이 목록은 테스트용 트립와이어다.
 * `assertNoPrivateKeys()` 가 응답 전체를 훑어 이 중 하나라도 있으면 던진다 —
 * allowlist 를 우회하는 경로(직접 JSON 조립 등)가 생겼을 때 테스트에서 터지게 하려는 것이다.
 */
export const NEVER_PUBLIC_KEYS: readonly string[] = [
  "email",
  "phone",
  "contactChannelEncrypted",
  "contactChannel",
  "reviewerNote",
  "reviewerId",
  "note",
  "objectKey",
  "evidenceId",
  "encryptionRef",
  "sha256",
  "tokenHash",
  "passwordHash",
  "legalIdentifierRef",
  "domainChallenge",
  "ipHash",
  "visitorHash",
  "retentionUntil",
  "internalNote",
  "accessPurpose",
  "userId",
  "assignedTo",
  // N-3: 단일 신뢰점수는 존재하지 않는다. 생겼다면 공개 경로에 들어가기 전에 터져야 한다.
  "trustScore",
  "score",
  "ranking",
  "completeness",
];

/**
 * 객체에서 allowlist 에 있는 키만 남긴다. 값이 `undefined` 인 키는 떨어진다.
 *
 * 중첩 객체는 다루지 않는다 — 의도적이다. 중첩을 허용하면 "어디까지 공개인가"가
 * 다시 불명확해진다. 중첩 구조는 각자의 `toPublicX()` 를 거쳐 조립한다.
 */
export function pickPublic<T extends object, K extends readonly (keyof T & string)[]>(
  src: T,
  fields: K,
): Pick<T, K[number]> {
  const out = {} as Pick<T, K[number]>;
  for (const k of fields) {
    const v = src[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * 응답 트리 전체를 재귀로 훑어 비공개 키가 섞였는지 확인한다.
 * 테스트와 (원하면) 개발 환경 런타임 가드에서 쓴다. 운영 핫패스에서는 호출하지 않는다.
 */
export function findPrivateKey(value: unknown, path = "$"): string | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findPrivateKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    if (NEVER_PUBLIC_KEYS.includes(k)) return `${path}.${k}`;
    const hit = findPrivateKey(v, `${path}.${k}`);
    if (hit) return hit;
  }
  return null;
}

export function assertNoPrivateKeys(value: unknown): void {
  const hit = findPrivateKey(value);
  if (hit) {
    throw new Error(`공개 응답에 비공개 키가 포함됐다 (전략 N-4 / ADR-002): ${hit}`);
  }
}

/**
 * 연락처 공개는 **별도 동의**가 있어야 한다 (기술백서 §6).
 * public_settings 의 플래그를 보고 공개할 값만 돌려준다. 기본값은 비공개다.
 */
export function publicContact(
  settings: Record<string, unknown> | null | undefined,
  contact: { email?: string | null; phone?: string | null },
): { email?: string; phone?: string } {
  const s = settings ?? {};
  const out: { email?: string; phone?: string } = {};
  if (s.showEmail === true && contact.email) out.email = contact.email;
  if (s.showPhone === true && contact.phone) out.phone = contact.phone;
  return out;
}
