-- LINKOS application extensions on top of the blueprint schema (additive only).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- identity (F-001, F-002, F-007, F-009)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash text NOT NULL UNIQUE,
  device_label text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_from uuid
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_codes_email_idx ON otp_codes(email, created_at DESC);

-- living card (F-022~F-036)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS slug text UNIQUE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS company text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS job_title text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS industries text[] NOT NULL DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS regions text[] NOT NULL DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deep jsonb NOT NULL DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'ink';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS matching_opt_in boolean NOT NULL DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

ALTER TABLE offers ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'user';
ALTER TABLE offers ADD COLUMN IF NOT EXISTS confirmed boolean NOT NULL DEFAULT true;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE needs ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'user';
ALTER TABLE needs ADD COLUMN IF NOT EXISTS confirmed boolean NOT NULL DEFAULT true;
ALTER TABLE needs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- contacts (F-0xx Relationship core)
CREATE UNIQUE INDEX IF NOT EXISTS companies_normalized_name_uidx ON companies(normalized_name);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS field_provenance jsonb NOT NULL DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS contacts_name_trgm ON contacts USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS contacts_email_idx ON contacts(owner_user_id, lower(email));
CREATE INDEX IF NOT EXISTS contacts_phone_idx ON contacts(owner_user_id, phone);
ALTER TABLE business_cards ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'scan';
ALTER TABLE encounters ADD COLUMN IF NOT EXISTS exchange_session_id uuid REFERENCES exchange_sessions(id) ON DELETE SET NULL;
ALTER TABLE encounters ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE notes ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text';
CREATE UNIQUE INDEX IF NOT EXISTS tags_owner_name_uidx ON tags(owner_user_id, name);

-- exchange (F-037~F-064)
ALTER TABLE exchange_sessions ADD COLUMN IF NOT EXISTS short_code text UNIQUE;
ALTER TABLE exchange_sessions ADD COLUMN IF NOT EXISTS short_code_expires_at timestamptz;
ALTER TABLE exchange_sessions ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false;
ALTER TABLE exchange_sessions ADD COLUMN IF NOT EXISTS max_uses int NOT NULL DEFAULT 1;
ALTER TABLE exchange_sessions ADD COLUMN IF NOT EXISTS use_count int NOT NULL DEFAULT 0;
ALTER TABLE exchange_sessions ADD COLUMN IF NOT EXISTS channel_plan text[] NOT NULL DEFAULT '{}';
ALTER TABLE exchange_sessions ADD COLUMN IF NOT EXISTS receiver_opened_at timestamptz;
ALTER TABLE exchange_sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE exchange_sessions ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}';
ALTER TABLE exchange_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE guest_claims ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- communication (F-1xx follow-up)
CREATE TABLE IF NOT EXISTS followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'thank_you',
  title text NOT NULL,
  body_draft text,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open',
  source text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS followups_owner_due_idx ON followups(owner_user_id, status, due_at);

-- ai provenance log (백서 17)
CREATE TABLE IF NOT EXISTS ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  source_ids text[] NOT NULL DEFAULT '{}',
  output jsonb NOT NULL DEFAULT '{}',
  confidence numeric,
  user_confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- meetings (F-08x)
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS purpose text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS next_meeting_at timestamptz;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS consent_policy text NOT NULL DEFAULT 'all_party';

-- introductions / rooms (F-1xx)
ALTER TABLE introductions ADD COLUMN IF NOT EXISTS party_a_status text NOT NULL DEFAULT 'pending';
ALTER TABLE introductions ADD COLUMN IF NOT EXISTS party_b_status text NOT NULL DEFAULT 'pending';
ALTER TABLE introductions ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'INTRO_PROPOSED';
ALTER TABLE connection_rooms ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE connection_rooms ADD COLUMN IF NOT EXISTS next_action text;
CREATE TABLE IF NOT EXISTS connection_room_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES connection_rooms(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- events (F-1xx)
ALTER TABLE events ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS venue text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS join_code text UNIQUE;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- platform: idempotency + rate limit + exports + privacy jobs
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code int NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  count int NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE TABLE IF NOT EXISTS export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'contacts',
  format text NOT NULL,
  fields text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'ready',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 day'
);
CREATE TABLE IF NOT EXISTS deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'scheduled',
  deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_error text;
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox_events(created_at) WHERE published_at IS NULL;
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_idem_uidx ON sync_jobs(integration_account_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS integration_accounts_user_provider_uidx ON integration_accounts(user_id, provider);
