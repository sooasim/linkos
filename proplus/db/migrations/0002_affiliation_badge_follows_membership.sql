-- PROPLUS 0002 — 소속 배지는 소속을 따라간다 (P-085 / N-9 / N-12)
--
-- ## 고치는 것
--
-- 원장 P-085 의 수용 기준은 "`ended_at` 이 지나면 **읽기 시점에** 소속 배지가 비활성이다" 인데,
-- 0001 의 `public_badge_view` 는 `badges.expires_at` 만 본다. 그래서 다음이 가능했다:
--
--   직원이 퇴사한다 → 조직 관리자가 `revokeMembership` 을 **부르지 않는다**(또는 늦게 부른다)
--   → `memberships.ended_at` 은 지났는데 `badges.expires_at`(기본 365일)은 아직 남아 있다
--   → 공개 프로필에 "현재 소속 확인" 이 **최대 1년** 더 떠 있다.
--
-- 이것은 단순 지연이 아니라 **거짓**이다. 배지 문구가 "현재 소속" 이고(브랜드 §5),
-- 그 회사 이름을 보고 상담을 요청하는 사람이 생긴다. N-9 가 만료를 읽기 시점에 판정하라고
-- 요구하는 이유가 정확히 이것이다 — 배치나 사람의 호출에 신뢰 정보를 의존시키지 않는다.
--
-- ## 왜 워커가 아니라 뷰인가
--
-- 워커로 "소속 끝난 배지 만료 처리" 를 돌릴 수도 있다. 그러면 워커가 도는 주기만큼 거짓이 남고,
-- 워커가 죽은 동안에는 영원히 남는다. 뷰에서 걸러내면 **조회가 곧 판정**이라 지연이 0 이다.
-- 워커는 알림 같은 되돌릴 수 있는 일에만 쓴다(P-060 과 같은 분담).
--
-- ## 적용 범위
--
-- `affiliation` 유형에만 적용한다. 다른 배지(본인확인·자격·경력)는 소속과 무관하고,
-- 조건을 전체에 걸면 소속이 없는 개인의 배지가 전부 사라진다.
--
-- 0001 의 테이블·제약은 건드리지 않는다. 뷰만 교체한다 (CLAUDE.md §1 "추가만 한다").

CREATE OR REPLACE VIEW public_badge_view AS
SELECT
  b.id,
  b.profile_id,
  b.badge_type,
  b.public_label,
  b.method,
  b.scope,
  b.issuer_name,
  b.verified_at,
  b.expires_at,
  b.status
FROM badges b
WHERE b.revoked_at IS NULL
  AND b.status IN ('active', 'disputed')
  AND (b.expires_at IS NULL OR b.expires_at > now())
  AND b.method <> 'self_declared'
  AND b.public_label <> ''
  AND b.scope <> ''
  AND b.verified_at IS NOT NULL
  -- P-085: 소속 배지는 **지금 유효한 소속**이 있을 때만 공개된다.
  --
  -- 경로: badge → verification → evidence(organization_id) + profile(user_id) → membership.
  -- `evidence.organization_id` 가 NULL 인 소속 배지는 근거 조직을 특정할 수 없으므로 공개하지 않는다
  -- (EXISTS 가 거짓이 되어 자동으로 걸러진다 — 명시적으로 열어 주지 않는 쪽이 안전하다).
  AND (
    b.badge_type <> 'affiliation'
    OR EXISTS (
      SELECT 1
        FROM verifications v
        JOIN evidence e   ON e.id = v.evidence_id
        JOIN profiles  p  ON p.id = b.profile_id
        JOIN memberships m ON m.organization_id = e.organization_id
                          AND m.user_id = p.user_id
       WHERE v.id = b.verification_id
         AND m.status = 'active'
         AND (m.ended_at IS NULL OR m.ended_at > now())
    )
  );

-- 위 EXISTS 가 매 공개 조회마다 돈다. 공개 프로필 p95 목표(P-194)를 지키려면 인덱스가 필요하다.
-- `memberships(organization_id, user_id)` 는 이미 UNIQUE 제약이 덮지만, 활성 여부까지 함께 보는
-- 부분 인덱스를 두어 활성 행만 스캔하게 한다.
CREATE INDEX IF NOT EXISTS memberships_active_lookup
  ON memberships (organization_id, user_id)
  WHERE status = 'active';

-- 조직 증거를 organization_id 로 되짚는 경로도 인덱스가 없었다.
CREATE INDEX IF NOT EXISTS evidence_organization_idx
  ON evidence (organization_id)
  WHERE organization_id IS NOT NULL;
