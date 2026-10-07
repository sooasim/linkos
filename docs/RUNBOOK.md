# LINKOS 배포·운영 Runbook

## 필수 환경 변수
| 이름 | 설명 |
|---|---|
| `DATABASE_URL` | PostgreSQL 16 (pgvector, pgcrypto, pg_trgm 확장 사용) |
| `APP_ORIGIN` | 공개 https 오리진. 교환 링크와 OAuth 콜백에 사용, https 이면 쿠키 Secure |
| `AUTH_SECRET` | 32바이트 이상 랜덤. 없으면 프로덕션에서 OTP 발급 거부 |
| `SMTP_URL`, `MAIL_FROM` | 로그인 코드 메일 발송 (예: `smtps://user:pass@smtp.host:465`) |
| `CREDENTIALS_KEY` | 32바이트 base64 — 외부 연동 자격증명 AES-256-GCM 암호화 키 |
| `GOOGLE_CLIENT_ID/SECRET` | 선택. 리디렉션 URI: `${APP_ORIGIN}/api/v1/integrations/google/callback` |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | 선택. Sign in with Apple(웹). 네 값이 모두 있어야 /login·/claim 에 "Apple로 계속" 표시. 아래 "Apple 로그인 설정" 참고 |
| `HUBSPOT_CLIENT_ID/SECRET` | 선택. HubSpot 연락처·회사·딜 동기화(F-121). 아래 "HubSpot 회사·딜" 참고 |
| `ANTHROPIC_API_KEY` | 선택. 설정 시 AI 요약·회의 정리·메일 초안에 Claude(`claude-opus-5-5`) 사용, 미설정 시 규칙 기반으로 동작 |
| `METRICS_TOKEN` | `/api/v1/metrics` (Prometheus) 접근 토큰 — 프로덕션에서 미설정이면 403 |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS` | 커넥션 풀/쿼리 타임아웃 (기본 10 / 15s / 10s) |
| `OTP_DEV_ECHO` | 스테이징 전용. `1` 이면 응답에 로그인 코드 포함 — **프로덕션 금지** |

키 생성: `openssl rand -base64 32`

## 배포 순서 (staging → production)
1. CI 녹색 확인 (typecheck · unit · integration · migration 2회 · traceability · build · e2e · docker build)
2. 이미지 빌드 → `release` 커맨드가 마이그레이션 후 웹을 띄움 (마이그레이션은 advisory lock 으로 동시 실행 안전, 추가 전용)
3. `worker` 프로세스 1개 이상 실행 (outbox 릴레이, Google 동기화, 세션 만료, 삭제 유예 처리)
4. 헬스체크 `GET /api/v1/health` → `{"status":"ok"}`

## 롤백
- 이미지 태그를 이전 버전으로 되돌린다. 마이그레이션은 추가 전용이라 이전 코드와 호환된다.
- 잘못된 교환 링크 대량 발급 시: `UPDATE exchange_sessions SET state='REVOKED', short_code=NULL WHERE state NOT IN ('EXCHANGED','CLAIM_PENDING','CLAIMED','SYNCED');`

## 백업/복구 (백서 RPO ≤15분, RTO ≤4시간 목표)
- 관리형 PostgreSQL 의 PITR 을 켠다(Render/Cloud SQL/RDS).
- 논리 백업: `DATABASE_URL=... scripts/backup.sh ./backups` (pg_dump custom + sha256).
- 복구 리허설: `DATABASE_URL=... ADMIN_URL=postgres://.../postgres pnpm restore-drill` — 백업 → 임시 DB 복원 → 핵심 12개 테이블 행 수 비교. 2026-10-07 로컬 리허설 통과(2초). 운영 DB에서는 분기마다 실행하고 결과를 기록.

## Google 연동 설정
- Google Cloud Console에서 OAuth 클라이언트(웹) 생성, 승인된 리디렉션 URI: `${APP_ORIGIN}/api/v1/integrations/google/callback`
- 사용 API: People API(연락처 동기화), Google Sheets API(시트 내보내기). 범위: `contacts`, `drive.file`(앱이 만든 파일만)
- OAuth 동의 화면 검수(민감 범위) 필요. 검수 전에는 테스트 사용자만 연결 가능.

