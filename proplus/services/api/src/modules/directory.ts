/**
 * 디렉터리 조회 — LINKOS 가 "내가 아는 이메일의 PROPLUS 검증 배지"를 묻는 경로.
 * 근거: `docs/05_LINKOS_INTEGRATION.md` §3 / ADR-012.
 *
 * ## 이 모듈이 지키는 것
 *
 * 1. **서버가 입력 해시를 만들지 않는다.** 들어온 해시와 **내 쪽 사용자 이메일의 해시**를 대조할 뿐이다.
 *    평문 이메일이 요청·로그·에러 메시지 어디에도 등장하지 않는다(N-13).
 * 2. **소유자가 켠 프로필만 대상이다** (`public_settings.allowDirectoryLookup = true`, 기본 꺼짐).
 *    이것이 05 §3 의 첫 번째 겹이고, 켜지 않은 사람은 **조회 자체의 대상이 아니다** —
 *    "있지만 숨김"이 아니라 비교 집합에 들어오지 않는다.
 * 3. **배지는 `public_badge_view` 에서만 읽는다.** 만료·취소·자기기재는 뷰가 이미 걸렀고(N-9/N-1),
 *    `toPublicBadges()` 가 공개 형태로 **재조립**한다(N-4: allowlist 밖 키가 응답 객체에 존재할 수 없다).
 * 4. **찾지 못한 해시는 응답에 넣지 않는다** (05 §3). 없음을 명시하면 그게 곧 존재 확인 오라클이다.
 * 5. **`disputed` 를 그대로 내보낸다** (N-14). LINKOS 가 "확인 필요"로 그릴 수 있어야 하고,
 *    라벨 교체는 `toPublicBadge()` 가 이미 해 둔다.
 *
 * ## 한 방향 규칙 (05 §0)
 *
 * 검증된 사실은 PROPLUS → LINKOS 로만 흐른다. 이 모듈에는 LINKOS 로 보내는 호출도,
 * LINKOS 의 관계 점수를 받아들이는 입력도 없다 — 읽기 전용 조회 하나뿐이다.
 */

import {
  type PublicBadge,
  emailLookupHash,
  toPublicBadges,
  type VerificationMethod,
} from "@proplus/domain";
import { q } from "../lib/db";
import { unavailable } from "../lib/errors";

export interface LookupResult {
  /** 호출자가 보낸 해시를 그대로 되돌려준다 — 요청과 응답을 대조할 열쇠다. */
  emailHash: string;
  slug: string;
  displayName: string;
  badges: PublicBadge[];
  /** 절대 주소. LINKOS 가 "출처가 PROPLUS 임을 밝힌다"(05 §3)를 지킬 수 있어야 한다. */
  profileUrl: string;
}

/**
 * 해시 목록으로 공개 배지를 찾는다.
 *
 * @param hashes `validateLookupRequest()` 를 통과한 정규화된 해시 (최대 50개)
 * @param now 만료 판정 기준 시각. 도메인이 `Date.now()` 를 쓰지 않으므로 호출부가 넘긴다(N-9).
 */
