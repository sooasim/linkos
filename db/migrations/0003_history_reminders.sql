-- F-073 변경 이력 (owner-only, field level), F-109 리마인더
CREATE TABLE IF NOT EXISTS contact_field_history (
  id bigserial PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field text NOT NULL,
  old_value text,
  new_value text,
  source text NOT NULL DEFAULT 'user',
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_field_history_contact_idx ON contact_field_history(contact_id, changed_at DESC);
ALTER TABLE followups ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
CREATE INDEX IF NOT EXISTS followups_due_open_idx ON followups(due_at) WHERE status = 'open' AND reminded_at IS NULL;
-- bottleneck guards for owner-scoped hot paths
CREATE INDEX IF NOT EXISTS encounters_owner_contact_idx ON encounters(owner_user_id, contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS encounters_session_idx ON encounters(exchange_session_id);
CREATE INDEX IF NOT EXISTS notes_owner_contact_idx ON notes(owner_user_id, contact_id);
CREATE INDEX IF NOT EXISTS contacts_owner_live_idx ON contacts(owner_user_id) WHERE deleted_at IS NULL AND merged_into_id IS NULL;
CREATE INDEX IF NOT EXISTS contacts_linked_user_idx ON contacts(linked_user_id) WHERE linked_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS exchange_sessions_sender_idx ON exchange_sessions(sender_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS exchange_attempts_session_idx ON exchange_attempts(exchange_session_id);
CREATE INDEX IF NOT EXISTS profiles_user_idx ON profiles(user_id);
CREATE INDEX IF NOT EXISTS event_attendees_event_idx ON event_attendees(event_id, user_id);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sync_jobs_queue_idx ON sync_jobs(integration_account_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS contact_tags_tag_idx ON contact_tags(tag_id);
