/**
 * P-020: 프로필 slug 예약·정규화.
 *
 * 출처: proplus/docs/01_FEATURE_REGISTRY.yaml P-020
 *       "slug 는 예약어·중복·대소문자 혼동을 거부하고 소유자만 변경 가능"
 *       (소유자 판정은 acl.ts 의 `profile.edit`, 중복은 DB `profiles.slug UNIQUE`
 *        — 이 모듈은 **문자열 자체의 적격성**만 본다. I/O 금지.)
 *
 * 왜 "정규화 + 검증"을 두 함수로 쪼개는가:
 *   slug 는 공개 주소 `/p/{slug}` 의 일부이고, 한 사람이 다른 사람의 주소로 오인될 때
 *   PROPLUS 의 전제(= 이 프로필의 신뢰 표시는 이 사람의 것이다)가 깨진다.
 *   그래서 입력을 **먼저 한 가지 모양으로 접은 뒤**(normalize) 그 결과만 검증한다.
 *   검증 전에 접지 않으면 `API`·`ａｐｉ`(전각)·`Api` 가 각각 다른 문자열로 통과해
 *   예약어 검사와 UNIQUE 제약을 동시에 우회한다.
 */

/**
 * 라우트·정적 경로와 충돌하거나 플랫폼을 사칭할 수 있는 slug.
 *
 * CONTRACTS.md §slug.ts 의 목록 그대로이며, `next` 하나만 더 들어있다 —
 * `_next` 는 `normalizeSlug()` 를 거치면 `next` 가 되므로(밑줄→하이픈→양끝 제거)
 * 원형만 담아두면 실제로는 아무것도 막지 못한다. 막으려는 대상은 Next.js 의
 * `/_next/*` 경로이므로 접힌 모양도 함께 예약한다.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "app",
  "admin",
  "p",
  "login",
  "legal",
  "search",
  "assets",
  "_next",
  "next",
  "static",
  "health",
  "me",
  "about",
  "help",
  "proplus",
]);

/** 공개 주소에 쓰이므로 짧은 하한을 둔다 — 1~2자는 라우트 추가 시 충돌 위험이 크다. */
const MIN_LENGTH = 3;
const MAX_LENGTH = 40;

/**
 * 입력을 slug 한 가지 모양으로 접는다.
 *
 * NFKC 를 먼저 적용하는 이유: 전각 영문(`ＡＰＩ`)·호환 문자는 NFKC 에서 ASCII 로 접힌다.
 * 접지 않고 `[a-z0-9-]` 필터만 걸면 전각 문자가 전부 탈락해 빈 문자열이 되거나,
 * 일부만 남아 전혀 다른 slug 가 만들어진다.
 */
export function normalizeSlug(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_]+/g, "-") // 공백·밑줄은 구분자로 취급
    .replace(/[^a-z0-9-]+/g, "") // 허용 문자 밖은 삭제 (하이픈으로 바꾸지 않는다 — 글자 수를 늘리지 않으려고)
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type SlugResult = { ok: true; slug: string } | { ok: false; code: string; message: string };

/**
 * 정규화한 뒤 적격성을 판정한다. 성공 시 **정규화된 값**을 돌려주므로
 * 호출부는 반드시 반환된 `slug` 를 저장해야 한다(입력 원문을 저장하면 안 된다).
 */
export function validateSlug(raw: string): SlugResult {
  const slug = normalizeSlug(raw);

  // 정규화 후 빈 문자열 = 허용 문자가 없었거나 전부 하이픈이었던 경우.
  if (slug.length === 0) {
    return { ok: false, code: "slug_empty", message: "주소에 사용할 수 있는 문자가 없습니다. 영문 소문자·숫자·하이픈을 사용하세요." };
  }
  if (slug.length < MIN_LENGTH) {
    return { ok: false, code: "slug_too_short", message: `주소는 ${MIN_LENGTH}자 이상이어야 합니다.` };
  }
  if (slug.length > MAX_LENGTH) {
    return { ok: false, code: "slug_too_long", message: `주소는 ${MAX_LENGTH}자 이하여야 합니다.` };
  }
  // 숫자만인 slug 는 내부 식별자(ID)로 오인되고, 나중에 `/p/123` 형태의 ID 경로를
  // 열어야 할 때 되돌릴 수 없는 충돌이 된다.
  if (/^[0-9]+$/.test(slug)) {
    return { ok: false, code: "slug_numeric_only", message: "주소를 숫자만으로 만들 수 없습니다." };
  }
  // `xn--` 는 punycode 접두사다. 허용하면 디코딩된 유니코드 도메인/주소로 보이게 만들어
  // 다른 전문가를 사칭할 수 있다(호모그래프).
  //
  // 판정 대상이 `slug` 가 아니라 **입력 원문**인 이유: `normalizeSlug()` 가 연속 하이픈을
  // 접으므로 `xn--abc` 는 정규화 뒤 `xn-abc` 가 되어 접두사가 사라진다. 정규화 결과만 보면
  // 이 검사는 영원히 통과하지 못하는 죽은 코드가 된다.
  if (/^xn--/.test(raw.normalize("NFKC").trim().toLowerCase())) {
    return { ok: false, code: "slug_punycode", message: "'xn--' 로 시작하는 주소는 사용할 수 없습니다." };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, code: "slug_reserved", message: "이미 예약된 주소입니다. 다른 주소를 입력하세요." };
  }

  return { ok: true, slug };
}
