# LINKOS — Business Identity & Relationship OS

> 만나는 순간부터 관계를 기억하고, 다음 행동과 사업 기회까지. **상대는 가입하지 않아도 됩니다.**

이 저장소는 `dd/` 폴더의 **LINKOS 기술백서·상용화 아키텍처 v1** 번들(197개 Feature ID)을 기준으로 구현한 웹/PWA + API 모노레포입니다.
작업 지침은 [`CLAUDE.md`](CLAUDE.md), 기능별 구현 현황은 [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md), 품질 검증은 [`docs/QUALITY_REPORT.md`](docs/QUALITY_REPORT.md)를 보세요.

## 화면 미리보기

전체 31개 화면과 화면별 소스 코드 링크: **[docs/UI_PREVIEW.md](docs/UI_PREVIEW.md)**

<p>
<img src="docs/screenshots/m-guest-1-landing.webp" width="190" alt="게스트 랜딩">
<img src="docs/screenshots/m-guest-3-review.webp" width="190" alt="보낼 항목 선택">
<img src="docs/screenshots/m-app-exchange-qr.webp" width="190" alt="교환 QR 폴백">
<img src="docs/screenshots/m-app-ai-match.webp" width="190" alt="Need-Offer 매칭">
</p>

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

1. **공유 1탭** `/app/exchange` → 192-bit 일회성 토큰(서버엔 해시만) + 숫자 4자리 교환 코드 생성(10분·1회성, 틀린 코드 시도 제한)
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

## GitHub에서 바로 실행 (Codespaces)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/sooasim/linkos?quickstart=1)

1. 위 버튼 → **Create codespace**. GitHub 안에서 DB와 앱이 자동으로 설치·실행됩니다(처음 5분 정도, 진행 로그: 터미널에서 `tail -f /tmp/linkos.log`).
2. 준비되면 포트 3000 화면이 브라우저로 열립니다 → **로그인 → "테스트 계정으로 바로 시작"**.
3. 다른 사람에게 보여주려면: 아래 **PORTS** 탭 → 3000 → 마우스 오른쪽 → **Port Visibility → Public** 으로 직접 바꾸고 그 주소를 공유합니다. (기본은 본인만 접속 가능)

Codespace는 켜져 있는 동안만 접속되고 30분 동안 쓰지 않으면 멈춥니다(무료 사용 시간 월 약 60시간). 오래 공유할 주소가 필요하면 아래 Render를 쓰세요.

## 테스트 서버 (Render 원클릭 배포)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sooasim/linkos)

1. 위 버튼을 누르고 Render에 로그인합니다. 저장소가 비공개이므로 Render 계정에 GitHub(sooasim/linkos 접근 권한)를 연결해야 합니다.
2. Blueprint 화면에서 **Apply** — Postgres(`linkos-db`)와 웹 서비스(`linkos-web`)가 무료 플랜으로 만들어지고 `AUTH_SECRET`·`CREDENTIALS_KEY`는 자동 생성됩니다. 선택 항목(`APP_ORIGIN`, `SMTP_URL`, Google 키)은 비워 둬도 됩니다.
3. 첫 배포(약 5~10분)가 끝나면 서비스 페이지 상단의 `https://linkos-web-xxxx.onrender.com` 주소를 다른 사람에게 공유합니다.
4. 접속 → **로그인 → "테스트 계정으로 바로 시작"** (메일 서버 없이 일회용 계정 생성) → 내 명함 작성 → 교환 → 4자리 코드 또는 링크를 상대에게 전달. 상대는 가입 없이 `/c` 에서 코드를 입력하면 됩니다.

주의: 무료 서비스는 15분 동안 요청이 없으면 잠들고 다음 첫 요청이 1분가량 걸립니다. 무료 DB는 30일 뒤 만료됩니다. 테스트 서버(`DEMO_LOGIN=1`)에는 실제 개인정보를 넣지 마세요 — 실제 운영 전에는 `DEMO_LOGIN=0` 과 `SMTP_URL` 을 설정하고 유료 플랜·별도 worker로 바꿉니다([`docs/RUNBOOK.md`](docs/RUNBOOK.md)).

## 배포

- **Docker**: `docker build -t linkos .` → `docker run linkos release`(마이그레이션 후 웹) / `worker`
- **Render**: `render.yaml` 블루프린트 — 아래 "테스트 서버" 참고 (무료 플랜, 비밀값 자동 생성)
- 상세 절차·롤백·백업: [`docs/RUNBOOK.md`](docs/RUNBOOK.md)
