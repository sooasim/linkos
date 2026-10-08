-- 0009: F-001/F-060 Sign in with Apple (web) + F-121 HubSpot Company/Deal sync. Additive only.

-- ---------- Sign in with Apple: one-time login state (stored as SHA-256 hash), nonce, post-login path ----------
CREATE TABLE IF NOT EXISTS apple_login_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash text NOT NULL UNIQUE,
  nonce text NOT NULL,
  next_path text,
  -- the required consents were accepted on /login before this attempt (Apple's form_post callback is a
  -- cross-site POST, so SameSite=Lax cookies are not available there — the decision travels with the state)
  consent_accepted boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apple_login_states_expiry_idx ON apple_login_states(expires_at);

-- Apple sends the user's name only on the very first authorization. When a new user is bounced to the consent
-- step, the (encrypted) name is parked here, keyed by SHA-256(sub), so the retry can still use it.
CREATE TABLE IF NOT EXISTS apple_pending_profiles (
  subject_hash text PRIMARY KEY,
  encrypted_profile bytea NOT NULL,
  expires_at timestamptz NOT NULL
);

-- ---------- F-121 HubSpot: per-object options (deal pipeline / stage mapping) on the F-127 mapping row ----------
ALTER TABLE crm_field_mappings ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}';

-- Deals are created from a LINKOS meeting outcome only after explicit user approval (CLAUDE.md rule 8: default draft).
CREATE TABLE IF NOT EXISTS crm_deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  meeting_id uuid REFERENCES meetings(id) ON DELETE SET NULL,
  contact_ids uuid[] NOT NULL DEFAULT '{}',
  name text NOT NULL,
  amount numeric(18,2),
  currency text,
  close_date date,
  stage text NOT NULL DEFAULT 'discovery',
  description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','synced','discarded')),
  version int NOT NULL DEFAULT 1,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  approved_version int,
  sync_job_id uuid REFERENCES sync_jobs(id) ON DELETE SET NULL,
  external_id text,
  remote_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_deals_owner_idx ON crm_deals(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS crm_deals_meeting_idx ON crm_deals(meeting_id) WHERE meeting_id IS NOT NULL;
