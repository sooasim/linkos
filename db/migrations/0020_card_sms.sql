-- X-009 문자 명함 전송 (SMS card hand-off)
-- 상대의 종이 명함을 촬영해 그 번호로 "내 명함 이미지 + 기본정보 + 연락처 저장 링크"를 문자로 보낸다.
-- 교환이 가입보다 먼저(CLAUDE.md §2.1): 수신자는 링크를 열어 로그인 없이 저장만 하면 끝난다.
-- 링크 토큰은 해시만 저장하고(§3), 보낸 사람이 같은 링크를 다시 보낼 수 있도록 봉인 사본을 함께 둔다
-- (booking_pages 와 동일 패턴 — lib/vaultRotate.ts SEALED_COLUMNS 에 등록돼 키 교체 대상이다).
CREATE TABLE IF NOT EXISTS card_sms_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- 촬영한 종이 명함에서 만든 연락처/캡처(저장을 건너뛰면 NULL)
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  business_card_id uuid REFERENCES business_cards(id) ON DELETE SET NULL,
  -- 발송 이력은 messages(channel='sms') 에도 남아 /app/messages 에서 함께 보인다
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  -- 문자에 실어 보낸 내 명함 이미지(암호화 저장) — 랜딩에서도 같은 이미지를 보여준다
  image_object_id uuid REFERENCES stored_objects(id) ON DELETE SET NULL,
  token_hash text NOT NULL UNIQUE,
  token_sealed bytea NOT NULL,
  to_phone text NOT NULL,                       -- E.164
  to_name text,
  body text NOT NULL,                           -- 실제로 보낸(또는 보낼) 본문 그대로
  channel_kind text NOT NULL DEFAULT 'lms' CHECK (channel_kind IN ('sms', 'lms', 'mms')),
  -- manual = 발송 게이트웨이가 없어 사용자의 문자 앱으로 넘긴 경우(링크는 그대로 유효하다)
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'failed', 'manual', 'cancelled')),
  provider text,
  provider_message_id text,
  error text,
  -- 발송 근거: 상대가 명함을 직접 건넸다는 보낸 사람의 확인(§2.7 동의 기록 없이는 시작하지 않는다)
  consent_basis text NOT NULL CHECK (consent_basis IN ('card_handed')),
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_at timestamptz,
  opened_at timestamptz,
  saved_at timestamptz,
  open_count int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS card_sms_deliveries_owner_idx ON card_sms_deliveries(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS card_sms_deliveries_contact_idx ON card_sms_deliveries(owner_user_id, contact_id, created_at DESC);