export async function lookupBadgesByEmailHash(hashes: string[], now: Date): Promise<LookupResult[]> {
  if (hashes.length === 0) return [];
  const salt = directorySalt();

  /**
   * opt-in 한 프로필의 소유자 이메일만 가져온다.
   *
   * **공개 가능 여부는 `public_profile_view` 가 판정한다** — 미발행·정지·삭제 계정이 여기서
   * 걸러진다(N-4/ADR-002). `profiles` 를 조인하는 것은 공개 필드를 꺼내려는 것이 아니라
   * (a) opt-in 플래그와 (b) 소유자(user_id) 를 알기 위해서다. 뷰에는 둘 다 없고, 둘 다 공개되지 않는다.
   *
   * `= 'true'` 로 **문자열 비교**하는 이유: jsonb 를 boolean 으로 캐스팅하면 누군가 그 키에
   * 문자열을 넣었을 때 쿼리 전체가 캐스팅 오류로 죽는다(조회 한 건이 아니라 기능이 죽는다).
   * 0003 주석의 "키가 없으면 열리지 않는다"와 같은 방향이고, 정확히 true 만 연다.
   */
  const owners = await q<{ profile_id: string; slug: string; display_name: string; email: string }>(
    `SELECT v.id AS profile_id, v.slug, v.display_name, u.email
       FROM public_profile_view v
       JOIN profiles p ON p.id = v.id
       JOIN users u    ON u.id = p.user_id
      WHERE p.public_settings->>'allowDirectoryLookup' = 'true'
        AND u.email IS NOT NULL
        AND u.email <> ''`,
  );

  /**
   * 해시 비교를 **애플리케이션에서** 한다.
   *
   * 왜 SQL 의 digest() 가 아닌가: 해시 공식(05 §3)이 두 곳에 생기면 한쪽만 바뀌는 날이 오고,
   * 그 고장은 "매칭이 0" 이라 조용하다. `emailLookupHash()` 하나만 쓰면 그 길이 없다.
   *
   * TODO(05 §3): opt-in 프로필 수가 커지면 요청마다 전체를 해시하게 된다. 그때는
   * `users` 에 `email_lookup_hash` 컬럼 + 인덱스를 두는 마이그레이션이 필요하다(솔트 회전 시
   * 재계산 배치도 함께). 지금 넣지 않는 이유는 opt-in 기본값이 꺼짐이라 집합이 작고,
   * 해시 컬럼은 "조회 가능한 이메일 지문"을 DB 에 상주시키는 선택이라 근거가 더 필요하기 때문이다.
   */
  const wanted = new Set(hashes);
  const matched = new Map<string, { profileId: string; slug: string; displayName: string }>();
  for (const o of owners) {
    const h = emailLookupHash(o.email, salt);
    if (!wanted.has(h) || matched.has(h)) continue;
    matched.set(h, { profileId: o.profile_id, slug: o.slug, displayName: o.display_name });
  }
  // 매칭이 없으면 배지 쿼리도 돌리지 않는다. 없음을 응답으로 알려 주지 않는다(05 §3).
  if (matched.size === 0) return [];

  const profileIds = [...matched.values()].map((m) => m.profileId);

  const [badgeRows, issuerTypes] = await Promise.all([
    q<{
      id: string;
      profile_id: string;
      badge_type: string;
      public_label: string;
      method: VerificationMethod;
      scope: string;
      issuer_name: string | null;
      verified_at: Date | null;
      expires_at: Date | null;
      status: string;
    }>(
      `SELECT id, profile_id, badge_type, public_label, method, scope, issuer_name, verified_at, expires_at, status
         FROM public_badge_view
        WHERE profile_id = ANY($1::uuid[])`,
      [profileIds],
    ),
    // 발급기관이 필수인 유형은 발급기관이 비면 배지를 숨긴다 (P-058). 공개 프로필과 같은 판정이어야 한다.
    q<{ code: string }>(`SELECT code FROM evidence_types WHERE requires_issuer = true`),
  ]);

  const issuerRequired = new Set(issuerTypes.map((r) => r.code));
  const byProfile = new Map<string, typeof badgeRows>();
  for (const b of badgeRows) {
    const list = byProfile.get(b.profile_id);
    if (list) list.push(b);
    else byProfile.set(b.profile_id, [b]);
  }

  const origin = appOrigin();
  const out: LookupResult[] = [];
  // 입력 순서대로 돌려준다. 매칭되지 않은 해시는 건너뛴다 — 그 자리가 비는 것이 유일한 신호다.
  for (const hash of hashes) {
    const m = matched.get(hash);
    if (!m) continue;
    out.push({
      emailHash: hash,
      slug: m.slug,
      displayName: m.displayName,
      badges: toPublicBadges(
        (byProfile.get(m.profileId) ?? []).map((b) => ({
          id: b.id,
          badgeType: b.badge_type,
          publicLabel: b.public_label,
          method: b.method,
          scope: b.scope,
          issuerName: b.issuer_name,
          status: toBadgeStatus(b.status),
          verifiedAt: b.verified_at,
          expiresAt: b.expires_at,
        })),
        now,
        issuerRequired,
      ),
      profileUrl: `${origin}/p/${m.slug}`,
    });
  }
  return out;
}

/**
 * `public_badge_view` 의 status 를 도메인 타입으로 좁힌다.
 *
 * 뷰는 `('active','disputed')` 만 통과시키지만, 컬럼 타입은 text 다. 모르는 값이 오면
 * `active` 로 올려 주지 않고 `disputed` 로 떨어뜨린다 — 알 수 없는 상태를 "확인됨"으로
 * 보여주는 것이 N-14 가 막으려는 실수이고, fail-closed 쪽이 맞다.
 */
function toBadgeStatus(raw: string): "active" | "disputed" {
  return raw === "active" ? "active" : "disputed";
}

/**
 * 해시 솔트 (05 §5 `DIRECTORY_SALT` — 양쪽 env 에 같은 값).
 *
 * 비면 503 으로 **이 연동만** 끊는다. 05 §5 의 "비면 조용히 꺼진다"는 PROPLUS 핵심
 * (검증·공개 프로필·상담)이 LINKOS 없이 동작해야 한다는 뜻이고, 이 라우트 하나가 503 인 것은
 * 그 뜻에 맞다. 빈 배열을 돌려주지 **않는** 이유: 그건 "아무도 PROPLUS 에 없다"는 거짓이고,
 * 설정 누락이 영구히 눈에 띄지 않는다.
 */
function directorySalt(): string {
  const salt = process.env.DIRECTORY_SALT;
  if (!salt) {
    throw unavailable("directory_disabled", "디렉터리 조회 연동이 설정되지 않았습니다.");
  }
  return salt;
}

/** 공개 프로필 절대 주소의 출처 (.env.example APP_ORIGIN). 운영은 https://proplus.ckp.kr */
function appOrigin(): string {
  return process.env.APP_ORIGIN ?? "http://localhost:4400";
}
