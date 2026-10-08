-- Track C: encrypted object storage (F-019, F-024, F-156), upload scanning (F-172), badge leads (F-014/F-144),
-- meeting recording parts + transcription (F-081~F-086). Additive only.

-- F-019 / F-172: every stored file is encrypted with a per-object key (AES-256-GCM) wrapped by CREDENTIALS_KEY.
CREATE TABLE IF NOT EXISTS stored_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL,                 -- card_image | profile_media | room_file | recording_part
  driver text NOT NULL,                  -- local | s3
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,                  -- of the (sanitized) plaintext
  original_name text,
  wrapped_key bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version int NOT NULL DEFAULT 1,
  scan_status text NOT NULL DEFAULT 'pending',  -- clean | quarantined | unscanned
  scan_engine text,
  scan_detail text,
  retention_until timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS stored_objects_owner_idx ON stored_objects(owner_user_id, purpose) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS stored_objects_retention_idx ON stored_objects(retention_until) WHERE deleted_at IS NULL AND retention_until IS NOT NULL;

-- F-019 card originals (opt-in per scan) + F-014/F-144 badge → event lead
ALTER TABLE business_cards ADD COLUMN IF NOT EXISTS front_object_id uuid REFERENCES stored_objects(id) ON DELETE SET NULL;
ALTER TABLE business_cards ADD COLUMN IF NOT EXISTS back_object_id uuid REFERENCES stored_objects(id) ON DELETE SET NULL;
ALTER TABLE business_cards ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE business_cards ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'card';
CREATE INDEX IF NOT EXISTS business_cards_event_idx ON business_cards(event_id) WHERE event_id IS NOT NULL;

-- F-024 deep profile media/files
CREATE TABLE IF NOT EXISTS profile_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  object_id uuid NOT NULL REFERENCES stored_objects(id) ON DELETE CASCADE,
  kind text NOT NULL,                    -- image | pdf
  title text,
  visibility text NOT NULL DEFAULT 'business',
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS profile_media_profile_idx ON profile_media(profile_id, sort_order);

-- F-156 Connection Room shared files / links
CREATE TABLE IF NOT EXISTS connection_room_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES connection_rooms(id) ON DELETE CASCADE,
  object_id uuid REFERENCES stored_objects(id) ON DELETE CASCADE,
  url text,
  title text NOT NULL,
  kind text NOT NULL,                    -- file | link
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'file' AND object_id IS NOT NULL) OR (kind = 'link' AND url IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS connection_room_files_room_idx ON connection_room_files(room_id, created_at);

-- F-081 recordings: self-contained audio parts uploaded while recording; F-082/F-083 transcription per part
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS mime_type text;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS part_count int NOT NULL DEFAULT 0;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS byte_size bigint NOT NULL DEFAULT 0;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS stt_provider text;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS finalized_at timestamptz;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS transcribed_at timestamptz;
CREATE INDEX IF NOT EXISTS recordings_meeting_idx ON recordings(meeting_id);
CREATE INDEX IF NOT EXISTS recordings_status_idx ON recordings(status);

CREATE TABLE IF NOT EXISTS recording_parts (
  recording_id uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  seq int NOT NULL,
  object_id uuid NOT NULL REFERENCES stored_objects(id) ON DELETE CASCADE,
  offset_ms int NOT NULL DEFAULT 0,
  duration_ms int,
  stt_status text NOT NULL DEFAULT 'pending',   -- pending | done | failed
  stt_attempts int NOT NULL DEFAULT 0,
  stt_error text,
  language text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, seq)
);
CREATE INDEX IF NOT EXISTS recording_parts_pending_idx ON recording_parts(created_at) WHERE stt_status = 'pending';

ALTER TABLE transcript_segments ADD COLUMN IF NOT EXISTS recording_id uuid REFERENCES recordings(id) ON DELETE CASCADE;
ALTER TABLE transcript_segments ADD COLUMN IF NOT EXISTS part_seq int;
ALTER TABLE transcript_segments ADD COLUMN IF NOT EXISTS language text;
CREATE INDEX IF NOT EXISTS transcript_segments_meeting_idx ON transcript_segments(meeting_id, start_ms);
CREATE INDEX IF NOT EXISTS transcript_segments_recording_idx ON transcript_segments(recording_id, part_seq);

-- F-084~F-086: AI-suggested action items stay 'suggested' until the user confirms (F-102); provenance shown in UI
ALTER TABLE action_items ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'user';
ALTER TABLE action_items ADD COLUMN IF NOT EXISTS due_hint text;
ALTER TABLE action_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
