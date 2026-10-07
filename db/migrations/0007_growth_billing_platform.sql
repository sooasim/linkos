-- Track D: plans/billing (F-190~F-195), cost metering (F-187), product analytics (F-188), flags (F-181), experiments (F-196),
-- living card intelligence (F-031~F-033, F-036), notification inbox, booth lead flow / ROI / organizer API (F-147, F-149, F-151).
-- Additive only.

-- platform admin (F-195 admin pages). ADMIN_EMAILS env is honored as well.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

-- ---------- billing ----------
CREATE TABLE IF NOT EXISTS billing_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'stripe',
  provider_customer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (organization_id IS NULL)),
  UNIQUE (provider, provider_customer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_customers_user_uidx ON billing_customers(provider, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_customers_org_uidx ON billing_customers(provider, organization_id) WHERE organization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  plan text NOT NULL,
  status text NOT NULL,
  provider text NOT NULL DEFAULT 'stripe',
  provider_customer_id text,
  provider_subscription_id text UNIQUE,
  amount_cents int NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  billing_interval text NOT NULL DEFAULT 'month',
  seats int NOT NULL DEFAULT 1,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  dunning_state text NOT NULL DEFAULT 'ok',
  grace_until timestamptz,
  failed_payment_count int NOT NULL DEFAULT 0,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (organization_id IS NULL))
);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscriptions_org_idx ON subscriptions(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions(status);
-- plan resolution / flag targeting look up memberships by user (PK is organization-first)
CREATE INDEX IF NOT EXISTS organization_members_user_idx ON organization_members(user_id) WHERE status = 'active';

-- webhook idempotency: every provider event is processed at most once
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  provider text NOT NULL DEFAULT 'stripe',
  event_id text NOT NULL,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  outcome text,
  PRIMARY KEY (provider, event_id)
);

-- F-192 usage counters (period = first day of the UTC month)
CREATE TABLE IF NOT EXISTS usage_counters (
  subject_type text NOT NULL CHECK (subject_type IN ('user','organization')),
  subject_id uuid NOT NULL,
  metric text NOT NULL,
  period date NOT NULL,
  count int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_type, subject_id, metric, period)
);

-- F-187 estimated cost per tenant/job (micro-USD)
CREATE TABLE IF NOT EXISTS cost_ledger (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  job_type text NOT NULL,
  job_id text,
  provider text NOT NULL,
  rate_key text NOT NULL,
  units numeric NOT NULL,
  cost_micros bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_ledger_user_idx ON cost_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cost_ledger_time_idx ON cost_ledger(created_at);

-- ---------- F-188 first-party product analytics (no PII: hashed subject, sanitized props) ----------
CREATE TABLE IF NOT EXISTS product_events (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  subject_key text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_events_name_time_idx ON product_events(name, created_at);
CREATE INDEX IF NOT EXISTS product_events_subject_idx ON product_events(subject_key, name, created_at);

CREATE OR REPLACE VIEW product_funnel_daily AS
  SELECT date_trunc('day', created_at)::date AS day, name, count(*)::int AS events, count(DISTINCT subject_key)::int AS subjects
  FROM product_events GROUP BY 1, 2;

-- ---------- F-181 feature flags ----------
CREATE TABLE IF NOT EXISTS feature_flags (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  description text,
  enabled boolean NOT NULL DEFAULT false,
  killed boolean NOT NULL DEFAULT false,
  rollout_percent int NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  allow_users uuid[] NOT NULL DEFAULT '{}',
  allow_orgs uuid[] NOT NULL DEFAULT '{}',
  deny_users uuid[] NOT NULL DEFAULT '{}',
  client_visible boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- F-196 experiments ----------
CREATE TABLE IF NOT EXISTS experiments (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  name text NOT NULL,
  hypothesis text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','stopped')),
  variants jsonb NOT NULL,
  traffic_percent int NOT NULL DEFAULT 100 CHECK (traffic_percent BETWEEN 0 AND 100),
  primary_metric text NOT NULL,
  started_at timestamptz,
  stopped_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS experiment_exposures (
  experiment_key text NOT NULL REFERENCES experiments(key) ON DELETE CASCADE,
  subject_key text NOT NULL,
  variant text NOT NULL,
  first_exposed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_key, subject_key)
);

-- ---------- notification inbox + F-033 Living Update ----------
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  data jsonb NOT NULL DEFAULT '{}',
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_uidx ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS living_update_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  profile_version int NOT NULL,
  changes jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed','superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS living_update_pending_uidx ON living_update_suggestions(contact_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS living_update_owner_idx ON living_update_suggestions(owner_user_id, status);

-- ---------- F-031/F-032 variant selection, F-036 Action Card ----------
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS action_ctas jsonb NOT NULL DEFAULT '{}';
ALTER TABLE profile_variants ADD COLUMN IF NOT EXISTS highlights text[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS card_action_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('booking','quote','proposal','nda')),
  requester_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  requester_name text NOT NULL,
  requester_email text NOT NULL,
  requester_company text,
  message text,
  details jsonb NOT NULL DEFAULT '{}',
  consent_policy_version text NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','done','declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS card_action_requests_owner_idx ON card_action_requests(owner_user_id, created_at DESC);

-- ---------- F-147 booth lead flow, F-149 ROI, F-151 organizer API ----------
ALTER TABLE events ADD COLUMN IF NOT EXISTS cost_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN IF NOT EXISTS audience text;
CREATE TABLE IF NOT EXISTS event_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  captured_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  qualifiers text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  interest text CHECK (interest IN ('hot','warm','cold')),
  score int NOT NULL DEFAULT 0,
  grade text NOT NULL DEFAULT 'C',
  notes text,
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','contacted','meeting','proposal','won','lost')),
  deal_value_cents bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, contact_id)
);
CREATE INDEX IF NOT EXISTS event_leads_event_idx ON event_leads(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS event_leads_assignee_idx ON event_leads(assigned_to) WHERE assigned_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{attendees:read,leads:read}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS event_api_tokens_event_idx ON event_api_tokens(event_id);
