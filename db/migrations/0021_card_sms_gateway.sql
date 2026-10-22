-- X-009 고도화: ① 사용자 소유 안드로이드 SIM 발송(게이트웨이) ② 접수 불확실 상태 ③ 중복 발송 차단용 번호 해시.
--
-- ① 왜 게이트웨이인가: 상용 문자 API 는 발신번호 사전등록과 요금이 필요하고, 받는 사람에게는 모르는
--    서비스 번호로 도착한다. 명함을 건넨 사람에게는 **본인 번호에서 온 문자**가 맞다. 사용자가 자기
--    안드로이드 폰에 공식 Android SMS Gateway 앱(capcom6/android-sms-gateway, Apache-2.0)을 깔고
--    Cloud 모드 인증정보를 연결하면, 서버는 고정 엔드포인트로 1건 요청만 보내고 발송은 사용자 SIM 이 한다.
--    앱·소스를 이 저장소에 복제하지 않는다(공식 배포본을 사용자가 직접 설치한다).
CREATE TABLE IF NOT EXISTS sms_gateway_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'cloud' CHECK (mode IN ('cloud')),
  -- Basic 인증 사용자명/비밀번호를 봉인해 보관한다. 프런트로는 절대 되돌려주지 않는다.
  -- (lib/vaultRotate.ts SEALED_COLUMNS 에 등록돼 키 교체 대상이다)
  credentials_sealed bytea NOT NULL,
  label text,
  verified_at timestamptz,
  last_used_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ② 'uncertain' = 외부에 요청은 나갔지만 응답을 받지 못한 상태. 자동 재시도하지 않는다 —
--    이미 상대 휴대폰에 도착했을 수 있으므로, 사용자가 자기 문자함을 확인한 뒤 판단해야 한다.
ALTER TABLE card_sms_deliveries DROP CONSTRAINT IF EXISTS card_sms_deliveries_status_check;
ALTER TABLE card_sms_deliveries
  ADD CONSTRAINT card_sms_deliveries_status_check
  CHECK (status IN ('draft', 'sending', 'sent', 'failed', 'uncertain', 'manual', 'cancelled'));

-- 발송 경로: provider = 상용 API(Solapi·Twilio), gateway = 사용자 본인 안드로이드 SIM, device = 사용자의 문자 앱
ALTER TABLE card_sms_deliveries ADD COLUMN IF NOT EXISTS channel text;
-- ③ 같은 상대에게 또 보내는 것을 막기 위한 비교값. 평문 번호를 다시 훑지 않고 이 해시로만 판정한다.
ALTER TABLE card_sms_deliveries ADD COLUMN IF NOT EXISTS destination_hash text;
CREATE INDEX IF NOT EXISTS card_sms_deliveries_dedupe_idx ON card_sms_deliveries(owner_user_id, destination_hash, created_at DESC);
