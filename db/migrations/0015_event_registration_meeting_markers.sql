-- 2026-10 UI gap fill (additive only; original blueprint tables untouched)

-- ---------- F-142 참가자 등록 (CSV/붙여넣기 · 사전가입) ----------
-- A pre-registered attendee is an event_attendees row with user_id NULL until that person joins with the event
-- code (joinEvent then claims the row by e-mail). Pre-registered rows are never matching candidates (opt_in stays
-- false and they have no profile) and are visible to the event owner only.
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS company text;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS job_title text;
-- sha256 of the normalized e-mail (or name|company when there is no e-mail): re-importing the same CSV updates rows
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS registrant_key text;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS registration_source text;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS registered_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS registered_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS event_attendees_registrant_uidx ON event_attendees(event_id, registrant_key) WHERE registrant_key IS NOT NULL;

-- ---------- UX-015 녹음 중 마커 ----------
CREATE TABLE IF NOT EXISTS meeting_markers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  recording_id uuid REFERENCES recordings(id) ON DELETE SET NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- milliseconds since the start of the recording (same clock as transcript_segments.start_ms)
  offset_ms int NOT NULL CHECK (offset_ms >= 0),
  label text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_markers_meeting_idx ON meeting_markers(meeting_id, recording_id, offset_ms);
