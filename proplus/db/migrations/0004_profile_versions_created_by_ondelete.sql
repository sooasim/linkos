-- 0004: profile_versions.created_by 가 사용자 삭제를 막지 않게 한다.
--
-- 왜: 0001_proplus_core.sql §M02 는 profile_versions.created_by 를 ON DELETE 절 **없이** 걸었다
-- (`created_by uuid REFERENCES users(id)`). 그래서 버전 스냅샷을 만든 사용자를 지우려 하면
-- 23503(foreign key violation, constraint profile_versions_created_by_fkey)으로 막힌다 —
-- 계정 삭제(P-011)·통합테스트 teardown(DELETE FROM users)이 그 사용자를 지우지 못하고,
-- 직렬로 같은 DB 를 쓰는 통합테스트에서는 한 teardown 실패가 다음 스위트의 데이터까지 오염시킨다.
--
-- 0003_linkos_integration.sql 의 같은 성격 컬럼(sso 쪽 created_by)은 이미 ON DELETE SET NULL 이다.
-- 그 선택과 일치시킨다: 버전 **이력 자체는 남기고**(복원·감사에 필요하다) 작성자 참조만 비운다.
-- CASCADE 로 스냅샷을 지우지 않는 이유 — 복원 기능(P-028)이 과거 버전을 잃으면 안 된다.
--
-- 원본 테이블을 고치지 않고 제약만 교체한다(proplus/CLAUDE.md §1 "추가만 한다").
-- created_by 는 nullable 이므로 SET NULL 이 가능하다.

ALTER TABLE profile_versions DROP CONSTRAINT IF EXISTS profile_versions_created_by_fkey;

ALTER TABLE profile_versions
  ADD CONSTRAINT profile_versions_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
