-- PROPLUS 0001 — core schema
--
-- 출처: dd/PROPLUS_Technical_Document_Set/03_데이터모델_API명세.md §1 핵심 엔터티
--       + 04_보안_개인정보_신뢰정책.md §4 증거 검증 정책
--       + 01_기술백서_시스템아키텍처.md §3 Data / §5 멀티테넌시
--
-- 이 파일의 설계 의도: 전략 문서 §2 의 비타협 원칙 중 **애플리케이션이 깜빡해도 깨지면 안 되는 것**을
-- CHECK 제약 · 트리거 · 뷰로 내려 박는다. 주석에 N-번호로 어느 원칙인지 적었다.
--
-- 데이터베이스는 LINKOS 와 분리된 `proplus` 다 (전략 §1). schema_migrations 도 이 DB 의 것이다.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- P-122 예약 겹침 배타 제약
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- P-150 검색 폴백 (Meilisearch 실사 전)

-- ─────────────────────────────────────────────────────────────────────────────
-- 열거형
-- ─────────────────────────────────────────────────────────────────────────────

-- 보안정책 §4.1 — 검증 강도. self_declared 는 배지를 받을 수 없다 (N-1).
CREATE TYPE verification_method AS ENUM ('self_declared', 'document_reviewed', 'issuer_confirmed', 'system_integrated');

-- 데이터모델 §1 Verification / 모듈명세 M04 상태 머신
CREATE TYPE proof_status AS ENUM ('submitted', 'under_review', 'needs_more_info', 'verified', 'rejected', 'expired', 'revoked', 'disputed');

-- 기획서 §5-4 "명확한 출처" — 사용자 기재 / 플랫폼 검증 / 회사 발급 / 제3자 발급
CREATE TYPE evidence_source AS ENUM ('user', 'platform', 'organization', 'third_party');

-- 보안정책 §3 목적 제한 — 상담처리 동의와 마케팅 동의를 분리한다 (N-11)
CREATE TYPE consent_purpose AS ENUM ('service', 'privacy', 'marketing', 'verification', 'recording');

CREATE TYPE member_role AS ENUM ('member', 'manager', 'owner');
CREATE TYPE lead_stage AS ENUM ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost');
CREATE TYPE offer_owner AS ENUM ('profile', 'organization');
CREATE TYPE price_policy AS ENUM ('shown', 'inquiry', 'hidden');

-- ─────────────────────────────────────────────────────────────────────────────
-- M01 Identity & Access
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text UNIQUE,
  phone          text,
  auth_provider  text NOT NULL DEFAULT 'email',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  -- 운영 역할. 개인/조직 역할은 memberships 에 있고, 여기 있는 것은 플랫폼 역할이다 (M12 최소권한).
  platform_role  text NOT NULL DEFAULT 'none' CHECK (platform_role IN ('none', 'reviewer', 'admin')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  deleted_at     timestamptz
);

-- 보안정책 §2 계정 탈취 — 토큰은 해시로만 저장한다. 평문은 DB 에 들어오지 않는다.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  user_agent   text,
  kind         text NOT NULL DEFAULT 'web' CHECK (kind IN ('web', 'native')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 보안정책 §3 / 모듈명세 M01 — 동의는 종류별로 분리 기록하고 policy_version 을 함께 남긴다 (N-11).
CREATE TABLE consent_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  -- 비회원(공개 상담 폼) 동의는 user_id 가 없다. 그래서 subject_ref 로 리드를 가리킨다.
  subject_ref    text,
  purpose        consent_purpose NOT NULL,
  granted        boolean NOT NULL,
  policy_version text NOT NULL,
  ip_hash        text,      -- N-13: 원문 IP 금지
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR subject_ref IS NOT NULL)
);
CREATE INDEX consent_user_idx ON consent_records(user_id, purpose);
CREATE INDEX consent_subject_idx ON consent_records(subject_ref) WHERE subject_ref IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- M05 Organization & Affiliation
--   N-12: 조직은 개인 프로필을 소유하지 않는다. 조직은 memberships 로만 관여한다.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE organizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  slug                  text NOT NULL UNIQUE,
  verified_domain       text,
  domain_verified_at    timestamptz,
  domain_challenge      text,
  legal_identifier_ref  text,       -- 사업자번호 원문이 아니라 외부 참조 키 (데이터모델 §1)
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- P-081: 도메인은 검증된 뒤에만 소속 배지의 근거가 된다. 검증 시각 없이 도메인만 채우는 것을 막는다.
ALTER TABLE organizations ADD CONSTRAINT org_domain_verified_pair
  CHECK (domain_verified_at IS NULL OR verified_domain IS NOT NULL);

CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            member_role NOT NULL DEFAULT 'member',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  started_at      timestamptz,
  ended_at        timestamptz,
  verified_by     uuid REFERENCES users(id),
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id) WHERE status = 'active';

CREATE TABLE org_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           text NOT NULL,
  role            member_role NOT NULL DEFAULT 'member',
  token_hash      text NOT NULL UNIQUE,
  invited_by      uuid NOT NULL REFERENCES users(id),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- M02 Profile & Personal Brand
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug          text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  headline      text,
  bio           text,
  specialties   text[] NOT NULL DEFAULT '{}',
  languages     text[] NOT NULL DEFAULT '{}',
  region        text,
  -- 데이터모델 §7-1 미결정: "개인 계정의 복수 프로필 허용 여부".
  -- 스키마는 1:N 이지만 아래 UNIQUE 로 1개로 묶어 둔다. 정책이 정해지면 이 인덱스만 드롭한다.
  public_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at  timestamptz,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX profiles_one_per_user ON profiles(user_id);

CREATE TABLE profile_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  version    integer NOT NULL,
  snapshot   jsonb NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, version)
);

-- M03 미니사이트. N-10: 임의 HTML 문자열 컬럼이 없다. 블록은 schema allowlist 를 통과한 jsonb 다.
CREATE TABLE profile_blocks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  position   integer NOT NULL,
  props      jsonb NOT NULL DEFAULT '{}'::jsonb,
  visible    boolean NOT NULL DEFAULT true,
  UNIQUE (profile_id, position) DEFERRABLE INITIALLY DEFERRED
);

-- 경력/학력 등 자기기재 항목. provenance 를 항상 들고 다닌다 (기획서 §5-4, N-1).
CREATE TABLE profile_facts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('career', 'education', 'certification', 'skill', 'award')),
  label         text NOT NULL,
  detail        text,
  started_on    date,
  ended_on      date,
  -- 이 항목이 검증된 것인지. NULL 이면 자기기재이며 공개 시 "자기기재"로 표기한다.
  verification_id uuid,
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- M04 Proof Engine — 핵심
--   N-5: 증거 원본(evidence_files)과 공개 배지(badges)를 분리 저장한다 (ADR-004).
-- ─────────────────────────────────────────────────────────────────────────────

-- P-050: 증거 유형을 코드 enum 이 아니라 참조 테이블로 둔다.
-- 근거: 첫 파일럿 직군이 미정이라(미결정 §2) 유형이 바뀐다. 마이그레이션 없이 추가 가능해야 한다.
CREATE TABLE evidence_types (
  code             text PRIMARY KEY,
  label_ko         text NOT NULL,
  -- 이 유형이 받을 수 있는 최대 강도. 예: 'identity' 는 document_reviewed 이상을 요구할 수 있다.
  min_method       verification_method NOT NULL DEFAULT 'document_reviewed',
  -- 공개 배지 라벨. 브랜드 §5 의 문구를 그대로 쓴다.
  badge_label_ko   text NOT NULL,
  requires_issuer  boolean NOT NULL DEFAULT false,
  default_ttl_days integer,
  active           boolean NOT NULL DEFAULT true
);

