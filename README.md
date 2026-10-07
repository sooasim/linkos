# LINKOS — Business Identity & Relationship OS

> 만나는 순간부터 관계를 기억하고, 다음 행동과 사업 기회까지. **상대는 가입하지 않아도 됩니다.**

이 저장소는 `dd/` 폴더의 **LINKOS 기술백서·상용화 아키텍처 v1** 번들(197개 Feature ID)을 기준으로 구현한 웹/PWA + API 모노레포입니다.
작업 지침은 [`CLAUDE.md`](CLAUDE.md), 기능별 구현 현황은 [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md)를 보세요.

## 구성

```
apps/web            Next.js 16 PWA — 랜딩, 게스트 교환(/x, /c), 로그인/Claim, 앱(/app/*), REST API(/api/v1/*)
services/api        TypeScript 모듈형 모놀리스 — identity, handoff, capture, relationship, card, meeting, ai,
                    integration, connection, event, security, analytics + outbox worker + migration runner
packages/domain     순수 도메인 로직 — 교환 상태머신, 핸드오프 사다리, 토큰, OCR 파서, 중복/병합, 매칭, ACL, 동의, 리댁션
db/migrations       0001 = 백서 스키마 원본, 0002 = 애플리케이션 확장 (추가 전용)
tests/e2e           Playwright — 게스트 교환 → 실시간 수신 → Claim, QR 최종 폴백
infra/              docker-compose, entrypoint (web | migrate | worker | release)
dd/                 원본 기획 번들 (zip, 백서 docx, 압축 해제본)
```

## 핵심 흐름 (P0)

1. **공유 1탭** `/app/exchange` → 192-bit 일회성 토큰(서버엔 해시만) + 6자리 단축코드 생성
2. **Adaptive Handoff** — OS 공유 시트 → (NFC 카드) → 단축코드 → **QR은 시간초과/실패 후 자동 표시되는 최종 폴백**
3. **Guest Landing** `/x/{token}` 또는 `/c/{code}` — 로그인 없이 3초 카드 열람, “내 명함도 보내기”
4. **게스트 촬영** — 사진은 기기 안에서 OCR(tesseract.js, 한/영), 서버는 텍스트만 받아 구조화 (원문 없는 값 생성 금지, 필드별 신뢰도)
5. **검토·동의** — 보낼 항목을 직접 체크 → 양쪽 Contact/Encounter/Relationship 생성, 발신자 화면에 SSE로 실시간 표시
6. **Claim(교환 후)** — 이메일 OTP 또는 Google로 가입 → 게스트 초안으로 Living Card 자동 생성, 상대 명함이 내 주소록에

그 밖에: Living Card(3초/30초/딥, Offer/Need, 4단계 필드 ACL, 변형, Access Request), 인맥/타임라인/개인 메모, 중복 탐지·필드별 병합·되돌리기,
관계 기억 자연어 검색, 설명 가능한 Need↔Offer 매칭, Meeting Card + 녹음 동의 게이트 + 30초 브리핑, 동의 기반 소개 + Connection Room,
행사(opt-in 매칭), Google 연락처 동기화(idempotent, etag 매핑), XLSX/CSV/vCard/TXT/JSON 내보내기, 데이터 내보내기/계정 삭제, 감사로그, KPI.

## 로컬 실행

```bash
pnpm i
cp .env.example .env              # DATABASE_URL, AUTH_SECRET 설정
pnpm db:up                        # 또는 로컬 PostgreSQL 16 (+pgvector)
pnpm db:migrate
pnpm dev                          # http://localhost:3000
pnpm worker                       # outbox / Google sync / 삭제 작업 (별도 터미널)
```

SMTP_URL 이 없으면 개발 모드에서 로그인 코드가 화면과 서버 로그에 표시됩니다(프로덕션에서는 `OTP_DEV_ECHO=1` 이 아니면 거부).

## 검증

```bash
pnpm typecheck                    # 전 패키지 strict TS
pnpm test                         # domain 단위 25 + API 통합 18 (실제 PostgreSQL)
pnpm build && pnpm e2e            # Playwright 모바일/데스크톱 6 시나리오
pnpm traceability --check         # 197개 Feature ID 누락 검사 (CI 게이트)
```

## 배포

- **Docker**: `docker build -t linkos .` → `docker run linkos release`(마이그레이션 후 웹) / `worker`
- **Render**: `render.yaml` 블루프린트 (Postgres + web + worker). `APP_ORIGIN`, `SMTP_URL`, `CREDENTIALS_KEY`, Google 키 입력
- 상세 절차·롤백·백업: [`docs/RUNBOOK.md`](docs/RUNBOOK.md)
