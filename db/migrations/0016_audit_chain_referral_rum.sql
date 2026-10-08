-- Additive only. 백서 §20 audit durability (hash chain), F-064 referral attribution for OAuth/SSO sign-ups,
-- §20 RUM (web vitals).

-- ---------- §20 Audit log durability: tamper-evident hash chain ----------
-- hash = SHA-256(prev_hash || '\n' || canonical(row)); chain_seq is assigned under an advisory lock (writer or sealer).
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS chain_seq bigint;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS hash text;
CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_chain_seq_uidx ON audit_logs(chain_seq) WHERE chain_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_logs_unsealed_idx ON audit_logs(id) WHERE chain_seq IS NULL;

-- Authorized purges (retention) keep the chain verifiable: the removed row's (chain_seq, hash) stays as a tombstone.
CREATE TABLE IF NOT EXISTS audit_log_tombstones (
  chain_seq bigint PRIMARY KEY,
  audit_id bigint NOT NULL,
  hash text NOT NULL,
  reason text NOT NULL,
  organization_id uuid,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- F-064: carry the /r/{code} referral through cross-site sign-in callbacks ----------
-- Apple (form_post) and SAML (HTTP-POST) callbacks are cross-site POSTs that do not carry SameSite=Lax cookies.
ALTER TABLE apple_login_states ADD COLUMN IF NOT EXISTS referral_code text;
ALTER TABLE saml_requests ADD COLUMN IF NOT EXISTS referral_code text;
ALTER TABLE sso_login_states ADD COLUMN IF NOT EXISTS referral_code text;

-- ---------- §20 RUM: real-user web vitals (sampled, no PII) ----------
-- No user id, IP, user agent, query string or token: only a normalized route pattern, the metric and its value.
CREATE TABLE IF NOT EXISTS web_vitals_samples (
  id bigserial PRIMARY KEY,
  route text NOT NULL,
  metric text NOT NULL CHECK (metric IN ('LCP','INP','CLS','FCP','TTFB')),
  value double precision NOT NULL CHECK (value >= 0),
  rating text NOT NULL CHECK (rating IN ('good','needs-improvement','poor')),
  nav_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_vitals_route_metric_time_idx ON web_vitals_samples(route, metric, created_at);

-- ---------- event consumers: meeting.actions.extracted → draft follow-up per action item (idempotent) ----------
ALTER TABLE followups ADD COLUMN IF NOT EXISTS action_item_id uuid REFERENCES action_items(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS followups_action_item_uidx ON followups(action_item_id) WHERE action_item_id IS NOT NULL;