-- 발급기관. 보안정책 §4.4 — 발급기관의 신뢰와 발급 권한을 확인한 기록이 있어야 issuer_confirmed 를 쓴다.
CREATE TABLE issuers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('government', 'association', 'company', 'school', 'platform')),
  organization_id    uuid REFERENCES organizations(id) ON DELETE SET NULL,
  -- 발급 권한을 확인한 기록. 없으면 issuer_confirmed 를 쓸 수 없다 (P-072).
  authority_checked_at timestamptz,
  authority_note     text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evidence (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type     text NOT NULL CHECK (subject_type IN ('profile', 'organization')),
  subject_id       uuid NOT NULL,
  -- 어느 테넌트의 것인지 (기술백서 §5). 개인 증거는 organization_id 가 NULL 이다.
  organization_id  uuid REFERENCES organizations(id) ON DELETE SET NULL,
  evidence_type    text NOT NULL REFERENCES evidence_types(code),
  issuer_id        uuid REFERENCES issuers(id) ON DELETE SET NULL,
  source_type      evidence_source NOT NULL,
  source_reference text,
  claim            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 사용자가 주장하는 내용 (검증 대상)
  status           proof_status NOT NULL DEFAULT 'submitted',
  submitted_by     uuid REFERENCES users(id),
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  retention_until  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_subject_idx ON evidence(subject_type, subject_id);
CREATE INDEX evidence_queue_idx ON evidence(status, submitted_at) WHERE status IN ('submitted', 'under_review', 'needs_more_info');

-- N-5: 증거 원본. 공개 조회 경로는 이 테이블을 조인하지 않는다.
CREATE TABLE evidence_files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id    uuid NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  object_key     text NOT NULL,
  content_type   text NOT NULL,
  byte_size      bigint NOT NULL CHECK (byte_size > 0),
  sha256         text NOT NULL,
  -- 저장 암호화 (보안정책 §3). 키 참조만 두고 키 자체는 secret manager 에 있다.
  encryption_ref text,
  scan_status    text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'skipped')),
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX evidence_files_evidence_idx ON evidence_files(evidence_id);

CREATE TABLE verifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id    uuid NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  method         verification_method NOT NULL,
  reviewer_id    uuid REFERENCES users(id),
  status         proof_status NOT NULL,
  scope          text,
  verified_at    timestamptz,
  expires_at     timestamptz,
  reason_code    text,
  policy_version text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- N-1 (보안정책 §4.2): 자기기재는 절대 verified 가 될 수 없다.
  -- 애플리케이션 전이 함수와 **이중으로** 막는다. 어느 한쪽이 틀려도 DB 가 거부한다.
  CONSTRAINT verification_self_declared_never_verified
    CHECK (NOT (method = 'self_declared' AND status = 'verified')),

  -- 보안정책 §4.3: verified 에는 범위와 기준일이 필수다.
  CONSTRAINT verification_verified_needs_scope_and_date
    CHECK (status <> 'verified' OR (scope IS NOT NULL AND verified_at IS NOT NULL)),

  -- 데이터모델 §4: 반려에는 사유 코드가 필수다.
  CONSTRAINT verification_rejected_needs_reason
    CHECK (status <> 'rejected' OR reason_code IS NOT NULL),

  -- P-061: 취소에도 사유 코드가 필요하다.
  CONSTRAINT verification_revoked_needs_reason
    CHECK (status <> 'revoked' OR reason_code IS NOT NULL)
);
CREATE INDEX verifications_evidence_idx ON verifications(evidence_id, created_at DESC);

-- P-164: 검증자 내부 메모. 당사자·공개 프로필에 절대 노출되지 않는다.
CREATE TABLE verification_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id uuid NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
  reviewer_id     uuid NOT NULL REFERENCES users(id),
  note            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- P-063: 이의제기 (보안정책 §4.6)
