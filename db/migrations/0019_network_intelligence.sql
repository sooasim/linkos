-- 인적네트워크 인텔리전스 (N-ID · docs/NETWORK_INTELLIGENCE.md)
-- 출처: dd 밖 번들 AI_명함_인적네트워크_상용화_개발패키지_v3.0 / database/001_schema.sql
--
-- 그 패키지의 DDL 을 그대로 쓰지 않는다(지침 §9):
--   * 패키지는 workspace_id + PostgreSQL RLS 를 전제하지만 LINKOS 는 owner_user_id 소유권 모델이다.
--   * 조직 공유는 organizations/organization_members + 명시적 opt-in 으로만 한다.
--   * 새 Postgres 확장을 추가하지 않는다(pgvector/AGE 는 어댑터로 나중에 붙인다 — 사용자 결정 2026-10-13).
-- 기존 테이블은 유지하고 추가만 한다.

-- ---------------------------------------------------------------- N-011 / N-107 분류 체계

CREATE TABLE IF NOT EXISTS industries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text,
  name text NOT NULL,
  name_en text,
  parent_id uuid REFERENCES industries(id) ON DELETE SET NULL,
  taxonomy text NOT NULL DEFAULT 'linkos',
  UNIQUE (taxonomy, name)
);

CREATE TABLE IF NOT EXISTS capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  category text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 개인 어휘와 조직 공용 어휘를 각각 유일하게 둔다(둘 중 하나만 채워진다)
CREATE UNIQUE INDEX IF NOT EXISTS capabilities_owner_norm_idx ON capabilities(owner_user_id, normalized_name) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS capabilities_org_norm_idx ON capabilities(organization_id, normalized_name) WHERE organization_id IS NOT NULL;

-- N-107: 사용자/조직이 직접 만든 별칭. 도메인 사전(taxonomy.ts)에 없는 표현을 흡수한다.
CREATE TABLE IF NOT EXISTS taxonomy_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('industry','region','role','capability')),
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  canonical_name text NOT NULL,
  locale text NOT NULL DEFAULT 'ko',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS taxonomy_aliases_lookup_idx ON taxonomy_aliases(kind, normalized_alias);

CREATE TABLE IF NOT EXISTS contact_industries (
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  industry_id uuid NOT NULL REFERENCES industries(id) ON DELETE CASCADE,
  weight numeric(5,4) NOT NULL DEFAULT 1.0 CHECK (weight BETWEEN 0 AND 1),
  source text NOT NULL DEFAULT 'manual',
  confidence numeric(5,4) NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  PRIMARY KEY (contact_id, industry_id)
);

CREATE TABLE IF NOT EXISTS company_industries (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  industry_id uuid NOT NULL REFERENCES industries(id) ON DELETE CASCADE,
  weight numeric(5,4) NOT NULL DEFAULT 1.0 CHECK (weight BETWEEN 0 AND 1),
  PRIMARY KEY (company_id, industry_id)
);

-- Capability(제공 가능한 것)와 Need(필요한 것)를 섞지 않는다 — kind 로 분리한다(지침 §10).
CREATE TABLE IF NOT EXISTS contact_capabilities (
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  capability_id uuid NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'provides' CHECK (kind IN ('provides','needs')),
  evidence_text text,
  confidence numeric(5,4) NOT NULL DEFAULT 0.7 CHECK (confidence BETWEEN 0 AND 1),
  provenance text NOT NULL DEFAULT 'user' CHECK (provenance IN ('ocr','user','sync','ai_inferred')),
  PRIMARY KEY (contact_id, capability_id, kind)
);

CREATE TABLE IF NOT EXISTS company_capabilities (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  capability_id uuid NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'provides' CHECK (kind IN ('provides','needs')),
  confidence numeric(5,4) NOT NULL DEFAULT 0.7 CHECK (confidence BETWEEN 0 AND 1),
  PRIMARY KEY (company_id, capability_id, kind)
);

-- ---------------------------------------------------------------- N-008 소속 이력

