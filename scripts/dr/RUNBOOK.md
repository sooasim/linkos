# LINKOS 재해복구 런북 (F-186)

## 목표

| 항목 | 목표 | 근거 |
|---|---|---|
| RPO (데이터 손실 허용) | 리전 장애: ≤ 24h (논리 백업 주기), 단일 인스턴스 장애: ≤ 5분 (관리형 PITR) | `dr-backup-copy.sh` 일 1회 + 관리형 Postgres PITR |
| RTO (서비스 복구 시간) | ≤ 60분 | `dr-restore-verify.sh` 가 매 드릴마다 복원 시간을 측정해 `RTO_MAX_MIN` 초과 시 실패 |

게스트 랜딩(`/x/[token]`)은 교환 토큰 해시만 DB에 있으므로, 복원 전 발급된 링크도 복원 후 그대로 동작한다(만료 전이면).

## 정기 작업

1. **백업 + 교차 리전 복사** (매일, 크론/스케줄러):
   ```bash
   DATABASE_URL=… DR_PRIMARY=s3://linkos-backups-<primary-region>/db DR_SECONDARY=s3://linkos-backups-<secondary-region>/db \
     scripts/dr/dr-backup-copy.sh
   ```
   - `pg_dump` custom 포맷 + `sha256` + `manifest.json`(핵심 테이블 row 수, 적용된 마이그레이션 목록, 생성 시각).
   - 두 위치 모두에 쓰고 마지막에 `LATEST` 포인터를 갱신한다(반쯤 복사된 세트를 읽지 않도록).
   - 버킷은 버저닝 + Object Lock(또는 보존 정책) + 수명주기(35일)로 운영한다. 로컬 디렉터리 대상은 `DR_RETENTION_DAYS` 로 정리.
2. **복원 검증 드릴** (주 1회 + 스키마 변경 배포 후):
   ```bash
   ADMIN_URL=postgres://…@<dr-host>:5432/postgres DR_SOURCE=s3://linkos-backups-<secondary-region>/db \
     scripts/dr/dr-restore-verify.sh
   ```
   - **보조 리전의 백업만** 사용하고 운영 DB 에는 접속하지 않는다(리전 소실 가정).
   - 체크섬 → 스크래치 DB 에 `pg_restore` → `schema_migrations` 일치 → manifest row 수 일치 → 스모크 쿼리 → RPO/RTO 판정. 하나라도 실패하면 exit 1.
   - 결과 한 줄(`dr-restore-verify: … PASSED|FAILED`)을 모니터링/알림 채널로 보낸다.
3. 기존 `scripts/restore-drill.sh` 는 같은 리전에서 운영 DB 와 직접 비교하는 빠른 드릴이다(F-184).

## 리전 장애 시 절차

1. **선언**: 운영 리전 DB 불가가 10분 이상 지속 → 인시던트 선언, 쓰기 트래픽 중단(앱을 유지보수 모드로; 게스트 랜딩은 정적 오류 페이지).
2. **복원**: 보조 리전에 DB 인스턴스 준비 후
   ```bash
   KEEP_DB=1 ADMIN_URL=postgres://…@<dr-host>:5432/postgres DR_SOURCE=s3://linkos-backups-<secondary-region>/db scripts/dr/dr-restore-verify.sh
   ```
   `PASSED` 와 함께 남은 `linkos_dr_<ts>` DB 를 운영 DB 로 승격(이름 변경 또는 연결 문자열 교체).
3. **마이그레이션**: `DATABASE_URL=<새 DB> pnpm db:migrate` (백업 이후 배포된 추가 마이그레이션 적용; 모두 additive).
4. **앱 전환**: 보조 리전 앱/워커의 `DATABASE_URL` 교체 → 배포 → `/api/v1/health` 확인.
5. **아웃박스**: 워커가 `outbox_events.published_at IS NULL` 을 다시 처리한다(소비자는 idempotent). Stripe 웹훅은 이벤트 id 로 중복 제거되므로, Stripe 대시보드에서 장애 구간 웹훅을 **재전송**해 구독 상태를 따라잡는다.
6. **사용자 공지**: RPO 구간(마지막 백업 이후)에 생성된 교환/연락처는 유실될 수 있음을 공지. 감사 로그에 `dr.failover` 기록.
7. **복귀(failback)**: 원 리전 복구 후 같은 절차를 반대 방향으로 수행.

## 보안

- 백업 파일에는 PII 가 포함된다. 버킷은 서버측 암호화(KMS) + 최소 권한 IAM(백업 작업: write-only, 드릴: read-only).
- 드릴 DB 는 기본적으로 종료 시 삭제된다(`KEEP_DB=1` 일 때만 유지).
- 백업/복원 실행 이력은 스케줄러 로그로 남기고, 운영자가 수동 실행할 때는 인시던트 티켓에 결과 줄을 첨부한다.