CREATE TABLE appeals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id uuid NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
  submitted_by    uuid NOT NULL REFERENCES users(id),
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'overturned', 'withdrawn')),
  resolution      text,
  resolved_by     uuid REFERENCES users(id),
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- N-5 / ADR-004: 공개 배지. 증거 원본을 참조하지 않는다 — verification 만 가리킨다.
CREATE TABLE badges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  badge_type      text NOT NULL REFERENCES evidence_types(code),
  verification_id uuid NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
  public_label    text NOT NULL,
  -- 공개 6필드 (P-058). 하나라도 비면 렌더러가 숨긴다.
  method          verification_method NOT NULL,
  scope           text NOT NULL,
  issuer_name     text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked', 'disputed')),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz NOT NULL,
  expires_at      timestamptz,
  revoked_at      timestamptz,

  -- N-1: 자기기재 배지는 존재할 수 없다. verifications 의 CHECK 와 중복이지만
  -- badges 가 verification 없이 수동 INSERT 되는 사고도 막는다.
  CONSTRAINT badge_never_self_declared CHECK (method <> 'self_declared'),

  -- 한 프로필에 같은 유형의 활성 배지는 하나만. 재검증은 이전 것을 expired 로 만든 뒤 발급한다.
  UNIQUE (verification_id)
);
CREATE UNIQUE INDEX badges_active_one_per_type ON badges(profile_id, badge_type) WHERE status = 'active';

-- N-8 (보안정책 §4.8): 측정 지표는 기간·분모·표본수·산정근거 없이 저장될 수 없다.
CREATE TABLE metric_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  metric_code     text NOT NULL,
  value_numeric   numeric NOT NULL,
  unit            text NOT NULL,
  -- 아래 4개가 NOT NULL 인 것이 N-8 의 전부다. 기간·분모 없는 "누적 643건"을 DB 가 거부한다.
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  sample_size     integer NOT NULL CHECK (sample_size >= 0),
  basis           text NOT NULL,            -- 집계 기준·제외 조건 설명
  -- P-067: 거래 수치는 system_integrated 증거가 있어야 한다. 직접 입력은 배지를 받지 못한다.
  verification_id uuid REFERENCES verifications(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX metric_claims_profile_idx ON metric_claims(profile_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- M06 Catalog & Offer
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE offers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type          offer_owner NOT NULL,
  owner_id            uuid NOT NULL,
  profile_id          uuid REFERENCES profiles(id) ON DELETE CASCADE,
  title               text NOT NULL,
  description         text,
  price_display_policy price_policy NOT NULL DEFAULT 'inquiry',
  price_amount        numeric,
  price_currency      text,
  external_url        text,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'sold_out', 'archived')),
  available_until     timestamptz,
  published_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- P-091: 가격을 표시하겠다면 금액과 통화가 있어야 한다.
  CONSTRAINT offer_shown_price_complete
    CHECK (price_display_policy <> 'shown' OR (price_amount IS NOT NULL AND price_currency IS NOT NULL))
);
CREATE INDEX offers_profile_idx ON offers(profile_id) WHERE status = 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- M07 Lead & CRM
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE leads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  organization_id     uuid REFERENCES organizations(id) ON DELETE SET NULL,
  offer_id            uuid REFERENCES offers(id) ON DELETE SET NULL,
  contact_name        text NOT NULL,
  -- N-13 / 보안정책 §3: 연락처는 암호화해서 넣는다. 평문 컬럼이 없다.
  contact_channel_encrypted text NOT NULL,
  contact_channel_kind text NOT NULL CHECK (contact_channel_kind IN ('email', 'phone')),
  -- 목록 화면용 마스킹 값. 복호화 없이 그릴 수 있다 (P-102).
  contact_masked      text NOT NULL,
  purpose             text,
  message             text,
  consent_record_id   uuid NOT NULL REFERENCES consent_records(id),
  assigned_to         uuid REFERENCES users(id),
  stage               lead_stage NOT NULL DEFAULT 'new',
  utm                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_response_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  retention_until     timestamptz NOT NULL
);
CREATE INDEX leads_profile_idx ON leads(profile_id, created_at DESC);
CREATE INDEX leads_assigned_idx ON leads(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX leads_retention_idx ON leads(retention_until);

CREATE TABLE lead_stage_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage lead_stage,
  to_stage   lead_stage NOT NULL,
  changed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- P-106: 비공개 메모. 고객·외부에 노출되지 않는다.
CREATE TABLE lead_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id),
  note       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- M08 Booking
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE availability_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min   smallint NOT NULL CHECK (start_min BETWEEN 0 AND 1440),
  end_min     smallint NOT NULL CHECK (end_min BETWEEN 0 AND 1440),
  timezone    text NOT NULL,
  slot_minutes smallint NOT NULL DEFAULT 30 CHECK (slot_minutes > 0),
  CHECK (end_min > start_min)
);