CREATE TABLE IF NOT EXISTS contact_company_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title text,
  department text,
  role_type text NOT NULL DEFAULT 'employee',
  role_category text,
  started_on date,
  ended_on date,
  is_current boolean NOT NULL DEFAULT true,
  -- DECIDES_FOR: 이 역할이 해당 회사의 의사결정 권한을 갖는가(패키지 N-205 의 입력)
  decides_for boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'manual',
  confidence numeric(5,4) NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  provenance text NOT NULL DEFAULT 'user' CHECK (provenance IN ('ocr','user','sync','ai_inferred')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_company_roles_contact_idx ON contact_company_roles(contact_id, is_current);
CREATE INDEX IF NOT EXISTS contact_company_roles_company_idx ON contact_company_roles(company_id, is_current);

-- ---------------------------------------------------------------- N-108 Evidence

-- 추천 이유는 반드시 실재하는 evidence 에 연결된다(지침 §5). 전화·이메일 원문은 넣지 않는다.
CREATE TABLE IF NOT EXISTS evidence_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  evidence_type text NOT NULL CHECK (evidence_type IN ('business_card','user_confirmed','meeting','interaction','referral','note','company_data','org_membership','ai_inferred')),
  source text NOT NULL DEFAULT 'manual',
  source_ref text,
  occurred_at timestamptz,
  summary text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric(5,4) NOT NULL DEFAULT 0.7 CHECK (confidence BETWEEN 0 AND 1),
  inferred boolean NOT NULL DEFAULT false,
  visibility text NOT NULL DEFAULT 'private',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_entity_idx ON evidence_records(owner_user_id, entity_type, entity_id, occurred_at DESC);

-- ---------------------------------------------------------------- N-009 / N-103 관계 엣지와 신호

-- 기존 `relationships`(owner → contact)는 그대로 둔다. 이 테이블은 **연락처끼리의** 관계다
-- (who-knows-whom). owner_user_id 는 이 엣지를 관찰·주장한 사용자다.
CREATE TABLE IF NOT EXISTS contact_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  to_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  rel_type text NOT NULL DEFAULT 'knows',
  -- relationshipStrength() 결과와 EdgeQuality 의 factor 들
  strength numeric(5,4) NOT NULL DEFAULT 0.5 CHECK (strength BETWEEN 0 AND 1),
  trust numeric(5,4) NOT NULL DEFAULT 0.5 CHECK (trust BETWEEN 0 AND 1),
  intro_likelihood numeric(5,4) NOT NULL DEFAULT 0.5 CHECK (intro_likelihood BETWEEN 0 AND 1),
  reciprocity numeric(5,4) NOT NULL DEFAULT 0.5 CHECK (reciprocity BETWEEN 0 AND 1),
  shareability numeric(5,4) NOT NULL DEFAULT 0.5 CHECK (shareability BETWEEN 0 AND 1),
  availability numeric(5,4) NOT NULL DEFAULT 0.5 CHECK (availability BETWEEN 0 AND 1),
  context_fit numeric(5,4) NOT NULL DEFAULT 0.5 CHECK (context_fit BETWEEN 0 AND 1),
  confidence numeric(5,4) NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  -- 확인된 관계와 추론된 관계를 분리한다(지침 §3: inferred 전용은 confidence 상한)
  confirmed boolean NOT NULL DEFAULT false,
  inferred boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'manual',
  first_met_at timestamptz,
  last_interaction_at timestamptz,
  interaction_count integer NOT NULL DEFAULT 0,
  evidence_id uuid REFERENCES evidence_records(id) ON DELETE SET NULL,
  -- 워커 스로틀. NULL = 재계산 필요(relationships.strength_computed_at 과 같은 패턴).
  strength_computed_at timestamptz,
  -- relationshipStrength() 의 구성요소. 화면이 재계산 없이 "왜 이 점수인가"를 보여줄 수 있게 저장한다.
  strength_factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_contact_id <> to_contact_id),
  UNIQUE (owner_user_id, from_contact_id, to_contact_id, rel_type)
);
CREATE INDEX IF NOT EXISTS contact_relationships_from_idx ON contact_relationships(owner_user_id, from_contact_id);
CREATE INDEX IF NOT EXISTS contact_relationships_to_idx ON contact_relationships(owner_user_id, to_contact_id);
-- 워커가 "재계산이 필요한 엣지"만 집어 가도록 — 전체 스캔하면 tick 마다 테이블을 훑는다
CREATE INDEX IF NOT EXISTS contact_relationships_stale_idx ON contact_relationships(strength_computed_at NULLS FIRST);

