-- F-008 B2B SSO: SAML 2.0 service provider (per-org IdP config, one-time AuthnRequest state) + SSO enforcement.
-- Additive only: new tables/columns, no changes to existing ones.

CREATE TABLE IF NOT EXISTS saml_configs (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  idp_entity_id text NOT NULL,
  sso_url text NOT NULL,
  -- IdP signing certificates (PEM, public). More than one = rotation window: a response signed by ANY of them is accepted.
  idp_certs text[] NOT NULL DEFAULT '{}',
  name_id_format text NOT NULL DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  email_attribute text,
  name_attribute text,
  enabled boolean NOT NULL DEFAULT false,
  default_role text NOT NULL DEFAULT 'member',
  -- SCIM bearer token for orgs that use SAML without an OIDC connection (sha256 only)
  scim_token_hash text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- SP-initiated AuthnRequests: the request ID must come back as InResponseTo exactly once (replay protection),
-- bound to the signed one-time RelayState (only its sha256 is stored).
CREATE TABLE IF NOT EXISTS saml_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id text NOT NULL UNIQUE,
  relay_state_hash text NOT NULL UNIQUE,
  next_path text,
  consent_accepted boolean NOT NULL DEFAULT false,
  -- sha256 of a SameSite=None cookie set on the browser that started the login (login-CSRF protection; https only)
  browser_binding_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS saml_requests_expiry_idx ON saml_requests(expires_at) WHERE consumed_at IS NULL;

-- Org policy: members on verified domains must sign in through the company IdP (break-glass: owners keep e-mail OTP)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sso_required boolean NOT NULL DEFAULT false;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sso_required_changed_at timestamptz;

-- How each session was established (email_otp | google | passkey | oidc_sso | saml_sso; NULL = before this migration).
-- Turning sso_required on revokes the non-SSO sessions of affected users.
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS auth_method text;