CREATE TABLE appointments (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id                  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lead_id                     uuid REFERENCES leads(id) ON DELETE SET NULL,
  -- P-195: UTC 저장. timezone 은 "사용자에게 무엇으로 보여줄지"다.
  start_at                    timestamptz NOT NULL,
  end_at                      timestamptz NOT NULL,
  timezone                    text NOT NULL,
  status                      text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'canceled', 'completed', 'no_show')),
  cancellation_policy_version text NOT NULL,
  canceled_at                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
-- P-122: 이중 예약은 애플리케이션 검사가 아니라 DB 배타 제약으로 막는다.
-- 취소된 예약은 겹쳐도 되므로 WHERE 로 제외한다.
ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    profile_id WITH =,
    tstzrange(start_at, end_at) WITH &&
  ) WHERE (status IN ('requested', 'confirmed'));

-- ─────────────────────────────────────────────────────────────────────────────
-- M09 Analytics
--   N-13: IP·UA 원문을 저장하지 않는다. 해시·범주만.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE analytics_events (
  id           bigserial PRIMARY KEY,
  profile_id   uuid REFERENCES profiles(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  target       text,
  visitor_hash text,
  referrer_host text,
  utm          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_profile_time_idx ON analytics_events(profile_id, occurred_at DESC);
CREATE INDEX analytics_kind_idx ON analytics_events(kind, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- M10 Billing & Plans
-- ─────────────────────────────────────────────────────────────────────────────

-- P-140: 한도를 코드 상수가 아니라 레코드로 둔다.
CREATE TABLE plans (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  limits      jsonb NOT NULL DEFAULT '{}'::jsonb,
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  plan_code   text NOT NULL REFERENCES plans(code),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  CHECK (user_id IS NOT NULL OR organization_id IS NOT NULL)
);
CREATE UNIQUE INDEX subscriptions_active_user ON subscriptions(user_id) WHERE status <> 'canceled' AND user_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- M12 Admin, Trust & Safety
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  text NOT NULL CHECK (subject_type IN ('profile', 'badge', 'offer', 'lead')),
  subject_id    uuid NOT NULL,
  reporter_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  reason_code   text NOT NULL,
  detail        text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'actioned', 'dismissed')),
  handled_by    uuid REFERENCES users(id),
  handled_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- P-169: 정책 버전. 검증·동의 레코드가 이 값을 참조한다.
CREATE TABLE policy_versions (
  version     text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('privacy', 'terms', 'verification', 'cancellation')),
  effective_at timestamptz NOT NULL,
  summary     text
);

-- P-199: 데이터 보존 정책. 값은 법률검토 후 주입한다 (데이터모델 §6).
CREATE TABLE retention_policies (
  data_type    text PRIMARY KEY,
  purpose      text NOT NULL,
  legal_basis  text,
  retain_days  integer,
  note         text
);