## Apple 로그인 설정 (F-001/F-060, 웹)
- Apple Developer → Identifiers 에서 **Services ID** 생성(예: `com.linkos.web`) → "Sign in with Apple" 활성화 → Primary App ID 연결.
  - Domains: `APP_ORIGIN` 의 호스트, Return URLs: `${APP_ORIGIN}/api/v1/auth/apple/callback` (https 필수, localhost 불가 → 스테이징 도메인에서 검증).
- Keys 에서 "Sign in with Apple" 키 생성 → `.p8` 내려받기(한 번만 가능). `APPLE_KEY_ID`=키 ID, `APPLE_TEAM_ID`=팀 ID, `APPLE_CLIENT_ID`=Services ID.
- `APPLE_PRIVATE_KEY`: `.p8` PEM 그대로(줄바꿈을 `\n` 으로 써도 됨) 또는 `base64 -w0 AuthKey_XXXX.p8` 값. 클라이언트 시크릿(ES256 JWT, 1시간)은 서버가 매번 서명·캐시한다.
- 흐름: `GET /api/v1/auth/apple` → 1회용 state(DB에는 SHA-256만) + nonce → Apple(`response_mode=form_post`, `scope=name email`) →
  `POST /api/v1/auth/apple/callback`(크로스사이트 form POST라 JSON/동일출처 가드 대신 state·코드 교환·JWKS 서명 검증(iss/aud/exp/nonce)으로 보호).
- 신규 사용자는 `/login?consent=apple` 동의 단계를 거친 뒤 다시 Apple로 진행한다. Apple은 이름을 최초 1회만 보내므로 동의 대기 중 이름은
  `apple_pending_profiles` 에 암호화(30분)해 두었다가 가입 시 사용한다. 이메일 가리기(privaterelay.appleid.com) 주소도 계정 이메일로 허용.
- 장애: `/login?error=apple_token_failed`(시크릿/키 ID/팀 ID 불일치 — 서버 로그 `apple.token_failed`), `apple_invalid_token`(Services ID ≠ aud).
- 로컬/CI 검증은 가짜 Apple 서버(`services/api/test/fakeApple.ts`, `APPLE_API_BASE`)로만 한다. 실제 Apple 연동은 스테이징에서 수동 확인 필요.

## HubSpot 회사·딜 (F-121)
- HubSpot 앱 범위: `crm.objects.contacts.*`, `crm.objects.companies.read/write`, `crm.objects.deals.read/write`. 이전 범위로 연결된 계정은
  연동 화면의 "HubSpot 회사·딜 → 다시 연결"로 재동의해야 한다(`hubspot_scope_missing`).
- 회사: 연락처의 회사 → 도메인(회사 도메인 → 웹사이트 → 업무 이메일, 무료 메일 제외)으로 중복 확인 → 없으면 이름 일치 → 없으면 생성.
  이미 HubSpot에 있는 회사는 값을 덮어쓰지 않고 연결만 한다. 이후 변경은 `updatedAt` 가드(원격 수정 시 conflict → Sync Journal에서 결정).
- 딜: 미팅 화면 "HubSpot 딜 만들기 (승인 필요)" → `crm_deals` 초안 → 사용자가 확인한 버전을 승인해야 `crm.deal.upsert` 작업이 생긴다.
  파이프라인/단계 매핑은 연동 화면 "딜 필드·파이프라인 매핑"(기본: HubSpot `default` 파이프라인 단계 ID).
- 알려진 한계: 딜 생성 직후 매핑 저장 전에 프로세스가 죽으면 재시도 시 딜이 중복 생성될 수 있다(HubSpot 딜 생성에 멱등 키가 없음) — Journal에서 확인.

## 장애 대응
- 동기화 실패: `sync_jobs.status='dead'` 행과 `integration.sync.failed` outbox 이벤트 확인. 재시도는 `UPDATE sync_jobs SET status='retry', scheduled_at=now() WHERE id=...`
- 로그는 JSON 한 줄, 전화/이메일/토큰은 자동 마스킹. 요청 추적은 응답 헤더 `x-request-id`.

## 출시 전 남은 게이트 (백서 21.1)
TRACEABILITY 의 P0/P1 미완 항목, 침투 테스트, 접근성 감사, 개인정보 처리방침·약관 법률 검토, Google 샌드박스 검증, DR 훈련.
