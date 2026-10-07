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
- 관리형 PostgreSQL 의 PITR 을 켠다(Render/Cloud SQL/RDS). 분기마다 복구 훈련을 하고 결과를 기록한다 — **아직 미실시**.

## 장애 대응
- 동기화 실패: `sync_jobs.status='dead'` 행과 `integration.sync.failed` outbox 이벤트 확인. 재시도는 `UPDATE sync_jobs SET status='retry', scheduled_at=now() WHERE id=...`
- 로그는 JSON 한 줄, 전화/이메일/토큰은 자동 마스킹. 요청 추적은 응답 헤더 `x-request-id`.

## 출시 전 남은 게이트 (백서 21.1)
TRACEABILITY 의 P0/P1 미완 항목, 침투 테스트, 접근성 감사, 개인정보 처리방침·약관 법률 검토, Google 샌드박스 검증, DR 훈련.
