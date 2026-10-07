-- Track A: Organization / Enterprise / Relationship graph / Introductions (additive only).
-- F-004 조직 가입, F-129 조직/워크스페이스, F-130 역할 권한, F-131 팀 주소록, F-132 회사 소유 리드, F-077 담당자,
-- F-076 공유 메모, F-074 관계 강도, F-135~F-140 Enterprise, F-008 SSO/SCIM, F-006 Passkey,
-- F-155/F-158/F-159 소개, F-064/F-197 Referral.

-- ---------- organizations (F-129, F-004, F-138, F-139, F-136) ----------
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS verified_domains text[] NOT NULL DEFAULT '{}';
-- off: invite only · auto: verified-domain users join as member · approval: verified-domain users request, admin approves
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS domain_join_mode text NOT NULL DEFAULT 'off';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS branding jsonb NOT NULL DEFAULT '{}';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS policies jsonb NOT NULL DEFAULT '{}';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS retention jsonb NOT NULL DEFAULT '{}';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS joined_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS join_source text NOT NULL DEFAULT 'create';
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS left_at timestamptz;
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS graph_opt_out boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS organization_members_user_idx ON organization_members(user_id) WHERE status = 'active';

ALTER TABLE users ADD COLUMN IF NOT EXISTS active_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS org_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  email text,
  role text NOT NULL DEFAULT 'member',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  max_uses int NOT NULL DEFAULT 1,
  use_count int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_invites_org_idx ON org_invites(organization_id, created_at DESC);

-- ---------- team address book / company-owned leads (F-131, F-132, F-077) ----------
-- scope: personal (only owner) · org (shared to contacts.organization_id)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'personal';
-- ownership: personal (the member's) · company (organization owns; owner_user_id = 담당자, reassigned when they leave)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ownership text NOT NULL DEFAULT 'personal';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS shared_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS shared_at timestamptz;
CREATE INDEX IF NOT EXISTS contacts_org_live_idx ON contacts(organization_id, updated_at DESC) WHERE organization_id IS NOT NULL AND deleted_at IS NULL AND merged_into_id IS NULL;
CREATE INDEX IF NOT EXISTS contacts_company_idx ON contacts(company_id) WHERE deleted_at IS NULL;

-- F-076 공유 메모: scope 'team' notes carry organization_id. 'private' notes never leave the author.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS author_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS notes_team_idx ON notes(organization_id, contact_id, created_at DESC) WHERE scope = 'team';

-- ---------- relationship strength explanation (F-074) ----------
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS strength_factors jsonb NOT NULL DEFAULT '[]';
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS strength_computed_at timestamptz;
CREATE INDEX IF NOT EXISTS relationships_owner_strength_idx ON relationships(owner_user_id, strength DESC NULLS LAST);

-- ---------- API keys (F-140) ----------
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL UNIQUE,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys(organization_id);

-- ---------- B2B SSO (OIDC) + SCIM (F-008) ----------
CREATE TABLE IF NOT EXISTS sso_configs (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  protocol text NOT NULL DEFAULT 'oidc',
  issuer text NOT NULL,
  client_id text NOT NULL,
  encrypted_client_secret bytea,
  enabled boolean NOT NULL DEFAULT false,
  default_role text NOT NULL DEFAULT 'member',
  scim_token_hash text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sso_login_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash text NOT NULL UNIQUE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  next_path text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

-- ---------- Passkeys / WebAuthn (F-006) ----------
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  device_type text,
  backed_up boolean NOT NULL DEFAULT false,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx ON webauthn_credentials(user_id);
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Introductions (F-155, F-158, F-159, F-152) ----------
ALTER TABLE introductions ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE introductions ADD COLUMN IF NOT EXISTS draft jsonb;
ALTER TABLE introductions ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'none';
ALTER TABLE introductions ADD COLUMN IF NOT EXISTS outcome_note text;
ALTER TABLE introductions ADD COLUMN IF NOT EXISTS outcome_at timestamptz;
ALTER TABLE introductions ADD COLUMN IF NOT EXISTS meeting_at timestamptz;
CREATE INDEX IF NOT EXISTS introductions_introducer_idx ON introductions(introducer_user_id, created_at DESC);
ALTER TABLE connection_rooms ADD COLUMN IF NOT EXISTS summary jsonb;
ALTER TABLE connection_rooms ADD COLUMN IF NOT EXISTS summary_at timestamptz;

-- ---------- Referral attribution + reward ledger (F-064, F-197) ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text UNIQUE;
CREATE TABLE IF NOT EXISTS referral_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL,
  exchange_session_id uuid REFERENCES exchange_sessions(id) ON DELETE SET NULL,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_attributions_referrer_idx ON referral_attributions(referrer_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS referral_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attribution_id uuid NOT NULL UNIQUE REFERENCES referral_attributions(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'points',
  amount int NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  granted_at timestamptz
);
CREATE INDEX IF NOT EXISTS referral_rewards_user_idx ON referral_rewards(user_id, status);

CREATE INDEX IF NOT EXISTS audit_logs_org_idx ON audit_logs(organization_id, created_at DESC) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS business_cards_captured_idx ON business_cards(captured_by, captured_at DESC);
CREATE INDEX IF NOT EXISTS meetings_owner_idx ON meetings(owner_user_id, created_at DESC);
