-- LINKOS core schema blueprint (PostgreSQL 16+; adapt to implementation environment)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, phone text,
  display_name text, locale text DEFAULT 'ko-KR', status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL, provider_subject text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE(provider, provider_subject)
);
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text UNIQUE NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organization_members (
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE, role text NOT NULL, status text NOT NULL DEFAULT 'active',
  PRIMARY KEY(organization_id,user_id)
);
CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL, name text NOT NULL, headline text,
  bio_short text, bio_long text, visibility text NOT NULL DEFAULT 'business', version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE profile_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  audience text NOT NULL, content jsonb NOT NULL, is_default boolean NOT NULL DEFAULT false
);
CREATE TABLE profile_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  field_type text NOT NULL, label text, value jsonb NOT NULL, visibility text NOT NULL DEFAULT 'business', sort_order int DEFAULT 0
);
CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, normalized_name text, domain text,
  industry text, metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL, linked_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL, full_name text NOT NULL, job_title text, department text,
  email text, phone text, address text, source text, metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_owner_name_idx ON contacts(owner_user_id, full_name);
CREATE TABLE business_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  captured_by uuid REFERENCES users(id) ON DELETE SET NULL, front_object_key text, back_object_key text,
  raw_ocr jsonb, structured_data jsonb, confidence jsonb, captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE encounters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE, event_id uuid, occurred_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL, place_label text, context jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE, status text DEFAULT 'active', strength numeric,
  last_contact_at timestamptz, next_followup_at timestamptz, private_summary text,
  UNIQUE(owner_user_id, contact_id)
);
CREATE TABLE exchange_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  sender_profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE,
  state text NOT NULL, expires_at timestamptz NOT NULL, selected_channel text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE exchange_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), exchange_session_id uuid REFERENCES exchange_sessions(id) ON DELETE CASCADE,
  channel text NOT NULL, outcome text NOT NULL, reason text, latency_ms int, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guest_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), exchange_session_id uuid REFERENCES exchange_sessions(id) ON DELETE SET NULL,
  claim_token_hash text UNIQUE NOT NULL, draft_contact jsonb NOT NULL, claimed_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL, claimed_at timestamptz
);
CREATE TABLE meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  title text, started_at timestamptz, ended_at timestamptz, consent_status text NOT NULL DEFAULT 'unknown',
  summary jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE meeting_participants (
  meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE, contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  role text, PRIMARY KEY(meeting_id, contact_id)
);
CREATE TABLE recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  object_key text NOT NULL, duration_seconds int, status text NOT NULL, created_at timestamptz DEFAULT now()
);
CREATE TABLE transcript_segments (
  id bigserial PRIMARY KEY, meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  speaker_key text, start_ms int, end_ms int, text text NOT NULL, confidence numeric
);
CREATE TABLE action_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL, contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  description text NOT NULL, due_at timestamptz, status text NOT NULL DEFAULT 'open', source_segment_ids bigint[]
);
CREATE TABLE offers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE, text text NOT NULL, embedding vector(1536), metadata jsonb DEFAULT '{}');
CREATE TABLE needs  (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE, text text NOT NULL, embedding vector(1536), metadata jsonb DEFAULT '{}');
CREATE TABLE notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE, contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE, scope text NOT NULL DEFAULT 'private', body text NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE, organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE, name text NOT NULL);
CREATE TABLE contact_tags (contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE, tag_id uuid REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(contact_id,tag_id));
CREATE TABLE integration_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL, scopes text[] NOT NULL DEFAULT '{}', encrypted_credentials bytea, status text NOT NULL,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE external_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), integration_account_id uuid REFERENCES integration_accounts(id) ON DELETE CASCADE,
  entity_type text NOT NULL, local_id uuid NOT NULL, external_id text NOT NULL, external_etag text, UNIQUE(integration_account_id,entity_type,local_id)
);
CREATE TABLE sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), integration_account_id uuid REFERENCES integration_accounts(id) ON DELETE CASCADE,
  job_type text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued', attempt_count int NOT NULL DEFAULT 0,
  last_error text, scheduled_at timestamptz DEFAULT now(), finished_at timestamptz
);
CREATE TABLE consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  consent_type text NOT NULL, policy_version text NOT NULL, granted boolean NOT NULL, context jsonb DEFAULT '{}', created_at timestamptz DEFAULT now()
);
CREATE TABLE access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requester_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  target_profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE, requested_fields text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending', created_at timestamptz DEFAULT now(), resolved_at timestamptz
);
CREATE TABLE introductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), introducer_user_id uuid REFERENCES users(id), party_a_contact_id uuid REFERENCES contacts(id),
  party_b_contact_id uuid REFERENCES contacts(id), reason text, status text NOT NULL DEFAULT 'proposed', created_at timestamptz DEFAULT now()
);
CREATE TABLE connection_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), introduction_id uuid REFERENCES introductions(id) ON DELETE SET NULL,
  title text NOT NULL, purpose text, status text NOT NULL DEFAULT 'active', created_at timestamptz DEFAULT now()
);
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL, starts_at timestamptz, ends_at timestamptz, settings jsonb DEFAULT '{}'
);
CREATE TABLE event_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL, contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL, metadata jsonb DEFAULT '{}'
);
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY, organization_id uuid, actor_user_id uuid, action text NOT NULL,
  entity_type text, entity_id uuid, metadata jsonb DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), aggregate_type text NOT NULL, aggregate_id uuid NOT NULL,
  event_type text NOT NULL, payload jsonb NOT NULL, published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
