-- Track E: native apps + remaining handoff channels (additive only).
-- F-007 native bearer sessions, F-039/F-040 BLE proximity, F-044 NFC accessories, F-046 web rendezvous,
-- F-052 offline receipts (per-device HMAC keys), F-060 Google One Tap (uses identities/auth_sessions as-is).

-- Native clients (apps/mobile, App Clip) authenticate with a bearer token stored in secure storage.
-- Same auth_sessions table; a bearer token is only accepted for client_kind='native' and a cookie only for 'web'.
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS client_kind text NOT NULL DEFAULT 'web';

-- F-044 NFC 액세서리: owner-registered tags. Only the SHA-256 of the tag id is stored; the URL written to the tag is
-- https://<origin>/n/<tagId>. Each tap creates a fresh single-use exchange session for the owner.
CREATE TABLE IF NOT EXISTS nfc_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  tag_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  use_count int NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS nfc_tags_owner_idx ON nfc_tags(owner_user_id) WHERE revoked_at IS NULL;

-- F-046 웹-웹 페어링: receiver "받기 모드" → spoken 4-digit code inside a short window → sender enters it and confirms.
CREATE TABLE IF NOT EXISTS exchange_rendezvous (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listen_hash text NOT NULL UNIQUE,
  code text NOT NULL,
  receiver_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  receiver_hint text,
  status text NOT NULL DEFAULT 'waiting', -- waiting | matched | confirmed | rejected | expired
  exchange_session_id uuid REFERENCES exchange_sessions(id) ON DELETE CASCADE,
  -- exchange URL token, AES-256-GCM encrypted (handed to the receiver once, then cleared)
  token_enc text,
  matched_at timestamptz,
  confirmed_at timestamptz,
  delivered_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS exchange_rendezvous_code_active ON exchange_rendezvous(code) WHERE status IN ('waiting', 'matched');

-- F-039 앱 근접 교환: short-lived ephemeral BLE ids bound to an exchange session (hash only; no PII over the air).
CREATE TABLE IF NOT EXISTS proximity_ids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_session_id uuid NOT NULL REFERENCES exchange_sessions(id) ON DELETE CASCADE,
  eph_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proximity_ids_session_idx ON proximity_ids(exchange_session_id);

-- F-040 근접 확인: a resolved candidate pair that both people must confirm with the same on-screen code.
CREATE TABLE IF NOT EXISTS proximity_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_session_id uuid NOT NULL REFERENCES exchange_sessions(id) ON DELETE CASCADE,
  receiver_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verify_code text NOT NULL,
  rssi int,
  status text NOT NULL DEFAULT 'pending', -- pending | exchanged | rejected | expired
  sender_confirmed_at timestamptz,
  receiver_confirmed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exchange_session_id, receiver_user_id)
);

-- F-052 오프라인 큐: per-device HMAC keys (secret stored AES-256-GCM encrypted with a key derived from AUTH_SECRET).
CREATE TABLE IF NOT EXISTS device_exchange_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_enc text NOT NULL,
  platform text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS device_exchange_keys_user_idx ON device_exchange_keys(user_id);

-- Idempotent sync: (receiver key, receipt id) is processed exactly once; the stored result is replayed.
CREATE TABLE IF NOT EXISTS offline_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id text NOT NULL,
  receipt_id uuid NOT NULL,
  receiver_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  pass_nonce text NOT NULL,
  occurred_at timestamptz NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key_id, receipt_id)
);
-- the same sender pass scanned twice by the same receiver yields one relationship
CREATE UNIQUE INDEX IF NOT EXISTS offline_receipts_pass_once ON offline_receipts(receiver_user_id, sender_user_id, pass_nonce);
