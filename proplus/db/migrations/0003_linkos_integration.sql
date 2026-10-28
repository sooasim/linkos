-- PROPLUS 0003 — LINKOS 연동 (ADR-012 / docs/05_LINKOS_INTEGRATION.md)
--
-- 격리는 그대로다: 여기 추가되는 것은 **PROPLUS 쪽 테이블**뿐이고 LINKOS DB 를 참조하지 않는다.
-- 오가는 것은 HTTP 계약 3개(SSO assertion · ext/leads 호출 · ext/badges/lookup)뿐이다.

-- ─────────────────────────────────────────────────────────────────────────────
-- ① 단일 로그인 — LINKOS 가 신원 제공자
-- ─────────────────────────────────────────────────────────────────────────────

-- 계정 연결. 이메일이 같으면 기존 계정에 붙이고, 없으면 새로 만든다.
ALTER TABLE users ADD COLUMN linkos_user_id text;

-- 연결 식별용이지 권한 근거가 아니다. 한 LINKOS 계정이 두 PROPLUS 계정에 붙는 것만 막는다.
CREATE UNIQUE INDEX users_linkos_user_id_key ON users (linkos_user_id) WHERE linkos_user_id IS NOT NULL;

-- `auth_provider` 는 0001 에서 text 다. 'linkos' 가 새 값으로 들어간다(제약 없음 — 확인만).
COMMENT ON COLUMN users.linkos_user_id IS
  'LINKOS 신원 제공자의 sub. 연결 식별용이며 권한 근거로 쓰지 않는다 (05_LINKOS_INTEGRATION §1).';

/**
 * SSO assertion 재생 방지 (1회성).
 *
 * assertion 은 60초만 유효하지만, 그 안에 같은 토큰이 두 번 쓰이면 안 된다
 * (리다이렉트 URL 이 로그·히스토리·Referer 에 남을 수 있다).
 * `jti` 를 UNIQUE 로 두고 INSERT 가 실패하면 거부한다 — 애플리케이션 검사보다 확실하다.
 */
CREATE TABLE sso_assertions (
  jti        text PRIMARY KEY,
  issuer     text NOT NULL,
  subject    text NOT NULL,
  used_at    timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- 만료된 행은 워커가 지운다. 인덱스가 없으면 그 삭제가 전체 스캔이 된다.
CREATE INDEX sso_assertions_expiry_idx ON sso_assertions (expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- ② 배지 조회용 API 키 (LINKOS → PROPLUS)
--
-- LINKOS 의 `api_keys` 와 같은 모양으로 둔다(해시 저장·스코프·폐기·만료).
-- 같은 설계를 두 번 발명하지 않으려는 것이고, 운영자가 두 제품에서 같은 방식으로 다룰 수 있다.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 키 원문은 저장하지 않는다. prefix 는 UI·로그에서 어느 키인지 가리키는 용도다.
  prefix      text NOT NULL,
  key_hash    text NOT NULL UNIQUE,
  label       text NOT NULL,
  scopes      text[] NOT NULL DEFAULT '{}',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at  timestamptz,
  revoked_at  timestamptz
);

CREATE INDEX api_keys_active_idx ON api_keys (prefix) WHERE revoked_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- ③ 공개 설정 두 개 — 둘 다 **기본 꺼짐**
--
-- 0001 의 `profiles.public_settings` jsonb 에 들어간다. 컬럼을 추가하지 않는 이유:
-- 공개 설정은 개수가 늘어나는 성격이고, 늘 때마다 마이그레이션을 요구하면
-- 설정 추가가 배포 일정에 묶인다. 대신 **기본값이 꺼짐**이라는 것이 중요하다 —
-- jsonb 에 키가 없으면 `publicContact()` 처럼 `=== true` 로만 열린다.
--
--   linkosSync           상담 리드를 LINKOS 연락처로 전달 (§2)
--   allowDirectoryLookup 이메일 해시로 내 배지를 조회당할 수 있게 허용 (§3)
--
-- 기존 행에 키를 미리 넣지 않는다. 넣으면 "꺼짐을 선택했다" 와 "아직 모른다" 가 구분되지 않는다.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- ④ 연동 전달 기록 — 멱등성의 근거
--
-- outbox 소비자가 같은 리드를 두 번 보내지 않게 한다(P-184). 애플리케이션 재시도,
-- 워커 재시작, 중복 이벤트 어느 쪽이든 여기 행이 있으면 건너뛴다.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE integration_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target        text NOT NULL,              -- 'linkos'
  kind          text NOT NULL,              -- 'lead'
  source_id     uuid NOT NULL,              -- leads.id
  remote_id     text,                       -- LINKOS 가 돌려준 id (있으면)
  status        text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'skipped')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 같은 대상에 같은 리드를 두 번 보내지 않는다.
  UNIQUE (target, kind, source_id)
);

CREATE INDEX integration_deliveries_source_idx ON integration_deliveries (kind, source_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- ⑤ `consent_purpose` 에 'integration' 을 **더하지 않는다**
--
-- 처음에는 더하려 했다. 틀린 설계다: 리드 전달은 **프로필 소유자의 결정**(opt-in)이지
-- 상담을 남긴 사람이 준 동의가 아니다. 그것을 `consent_records` 에 쓰면
-- **받지 않은 동의를 받았다고 기록**하는 것이고, 그건 N-11 이 막으려는 바로 그 종류의 거짓이다.
--
-- 전달 사실은 동의가 아니라 **처리 기록**이므로 두 곳에 남는다:
--   `audit_logs`  — `integration.lead_forwarded` (누가·언제·무엇을)
--   `integration_deliveries` — 멱등성 근거 (위 ④)
--
-- 상담을 남긴 사람에게는 **동의를 더 받는 대신 사실을 알린다** —
-- 개인정보 처리 안내에 "담당자가 연동을 켜 두면 담당자의 연락처 관리 도구로 전달된다" 를 적는다.
-- (ALTER TYPE ADD VALUE 는 되돌릴 수 없으므로 더하지 않은 것이 운영상으로도 안전하다.)
-- ─────────────────────────────────────────────────────────────────────────────
