# LINKOS — 개발 지침 (Project Memory)

이 파일은 `dd/LINKOS_Product_Blueprint_v1/` 번들(기술백서·기능 원장·OpenAPI·DB 스키마·이벤트 카탈로그)에서
추출한 **상시 적용 지침**이다. 이 저장소에서 작업하는 모든 사람/AI 에이전트는 코드를 쓰기 전에 이 파일을 따른다.

## 1. Source of Truth
- 기능 원장: `dd/LINKOS_Product_Blueprint_v1/03_FEATURE_REGISTRY.yaml` (197 Feature ID). ID를 삭제·통합·이름변경·묵시적 보류 금지.
- API 계약: `04_OPENAPI.yaml` → 구현은 `apps/web/src/app/api/v1/**` (경로/operationId 일치).
- DB: `05_DATABASE_SCHEMA.sql` → 실제 마이그레이션은 `db/migrations/*.sql` (원본 테이블을 유지하고 추가만 한다).
- 이벤트: `06_EVENT_CATALOG.yaml` → `packages/domain/src/events.ts` 의 이름/페이로드와 일치해야 한다.
- 추적성: `docs/TRACEABILITY.md` 는 `pnpm traceability` 로 재생성한다. 테스트가 없는 기능은 "완료"로 표시하지 않는다.

## 2. 비타협 제품 원칙 (Non-negotiable)
1. **교환이 가입보다 먼저.** 수신자(비회원)에게 로그인/앱설치 화면을 먼저 보여주지 않는다. `/x/[token]` 게스트 랜딩은 인증 없이 동작해야 한다.
2. **Claim은 교환 뒤.** 게스트 회신 → 양방향 Relationship 생성 → 그 다음에 "내 카드 소유하기"(claim token) CTA.
3. **QR은 최종 폴백.** Handoff 사다리: 앱↔앱 BLE(네이티브 앱) → OS 공유(Web Share) → NFC 액세서리 → 단축코드 → (실험 채널) → QR 자동 표시. QR을 첫 화면에 노출하지 않는다.
4. **브라우저 폰↔폰 NFC/Bluetooth P2P를 가능한 것처럼 표현 금지.** Web NFC는 태그(NDEF) 전용, iOS Safari에서 Web Bluetooth 요구 금지. Android는 Play Instant가 아닌 PWA 경로.
5. **Contact ≠ BusinessCard ≠ Encounter ≠ Relationship.** 별도 엔터티로 유지한다.
6. **AI는 사실 필드를 지어내지 않는다.** OCR 원문에 없는 값 생성 금지. 모든 필드는 `provenance`(ocr|user|sync|ai_inferred)와 `confidence` 를 가진다. AI 추론(Offer/Need/Match)은 화면에 "AI 추론" 라벨 + 확인 가능.
7. **녹음/전사는 동의 기록(consent_records) 없이는 시작 불가.**
8. **고위험 자동행동(메일 발송, 일정 확정, CRM 덮어쓰기)은 사용자 승인 필수.** 기본값은 초안(draft).

## 3. 보안·개인정보 규칙
- 교환 토큰: ≥128bit 랜덤(base64url), **DB에는 SHA-256 해시만 저장**, TTL·1회성/재사용 제한·revoke·rate limit. 토큰에 PII 금지.
- 로그/분석 이벤트에는 전화·이메일 원문 금지 → `redact()` 사용 (`packages/domain/src/redact.ts`).
- 프로필 필드 ACL: `public < business < trusted < partner`. 응답 직전에 `filterFieldsByAudience()` 로 거른다.
- 개인 메모(`notes.scope='private'`)는 상대·팀에 절대 노출 금지.
- 동의는 종류별 분리 기록(service/privacy/marketing/exchange/recording/integration) + `policy_version`.
- 외부 연동을 유발하는 쓰기는 **같은 트랜잭션에서 outbox_events 에 기록**하고 워커가 idempotent 하게 처리한다.
- 모든 create/update API는 `Idempotency-Key` 헤더를 지원한다.
- 관리자 export·대량조회·삭제는 audit_logs 에 남긴다.

## 4. 아키텍처 규칙
- 모듈형 모놀리스: `services/api/src/modules/<module>` (identity, handoff, capture, relationship, card, meeting, ai, integration, connection, event, security, analytics). 라우트 핸들러는 얇은 어댑터.
- 순수 도메인 로직(상태머신, 채널 선택, 파서, 매칭, ACL, 리댁션)은 `packages/domain` — I/O 금지, 단위테스트 필수.
- 엄격한 TypeScript. Python은 OCR/STT 등 정당한 경우에만.
- 실시간 교환 상태는 SSE(`/api/v1/exchange/sessions/{token}/events`).

## 5. 디자인 시스템 규칙 (packages/ui 토큰 = `apps/web/src/app/globals.css`)
- 컨셉: "Porcelain & Pastel" — 흰 도자기 배경(#FCFCFE), 잉크 텍스트(#1B1B24), 파스텔 표면(라벤더 #ECE8FF · 민트 #DCF5EA · 피치 #FFE8DD · 스카이 #DCEBFF · 버터 #FFF4D2 · 로즈 #FDE6EF), 단일 강조색 아이리스(#6C5CE7, 텍스트용 #5B4BD6). 경고/오류는 코랄(#E8664A).
- 하드코딩 색 금지 — `var(--bg|--bg-elev|--bg-sunk|--fg|--fg-mute|--line|--accent|--accent-text|--accent-soft|--glass)` 와 `--color-*` 파스텔 토큰만 쓴다. 다크 모드는 토큰 재정의로 자동 지원.
- 타이포: 디스플레이 = Instrument Serif(이탤릭 `<em>` 은 아이리스→로즈 그라디언트), UI = Inter Tight, 한글 = Pretendard. 큰 대비의 타이포 스케일.
- 모션 레이어(`components/Fx.tsx`): `[data-reveal]` 스크롤 리빌, `.btn` 리플, `[data-tilt]` 홀로그래픽 틸트, `[data-confetti]` 파스텔 컨페티, 커서 스포트라이트·스크롤 진행바, `app/app/template.tsx` 페이지 전환, `.stagger`·`.glow-border`·`.stage-aurora`. 모두 점진적 향상(JS 없이도 내용 표시)이며 `prefers-reduced-motion` 시 비활성.
- 주요 행동은 한 손 엄지 영역(하단)에 배치. 게스트 랜딩 LCP p75 < 2.5s → 랜딩에 무거운 JS/이미지 금지(모션은 CSS + 경량 IntersectionObserver).
- 접근성: 색 대비 AA, 포커스 링, `prefers-reduced-motion` 준수, 모든 아이콘 버튼에 aria-label.

## 6. 작업 방법
- 개발: `pnpm i && pnpm db:up && pnpm db:migrate && pnpm dev`
- 검증: `pnpm typecheck && pnpm test && pnpm e2e` — 푸시 전 모두 통과해야 한다.
- 새 기능 추가 시: 코드 상단/테스트 이름에 Feature ID(`F-0xx`)를 표기하고 `scripts/traceability.mjs` 의 매핑을 갱신한다.
