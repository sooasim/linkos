# PROPLUS — 검증된 전문가 프로필 플랫폼

> 미니홈페이지가 아니라 **Proof Engine**. 누가 무엇을 어떤 근거로 검증했는지를 보여주고,
> 그 위에 프로필·상담·상거래를 얹는다.

이 서브트리는 `dd/PROPLUS_Technical_Document_Set/` 번들(통합기획서 · 기술백서 · 모듈명세 ·
데이터모델/API명세 · 보안·개인정보·신뢰정책 · 오픈소스검토 · 로드맵 · 브랜드가이드)을 기준으로 구현한다.
기능은 `P-xxx` 네임스페이스를 쓰고, 운영 주소는 **https://proplus.linkos.com** 이다.

## 왜 LINKOS 와 분리인가

같은 저장소·같은 서버를 쓰면서 **DB·프로세스·기능원장·쿠키·스토리지·감사로그를 완전히 분리**한다.
이유는 셋이다. (1) 루트 `CLAUDE.md` §1 이 LINKOS 197개 `F-xxx` 를 삭제·통합·이름변경 금지로 묶어 두었으므로
PROPLUS 기능을 그 번호에 끼워 넣으면 원장이 오염된다. (2) 신뢰 모델이 반대 방향이다 — LINKOS 는 관계 강도를
*추정*하고 PROPLUS 는 추정을 *금지*한다(자기기재는 배지 불가, 보안정책 §4.2). 한 도메인 패키지에 두 철학을
섞으면 둘 다 약해진다. (3) 검증 콘솔과 증거 원본 스토리지는 LINKOS 와 다른 신뢰 경계다. 공유하는 것은
pnpm 워크스페이스 · `tsconfig.base.json` · Playwright/CI 러너 · 배포 서버 · 그리고 검증된 코드 *패턴* 뿐이다.
자세한 결정 기록은 [`docs/02_ADR.md`](docs/02_ADR.md) ADR-009.

## 구성

```
proplus/
  apps/web/            @proplus/web      Next.js 16 — 공개 프로필 /p/[slug] · 워크스페이스 /app · 검증 콘솔 /admin · /api/v1/*
  packages/domain/     @proplus/domain   순수 도메인 — 검증 상태머신, 배지 정책, 공개 DTO allowlist, ACL, 리댁션 (I/O 금지)
  services/api/        @proplus/api      모듈 계층(identity·profile·proof·org·catalog·lead·booking·analytics·billing·search·admin)
                                         + db/storage/mail 라이브러리 + 마이그레이션 러너 + outbox 워커
  db/migrations/       proplus 데이터베이스 전용 SQL (추가 전용. 공개/비공개 경계를 뷰·트리거로 강제)
  docs/                전략 · 기능원장 · ADR · 배포 런북 · 내부 계약 · 추적성
  infra/               nginx vhost · systemd unit · 배포 스크립트
  scripts/             traceability 생성기
```

계층 규칙은 단방향이다: **라우트(얇은 어댑터) → 모듈(SQL·트랜잭션) → 도메인(순수 함수)**.
UI 는 권한을 판단하지 않고 서버가 걸러 준 것만 그린다. 상세는 [`CLAUDE.md`](CLAUDE.md) §3.

## 개발 시작

```bash
pnpm i
pnpm proplus:migrate          # proplus 데이터베이스에 db/migrations/*.sql 적용 (advisory lock 727275)
pnpm proplus:dev              # http://localhost:4400
```

`PROPLUS_DATABASE_URL` 은 LINKOS 와 **다른 데이터베이스**를 가리켜야 한다. 설정 파일·스토리지 경로도 분리한다
(운영 기준은 전략 §10). SMTP_URL 이 없으면 메일은 발송하지 않고 로그로만 남는다.

## 검증

```bash
pnpm proplus:typecheck        # strict + noUncheckedIndexedAccess
pnpm proplus:test             # packages/domain 단위테스트 + services/api 통합테스트
pnpm proplus:traceability     # docs/TRACEABILITY.md 재생성
pnpm proplus:traceability --check   # 원장 status=done 인데 테스트 참조가 없는 기능이 있으면 실패
```

`--check` 는 CI 게이트다. 전략 §9 의 **"테스트가 없는 기능은 완료로 표시하지 않는다"** 를 기계적으로 확인한다.
`docs/TRACEABILITY.md` 는 생성물이므로 직접 편집하지 말고 `scripts/traceability.mjs` 와 원장을 고친다.

## 문서 지도

| 문서 | 내용 |
|---|---|
| [`docs/00_DEV_STRATEGY.md`](docs/00_DEV_STRATEGY.md) | 개발 전략 — 분리 근거, **비타협 원칙 N-1~N-15**, 아키텍처, 구현 순서, 기술 선택 근거, 의도적으로 비워 둔 것 |
| [`docs/01_FEATURE_REGISTRY.yaml`](docs/01_FEATURE_REGISTRY.yaml) | 기능 원장 (`P-xxx`, 모듈 M01~M12 + 플랫폼). ID 를 삭제·통합·이름변경하지 않는다 |
| [`docs/02_ADR.md`](docs/02_ADR.md) | 아키텍처 결정 기록 ADR-001~010 (상태/맥락/결정/근거/결과/대안) |
| [`docs/03_DEPLOY.md`](docs/03_DEPLOY.md) | 배포 런북 — nginx vhost · systemd · TLS/DNS 선행 조건 |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | 내부 계약 — 파일 목록·함수 시그니처·디자인 토큰. 동시 작업자가 같은 이름을 쓰게 하는 목적 |
| `docs/TRACEABILITY.md` | 기능 ↔ 코드 ↔ 테스트 매핑 (생성물, `pnpm proplus:traceability`) |
| [`CLAUDE.md`](CLAUDE.md) | `proplus/` 안에서 작업할 때의 상시 지침 |

원본 기술문서 세트: **`dd/PROPLUS_Technical_Document_Set/`** (저장소 루트 기준).
문서에 "미결정"으로 적힌 것은 임의로 결정하지 않고 스키마·어댑터만 비워 둔다 — 목록은 전략 §8.

## 운영

| 항목 | 값 |
|---|---|
| 주소 | https://proplus.linkos.com (선행 조건 미해결 시 `proplus.ckp.kr` 임시 운영) |
| 소스 | `/var/www/proplus` |
| 웹/API | `proplus-web.service` → `127.0.0.1:4400` (루프백 전용, nginx 가 앞단) |
| 워커 | `proplus-worker.service` (outbox 소비 + 만료 알림) |
| DB | PostgreSQL `proplus` DB / `proplus` 롤 |
| 설정 | `/etc/proplus/proplus.env` (root:proplus 640) |
| 업로드 | `/var/lib/proplus/storage` (증거 원본은 암호화 + 단기 signed URL) |

> ⚠️ `proplus.linkos.com` 운영에는 코드로 해결할 수 없는 선행 조건이 있다 — `linkos.com` 도메인 소유,
> `*.linkos.com` TLS 인증서(기존 `*.ckp.kr` 와일드카드는 이 호스트를 덮지 않는다), DNS 레코드.
> 절차와 현재 상태는 [`docs/03_DEPLOY.md`](docs/03_DEPLOY.md) 와 전략 §10.