-- N-7: 감사로그는 append-only. 아래 트리거가 UPDATE/DELETE 를 거부한다.
CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  event_type     text NOT NULL,
  actor_id       uuid,
  actor_role     text,
  tenant_id      uuid,
  aggregate_type text NOT NULL,
  aggregate_id   uuid,
  -- 기술백서 §7 / 보안정책 §3: payload 에 PII 원문을 넣지 않는다. 식별자와 코드만.
  payload_minimized jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- P-165: 운영자가 개인 데이터를 조회할 때의 목적. 목적 없는 조회는 애플리케이션이 거부한다.
  access_purpose text,
  correlation_id text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_aggregate_idx ON audit_logs(aggregate_type, aggregate_id, occurred_at DESC);
CREATE INDEX audit_actor_idx ON audit_logs(actor_id, occurred_at DESC);
CREATE INDEX audit_type_idx ON audit_logs(event_type, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 플랫폼
-- ─────────────────────────────────────────────────────────────────────────────

-- P-183: 외부 연동을 유발하는 쓰기는 같은 트랜잭션에서 여기에 기록된다 (기술백서 §7).
CREATE TABLE outbox_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type     text NOT NULL,
  tenant_id      uuid,
  actor_id       uuid,
  aggregate_type text NOT NULL,
  aggregate_id   uuid,
  schema_version integer NOT NULL DEFAULT 1,
  correlation_id text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox_events(next_attempt_at) WHERE processed_at IS NULL;

-- P-185: Idempotency-Key 저장소.
CREATE TABLE idempotency_keys (
  scope        text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status       integer NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- P-189: rate limit 카운터.
CREATE TABLE rate_limits (
  bucket      text NOT NULL,
  window_start timestamptz NOT NULL,
  count       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 트리거: 애플리케이션이 깜빡해도 깨지지 않아야 하는 것
-- ─────────────────────────────────────────────────────────────────────────────

-- N-7: 감사로그 append-only. 일반 사용자에게 수정/삭제 권한을 주지 않는다 (데이터모델 §1).
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (PROPLUS 전략 N-7): % 는 허용되지 않는다', TG_OP;
END $$;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();

-- N-6: 검증 상태 변경은 전부 감사로그에 남는다 (모듈명세 M04 수용기준).
-- 애플리케이션 모듈이 로그를 빠뜨려도 이 트리거가 남긴다.
CREATE OR REPLACE FUNCTION verifications_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_logs (event_type, actor_id, aggregate_type, aggregate_id, payload_minimized)
  VALUES (
    'verification.' || NEW.status::text,
    NEW.reviewer_id,
    'verification',
    NEW.id,
    jsonb_build_object(
      'evidenceId', NEW.evidence_id,
      'method', NEW.method::text,
      'status', NEW.status::text,
      'scope', NEW.scope,
      'reasonCode', NEW.reason_code,
      'policyVersion', NEW.policy_version
    )
  );
  RETURN NEW;
END $$;

CREATE TRIGGER verifications_audit_ins AFTER INSERT ON verifications
  FOR EACH ROW EXECUTE FUNCTION verifications_audit();

-- N-1 보강: badges 는 verified 상태의 verification 만 참조할 수 있다.
-- CHECK 로는 다른 테이블을 볼 수 없으므로 트리거로 막는다.
CREATE OR REPLACE FUNCTION badges_require_verified() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status proof_status; v_method verification_method;
BEGIN
  SELECT status, method INTO v_status, v_method FROM verifications WHERE id = NEW.verification_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'badge % references a missing verification', NEW.id;
  END IF;
  IF v_status <> 'verified' THEN
    RAISE EXCEPTION 'badge 는 verified 검증만 참조할 수 있다 (현재 %)', v_status;
  END IF;
  IF v_method = 'self_declared' THEN
    RAISE EXCEPTION '자기기재는 배지를 받을 수 없다 (전략 N-1 / 보안정책 §4.2)';
  END IF;
  IF NEW.method <> v_method THEN
    RAISE EXCEPTION 'badge.method(%) 가 verification.method(%) 와 다르다', NEW.method, v_method;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER badges_require_verified_trg BEFORE INSERT OR UPDATE OF verification_id, method ON badges
  FOR EACH ROW EXECUTE FUNCTION badges_require_verified();

-- P-067: 거래 수치 지표는 system_integrated 검증이 있어야 검증된 지표로 간주된다.
-- verification_id 를 붙이려면 그 검증이 system_integrated + verified 여야 한다.
CREATE OR REPLACE FUNCTION metric_claims_require_integration() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status proof_status; v_method verification_method;
BEGIN
  IF NEW.verification_id IS NULL THEN
    RETURN NEW;   -- 미검증 지표. 공개 렌더러가 "자기기재"로 표기한다.
  END IF;
  SELECT status, method INTO v_status, v_method FROM verifications WHERE id = NEW.verification_id;
  IF v_status <> 'verified' OR v_method <> 'system_integrated' THEN
    RAISE EXCEPTION '검증된 거래 수치는 system_integrated 검증만 근거로 쓸 수 있다 (기획서 §7 / P-067)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER metric_claims_require_integration_trg BEFORE INSERT OR UPDATE OF verification_id ON metric_claims
  FOR EACH ROW EXECUTE FUNCTION metric_claims_require_integration();

-- 리드 단계 변경 이력 (P-104)
CREATE OR REPLACE FUNCTION leads_stage_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lead_stage_history (lead_id, from_stage, to_stage) VALUES (NEW.id, NULL, NEW.stage);
  ELSIF NEW.stage <> OLD.stage THEN
    INSERT INTO lead_stage_history (lead_id, from_stage, to_stage) VALUES (NEW.id, OLD.stage, NEW.stage);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER leads_stage_history_trg AFTER INSERT OR UPDATE OF stage ON leads
  FOR EACH ROW EXECUTE FUNCTION leads_stage_history();

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER profiles_touch BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER evidence_touch BEFORE UPDATE ON evidence FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 공개 조회 뷰 — N-4 / N-9 / ADR-002
--
-- 공개 프로필 조회는 **이 뷰만** 거친다. 뷰에 없는 컬럼은 공개될 길이 없다.
-- 만료는 읽기 시점에 판정한다(N-9) — 배치 지연에 의존하지 않는다.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE VIEW public_profile_view AS
SELECT
  p.id,
  p.slug,
  p.display_name,
  p.headline,
  p.bio,
  p.specialties,
  p.languages,
  -- 지역은 공개 설정이 켜져 있을 때만 (P-024/P-029)
  CASE WHEN COALESCE((p.public_settings->>'showRegion')::boolean, false) THEN p.region END AS region,
  p.published_at,
  p.version
FROM profiles p
JOIN users u ON u.id = p.user_id
WHERE p.published_at IS NOT NULL
  AND u.status = 'active'
  AND u.deleted_at IS NULL;

-- N-9: 활성 배지. 만료·취소를 읽기 시점에 판정한다.
-- P-058: 6필드 중 하나라도 비면 여기서 걸러진다 — 숨겨야 할 배지가 응답에 들어갈 길이 없다.
CREATE VIEW public_badge_view AS
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
  AND b.verified_at IS NOT NULL;

-- N-8: 공개 가능한 지표. 기간·표본·근거가 모두 있는 것만. (NOT NULL 이지만 빈 문자열 근거는 거른다)
CREATE VIEW public_metric_view AS
SELECT
  m.id,
  m.profile_id,
  m.metric_code,
  m.value_numeric,
  m.unit,
  m.period_start,
  m.period_end,
  m.sample_size,
  m.basis,
  (m.verification_id IS NOT NULL) AS verified
FROM metric_claims m
WHERE m.basis <> ''
  AND m.sample_size > 0;

CREATE VIEW public_offer_view AS
SELECT
  o.id,
  o.profile_id,
  o.owner_type,
  o.title,
  o.description,
  o.price_display_policy,
  CASE WHEN o.price_display_policy = 'shown' THEN o.price_amount END AS price_amount,
  CASE WHEN o.price_display_policy = 'shown' THEN o.price_currency END AS price_currency,
  o.external_url
FROM offers o
WHERE o.status = 'active'
  AND o.published_at IS NOT NULL
  -- P-092: 품절·만료는 읽기 시점에 판정한다
  AND (o.available_until IS NULL OR o.available_until > now());

-- ─────────────────────────────────────────────────────────────────────────────
-- 시드: 정책 버전 · 요금제 · 증거 유형
--   값은 문서에 있는 것만 넣는다. 미결정 항목은 비워 둔다 (전략 §8).
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO policy_versions (version, kind, effective_at, summary) VALUES
  ('privacy-2026-10-22',      'privacy',      '2026-10-22', '초안 — 법률검토 전'),
  ('terms-2026-10-22',        'terms',        '2026-10-22', '초안 — 법률검토 전'),
  ('verification-2026-10-22', 'verification', '2026-10-22', '보안정책 §4 증거 검증 정책 v1'),
  ('cancellation-2026-10-22', 'cancellation', '2026-10-22', '예약 취소 정책 초안');

-- 기획서 §9 수익모델 가설. 가격은 시장검증 전이므로 한도만 둔다.
INSERT INTO plans (code, name, limits) VALUES
  ('free',     'Free',     '{"offers":3,"blocks":6,"customDomain":false,"booking":false,"analyticsDays":30}'),
  ('pro',      'Pro',      '{"offers":50,"blocks":24,"customDomain":true,"booking":true,"analyticsDays":365}'),
  ('business', 'Business', '{"offers":500,"blocks":24,"customDomain":true,"booking":true,"analyticsDays":365,"teamSeats":50}');

-- 기획서 §7 신뢰 증명 모델의 배지 예시 + 브랜드 §5 배지 카피.
-- min_method 는 "이 유형이 받을 수 있는 최소 강도"다. identity 는 서류 확인 이상을 요구한다.
INSERT INTO evidence_types (code, label_ko, min_method, badge_label_ko, requires_issuer, default_ttl_days) VALUES
  ('identity',          '본인 확인',      'document_reviewed', '본인 확인 완료',   false, NULL),
  ('affiliation',       '현재 소속',      'issuer_confirmed',  '현재 소속 확인',   true,  365),
  ('license',           '자격·면허',      'issuer_confirmed',  '자격 정보 확인',   true,  NULL),
  ('career',            '경력',           'document_reviewed', '경력 확인',        false, NULL),
  ('product_training',  '제품 교육 이수', 'issuer_confirmed',  '제품 교육 확인',   true,  730),
  ('transaction_count', '거래 실적',      'system_integrated', '거래 데이터 확인', false, 180),
  ('response_time',     '응답 시간',      'system_integrated', '평균 응답시간',    false, 90),
  ('aftercare',         '사후 관리 활동', 'system_integrated', '사후관리 활동 확인', false, 180);

-- P-199: 보존기간 값은 법률검토 후 주입한다. 지금은 목적만 기록한다 (데이터모델 §6).
INSERT INTO retention_policies (data_type, purpose, legal_basis, retain_days, note) VALUES
  ('lead',            '상담 처리 및 후속 연락',       NULL, NULL, '법률검토 필요 — 미결정 §2'),
  ('evidence_file',   '자격·소속 검증',                NULL, NULL, '검증 완료 후 원본 삭제 / 검증 이력 보존 — 데이터모델 §7-2'),
  ('audit_log',       '부정 사용 조사 및 분쟁 대응',   NULL, NULL, 'append-only, 삭제 정책 별도'),
  ('analytics_event', '서비스 개선 통계',              NULL, NULL, '개인식별 불가 집계');
