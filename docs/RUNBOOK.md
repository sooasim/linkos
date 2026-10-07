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

## B2B SSO (F-008: OIDC · SAML 2.0 · SCIM · SSO 강제)
- 설정은 조직별로 앱의 **조직 설정 → SSO** 에서 한다(환경 변수 없음). 필요 권한: `sso.manage` (Admin 이상). 모든 변경은 감사 로그(`sso.config_saved`, `sso.saml_config_saved`, `scim.token_rotated`, `org.sso_required_changed`)에 남는다.
- 전제: 조직의 **인증된 도메인**. SSO로 들어온 이메일이 인증된 도메인이 아니면 `sso_domain_not_allowed` 로 거부.
- **OIDC**: Redirect URI `${APP_ORIGIN}/api/v1/auth/sso/callback`. 둘 다 켜져 있으면 OIDC 가 우선.
- **SAML 2.0 (SP-initiated)** — IdP(Okta/Entra ID/Google Workspace 등)에 등록할 값:
  - SP Entity ID = SP 메타데이터 URL: `${APP_ORIGIN}/api/v1/sso/saml/{orgId}/metadata`
  - ACS (HTTP-POST): `${APP_ORIGIN}/api/v1/sso/saml/{orgId}/acs`
  - NameID: emailAddress 권장(또는 persistent + 이메일 속성 매핑). AuthnRequest 는 서명하지 않음(HTTP-Redirect, deflate+base64).
  - IdP 쪽 값은 메타데이터 XML 붙여넣기 또는 Entity ID · SSO URL(HTTP-Redirect) · 서명 인증서(PEM) 입력.
  - 검증: Response 또는 Assertion 의 XML 서명(`@node-saml/node-saml` 5.1.0 / xml-crypto, 등록 인증서 중 하나), Audience = SP Entity ID, Destination · Recipient = ACS, Issuer = IdP Entity ID, NotBefore/NotOnOrAfter(±60초), InResponseTo = 저장된 요청 ID(1회용, 10분). 서명 없음·다른 인증서·래핑(XSW)·재전송은 거부(`saml_invalid_response` / `saml_replayed`).
  - RelayState 는 HMAC(`AUTH_SECRET`) 서명된 1회용 토큰. https 환경에서는 `lk_saml_bind`(SameSite=None, Secure) 쿠키로 로그인을 시작한 브라우저에 묶는다(login CSRF 방지).
  - **인증서 교체**: 새 인증서를 기존 인증서와 **함께** 붙여넣어 저장(최대 4개) → IdP 에서 새 키로 전환 → 로그인 확인 후 새 인증서만 남겨 저장. 인증서 칸을 비우고 저장하면 기존 인증서 유지.
- **SCIM 2.0**: Base URL `${APP_ORIGIN}/scim/v2`, 토큰은 OIDC 또는 SAML 설정 저장 후 발급(1회 표시, 해시만 저장). SCIM 을 쓰는 조직에서 SCIM 으로 비활성화된 멤버는 SSO 로 재활성화되지 않는다(`sso_deprovisioned`). SCIM 으로 만든 계정은 첫 SSO 로그인 때 약관 동의를 받는다.
- **SSO 강제 (`sso_required`)**: 켜면 인증된 도메인 이메일의 이메일 코드 · Google · 패스키 로그인이 `403 sso_required` 로 거부되고, 로그인 화면은 회사 SSO(`/api/v1/auth/sso/start?org=<slug>`)로 보낸다. 켜는 순간 해당 사용자의 **비-SSO 세션(이메일 코드/Google/패스키/이전 세션)은 즉시 폐기**된다. 사용 중인 SSO 연결이 하나도 없으면 켤 수 없고, 연결을 모두 끄면 강제는 적용되지 않는다(잠김 방지).
- **Break-glass**: 조직 **Owner** 는 강제 중에도 **이메일 코드(OTP)** 로 로그인할 수 있고, 강제를 켤 때 Owner 세션은 폐기되지 않는다. IdP 장애 시 Owner 가 OTP 로 로그인 → 조직 설정에서 SSO 강제를 끄거나 IdP 설정(인증서)을 고친다. Owner 계정은 최소 2명, 개인 메일함 보안(2단계 인증) 유지 권장. (참고: OTP 요청 응답의 차이로 특정 이메일이 Owner 인지 추정될 수 있음 — 레이트 리밋으로 완화.)
- 개발 환경에서만 `SSO_ALLOW_HTTP_ISSUER=1` 로 http IdP(OIDC issuer / SAML SSO URL)를 허용. 프로덕션 금지.
- 장애 분석: 로그 `sso.saml_rejected`(reason: 서명/audience/recipient 등, PII 없음), `sso.saml_replay`, `auth.sso_required`.

## 장애 대응
- 동기화 실패: `sync_jobs.status='dead'` 행과 `integration.sync.failed` outbox 이벤트 확인. 재시도는 `UPDATE sync_jobs SET status='retry', scheduled_at=now() WHERE id=...`
- 로그는 JSON 한 줄, 전화/이메일/토큰은 자동 마스킹. 요청 추적은 응답 헤더 `x-request-id`.

## 출시 전 남은 게이트 (백서 21.1)
TRACEABILITY 의 P0/P1 미완 항목, 침투 테스트, 접근성 감사, 개인정보 처리방침·약관 법률 검토, Google 샌드박스 검증, DR 훈련.
