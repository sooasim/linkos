-- Track B: communication, scheduling, CRM and outbound integrations (additive only).

-- integration accounts: non-secret provider metadata (instance URL, org URL, remote account id/email)
ALTER TABLE integration_accounts ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE external_mappings ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
ALTER TABLE external_mappings ADD COLUMN IF NOT EXISTS remote_url text;
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS resolution text;
CREATE INDEX IF NOT EXISTS sync_jobs_account_recent_idx ON sync_jobs(integration_account_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS external_mappings_local_idx ON external_mappings(local_id);

-- F-111 템플릿 (personal or organization scope)
CREATE TABLE IF NOT EXISTS message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'user' CHECK (scope IN ('user','org')),
  name text NOT NULL,
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms')),
  language text NOT NULL DEFAULT 'ko',
  subject text,
  body text NOT NULL,
  variables text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_templates_owner_idx ON message_templates(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS message_templates_org_idx ON message_templates(organization_id) WHERE organization_id IS NOT NULL;

-- F-105 후속 시퀀스
CREATE TABLE IF NOT EXISTS followup_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','completed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS followup_sequences_owner_idx ON followup_sequences(owner_user_id, contact_id);
ALTER TABLE followups ADD COLUMN IF NOT EXISTS sequence_id uuid REFERENCES followup_sequences(id) ON DELETE CASCADE;
ALTER TABLE followups ADD COLUMN IF NOT EXISTS sequence_step int;
ALTER TABLE followups ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';

-- F-106 / F-115 messages: drafts are the default; sending requires an explicit approval transition
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  followup_id uuid REFERENCES followups(id) ON DELETE SET NULL,
  template_id uuid REFERENCES message_templates(id) ON DELETE SET NULL,
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms')),
  to_address text,
  to_name text,
  subject text,
  body text NOT NULL,
  language text NOT NULL DEFAULT 'ko',
  provenance text NOT NULL DEFAULT 'user',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','failed','cancelled')),
  provider text,
  provider_message_id text,
  provider_draft_id text,
  error text,
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_owner_idx ON messages(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_contact_idx ON messages(owner_user_id, contact_id, created_at DESC);

-- F-107 booking pages (public link token: hash for lookup, sealed copy so the owner can re-share)
CREATE TABLE IF NOT EXISTS booking_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  token_sealed bytea NOT NULL,
  title text NOT NULL,
  duration_min int NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 10 AND 240),
  buffer_min int NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 120),
  min_notice_min int NOT NULL DEFAULT 240,
  horizon_days int NOT NULL DEFAULT 14 CHECK (horizon_days BETWEEN 1 AND 60),
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  windows jsonb NOT NULL DEFAULT '[]',
  location text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_pages_owner_idx ON booking_pages(owner_user_id);

-- F-087 / F-107 / F-108 / F-146 / F-157 calendar candidates (one per proposed/approved slot)
CREATE TABLE IF NOT EXISTS calendar_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('meeting','booking','room','event_request','manual')),
  meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  room_id uuid REFERENCES connection_rooms(id) ON DELETE CASCADE,
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  booking_page_id uuid REFERENCES booking_pages(id) ON DELETE CASCADE,
  group_key uuid,
  title text NOT NULL,
  description text,
  location text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','pending_approval','approved','declined','cancelled','superseded')),
  provenance text NOT NULL DEFAULT 'user' CHECK (provenance IN ('user','rules','ai_inferred','guest')),
  confidence numeric,
  source_text text,
  attendees jsonb NOT NULL DEFAULT '[]',
  requester_name text,
  requester_email text,
  note text,
  version int NOT NULL DEFAULT 1,
  calendar_provider text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS calendar_candidates_owner_idx ON calendar_candidates(owner_user_id, status, starts_at);
CREATE INDEX IF NOT EXISTS calendar_candidates_meeting_idx ON calendar_candidates(meeting_id) WHERE meeting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calendar_candidates_room_idx ON calendar_candidates(room_id) WHERE room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calendar_candidates_booking_idx ON calendar_candidates(booking_page_id, starts_at) WHERE booking_page_id IS NOT NULL;
-- a booking slot can be held by at most one live request
CREATE UNIQUE INDEX IF NOT EXISTS calendar_candidates_booking_slot_uidx ON calendar_candidates(booking_page_id, starts_at)
  WHERE booking_page_id IS NOT NULL AND status IN ('pending_approval','approved');

-- F-146 행사 미팅 요청
CREATE TABLE IF NOT EXISTS event_meeting_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  requester_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message text,
  location text,
  proposed_slots jsonb NOT NULL DEFAULT '[]',
  accepted_start timestamptz,
  accepted_end timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK (requester_user_id <> target_user_id)
);
CREATE INDEX IF NOT EXISTS event_meeting_requests_target_idx ON event_meeting_requests(target_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS event_meeting_requests_requester_idx ON event_meeting_requests(requester_user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS event_meeting_requests_pending_uidx ON event_meeting_requests(event_id, requester_user_id, target_user_id) WHERE status = 'pending';

-- F-110 Web Push
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  failure_count int NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_followups boolean NOT NULL DEFAULT true,
  push_scheduling boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS push_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  url text,
  channel text NOT NULL DEFAULT 'push',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','skipped','failed')),
  dedupe_key text,
  attempts int NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS push_notifications_dedupe_uidx ON push_notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS push_notifications_queue_idx ON push_notifications(created_at) WHERE status = 'queued';

-- F-127 field mappings (per user, optionally shared by an organization)
CREATE TABLE IF NOT EXISTS crm_field_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  object_type text NOT NULL DEFAULT 'contact',
  mapping jsonb NOT NULL,
  external_id_field text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, provider, object_type)
);

-- F-123 outgoing webhooks
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url text NOT NULL,
  description text,
  events text[] NOT NULL,
  secret_sealed bytea NOT NULL,
  active boolean NOT NULL DEFAULT true,
  consecutive_failures int NOT NULL DEFAULT 0,
  disabled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_owner_idx ON webhook_endpoints(owner_user_id) WHERE active;
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  outbox_event_id uuid,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','retry','delivered','dead')),
  attempt_count int NOT NULL DEFAULT 0,
  response_status int,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_event_uidx ON webhook_deliveries(endpoint_id, outbox_event_id) WHERE outbox_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhook_deliveries_queue_idx ON webhook_deliveries(next_attempt_at) WHERE status IN ('queued','retry');
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx ON webhook_deliveries(endpoint_id, created_at DESC);