-- N-103: 신호별 측정값 + 근거. 점수만 저장하면 "왜 그 점수인가"를 재현할 수 없다.
CREATE TABLE IF NOT EXISTS relationship_signal_samples (
  id bigserial PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 둘 중 하나만 채운다: 내 관계(relationships) 또는 연락처끼리의 관계(contact_relationships)
  relationship_id uuid REFERENCES relationships(id) ON DELETE CASCADE,
  contact_relationship_id uuid REFERENCES contact_relationships(id) ON DELETE CASCADE,
  signal_type text NOT NULL CHECK (signal_type IN ('frequency','recency','reciprocity','meeting_depth','deal_history','tenure','shared_context','user_trust','referral_success')),
  value numeric(7,6) NOT NULL CHECK (value BETWEEN 0 AND 1),
  evidence_id uuid REFERENCES evidence_records(id) ON DELETE SET NULL,
  measured_at timestamptz NOT NULL DEFAULT now(),
  model_version text NOT NULL DEFAULT 'rel-strength-v1',
  CHECK (relationship_id IS NOT NULL OR contact_relationship_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS relationship_signal_rel_idx ON relationship_signal_samples(relationship_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS relationship_signal_cr_idx ON relationship_signal_samples(contact_relationship_id, measured_at DESC);

-- ---------------------------------------------------------------- N-022 공개 권한

-- 5단계 사다리(can_process → … → can_reveal_contact)의 입력. 기본값은 path_only =
-- "masked 후보로 탐색되고 소개 요청은 가능하지만 신원은 공개하지 않는다"(지침 §2).
CREATE TABLE IF NOT EXISTS contact_share_permissions (
  contact_id uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  share_permission text NOT NULL DEFAULT 'path_only' CHECK (share_permission IN ('none','path_only','profile','contact','introduction')),
  purpose_scope text[] NOT NULL DEFAULT '{}',
  -- 당사자가 네트워크 탐색을 거부함 → 어떤 후보 목록에도 등장하지 않는다
  discovery_opt_out boolean NOT NULL DEFAULT false,
  -- 조직 공유 opt-in. NULL = 조직 공유 설정이 없음(조직 경유 탐색에서 제외되지 않음)
  org_share_opt_in boolean,
  lawful_basis text,
  policy_version text,
  retention_until timestamptz,
  set_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- N-109 네트워크 활동

CREATE TABLE IF NOT EXISTS network_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  counterparty_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  activity_type text NOT NULL CHECK (activity_type IN ('one_to_one','referral_given','referral_received','testimonial','group_meeting','introduction','follow_up')),
  occurred_at timestamptz NOT NULL,
  duration_minutes integer CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
  outcome text CHECK (outcome IS NULL OR outcome IN ('pending','met','qualified','won','lost','declined')),
  note text,
  evidence_id uuid REFERENCES evidence_records(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS network_activities_owner_idx ON network_activities(owner_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS network_activities_contact_idx ON network_activities(contact_id, occurred_at DESC);

-- ---------------------------------------------------------------- N-018 / N-019 프로젝트

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed','archived')),
  target_regions text[] NOT NULL DEFAULT '{}',
  target_industries text[] NOT NULL DEFAULT '{}',
  deadline date,
  visibility text NOT NULL DEFAULT 'private',
  -- 요구사항 분해가 사용자 검토를 거쳤는가. false 면 초안이며 커버리지를 확정으로 쓰지 않는다
  requirements_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_user_id, status, updated_at DESC);

-- Role 과 Need 를 한 테이블에 kind 로 둔다. 커버리지 계산이 두 종류를 같은 방식으로 다루기 때문이다.
CREATE TABLE IF NOT EXISTS project_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('role','need')),
  name text NOT NULL,
  description text,
  priority smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  industry text,
  region text,
  capability_id uuid REFERENCES capabilities(id) ON DELETE SET NULL,
  min_confidence numeric(5,4) NOT NULL DEFAULT 0.55 CHECK (min_confidence BETWEEN 0 AND 1),
  coverage_status text NOT NULL DEFAULT 'gap' CHECK (coverage_status IN ('covered','partial','gap')),
  coverage_computed_at timestamptz,
  -- 이 요구사항을 만든 원문 문장. AI 가 지어내지 않았음을 화면에서 보여준다
  source_sentence text,
  provenance text NOT NULL DEFAULT 'user' CHECK (provenance IN ('user','rule_parsed','llm_parsed')),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_requirements_project_idx ON project_requirements(project_id, priority);

-- ---------------------------------------------------------------- N-021 기회 파이프라인

CREATE TABLE IF NOT EXISTS opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  requirement_id uuid REFERENCES project_requirements(id) ON DELETE SET NULL,
  target_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  target_company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  stage text NOT NULL DEFAULT 'detected' CHECK (stage IN ('detected','qualified','intro_requested','introduced','negotiating','won','lost','dismissed')),
  stage_entered_at timestamptz NOT NULL DEFAULT now(),
  recommendation_score numeric(6,3),
  -- scoreComponents + reasons(evidenceId 포함). 추천이 왜 나왔는지 사후에 감사할 수 있어야 한다
  explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommended_path jsonb NOT NULL DEFAULT '[]'::jsonb,
  introduction_id uuid REFERENCES introductions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunities_owner_stage_idx ON opportunities(owner_user_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS opportunities_project_idx ON opportunities(project_id);

-- ---------------------------------------------------------------- N-106 저장된 검색

CREATE TABLE IF NOT EXISTS saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  query text NOT NULL,
  -- 사용자가 chip 으로 고친 최종 intent. 다음 실행에서 재파싱하지 않는다
  intent jsonb NOT NULL DEFAULT '{}'::jsonb,
  alert_enabled boolean NOT NULL DEFAULT false,
  alert_frequency text NOT NULL DEFAULT 'weekly' CHECK (alert_frequency IN ('daily','weekly','monthly')),
  last_run_at timestamptz,
  -- 지난 실행에서 본 후보 id. 알림은 "새로 생긴 후보"만 알린다
  last_result_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_searches_owner_idx ON saved_searches(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS saved_searches_alert_idx ON saved_searches(alert_frequency, last_run_at) WHERE alert_enabled;

-- ---------------------------------------------------------------- N-110 Ideal Customer Profile

CREATE TABLE IF NOT EXISTS ideal_customer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '기본 고객상',
  industries text[] NOT NULL DEFAULT '{}',
  regions text[] NOT NULL DEFAULT '{}',
  role_categories text[] NOT NULL DEFAULT '{}',
  needs text[] NOT NULL DEFAULT '{}',
  description text,
  is_default boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS icp_owner_default_idx ON ideal_customer_profiles(owner_user_id) WHERE is_default;

-- ---------------------------------------------------------------- N-006 병합 계보 / N-024 데이터 품질

-- 병합을 되돌릴 수 있도록 어떤 값이 어디서 왔는지 남긴다. contacts.merged_into_id 만으로는 복원할 수 없다.
CREATE TABLE IF NOT EXISTS entity_merge_lineage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('contact','company')),
  surviving_id uuid NOT NULL,
  merged_id uuid NOT NULL,
  -- 병합 직전의 양쪽 스냅샷. undo 는 이 값으로 복원한다
  snapshot jsonb NOT NULL,
  match_features jsonb NOT NULL DEFAULT '{}'::jsonb,
  score numeric(6,5),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decision text NOT NULL DEFAULT 'merge' CHECK (decision IN ('merge','auto_merge','separate')),
  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merge_lineage_owner_idx ON entity_merge_lineage(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS merge_lineage_surviving_idx ON entity_merge_lineage(surviving_id) WHERE undone_at IS NULL;

-- N-024: 데이터 품질을 1급 운영 기능으로 다룬다(중복후보·미해결 회사·OCR 오류·projection 지연).
CREATE TABLE IF NOT EXISTS data_quality_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('duplicate_contact','duplicate_company','unresolved_company','stale_role','ocr_low_confidence','missing_share_permission','projection_lag','failed_outbox','embedding_backlog')),
  entity_type text,
  entity_id uuid,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','critical')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_quality_open_idx ON data_quality_items(owner_user_id, kind, severity) WHERE status = 'open';

-- ---------------------------------------------------------------- N-016 추천 피드백 (학습 라벨)

-- CTR 이 아니라 funnel 결과를 기록한다(지침 §6). 가중치 재학습의 입력이다.
CREATE TABLE IF NOT EXISTS recommendation_feedback (
  id bigserial PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('search_result','opportunity','referral_partner','intro_path')),
  subject_id uuid NOT NULL,
  label text NOT NULL CHECK (label IN ('intro_requested','intro_approved','introduced','meeting_held','qualified','won','lost','wrong_relationship','not_relevant','privacy_blocked')),
  -- 추천 당시의 점수 구성과 모델 버전. 나중에 calibration 을 평가할 수 있어야 한다
  score_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_version text NOT NULL DEFAULT 'reco-v1',
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reco_feedback_owner_idx ON recommendation_feedback(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reco_feedback_subject_idx ON recommendation_feedback(subject_type, subject_id);
