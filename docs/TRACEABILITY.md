# LINKOS TRACEABILITY

> 자동 생성: `pnpm traceability` (source: `dd/LINKOS_Product_Blueprint_v1/03_FEATURE_REGISTRY.yaml`). 직접 편집하지 말고 `scripts/traceability.mjs` 의 매핑을 수정하세요.

백서 부록 B 규칙: Feature ID → UX → API → module → DB → event → test → deploy 중 하나라도 비면 "완료"가 아니다. **아래 표는 현재 상태를 정직하게 기록하며, Production Ready 배지는 아직 부여하지 않는다.**

## 요약

| 우선순위 | 전체 | ✅ T | 🟢 I | 🟡 P | ⬜ N |
|---|---|---|---|---|---|
| P0 | 81 | 58 | 17 | 6 | 0 |
| P1 | 85 | 20 | 12 | 16 | 37 |
| P2 | 29 | 1 | 0 | 1 | 27 |
| P3 | 2 | 0 | 0 | 0 | 2 |
| 합계 | 197 | 79 | 29 | 23 | 66 |

## IAM · Identity & Onboarding

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-001 | P0 | 회원가입/로그인 | ✅ 구현+자동테스트 | /login | /auth/otp, /auth/verify, /auth/google | identity | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts, tests/scenarios S-001~S-006 | Email OTP + Google OIDC. Apple Sign-in 미구현 |
| F-002 | P0 | 게스트 세션 | ✅ 구현+자동테스트 | /x/[token], /c/[code] | /exchange/sessions/{token} | handoff | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-003 | P0 | 계정 Claim | ✅ 구현+자동테스트 | /claim | /guest/claim | handoff.claimGuest | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-004 | P1 | 조직 가입 | ⬜ 미착수 |  |  |  |  | organizations 테이블만 존재 |
| F-005 | P1 | 다중 프로필 | 🟢 구현 | /app/me/edit?new=1 | /profiles | card |  |  |
| F-006 | P1 | Passkey | ⬜ 미착수 |  |  |  |  | WebAuthn 미구현 |
| F-007 | P0 | 세션 보안 | ✅ 구현+자동테스트 | /app/settings | /me/devices | identity.resolveSession | services/api/test/api.integration.test.ts, tests/scenarios S-004,S-006,S-010 | refresh rotation + reuse detection + device revoke |
| F-008 | P2 | B2B SSO | ⬜ 미착수 |  |  |  |  |  |
| F-009 | P0 | 연령/약관 동의 | ✅ 구현+자동테스트 | /login (consent step) | /auth/verify, /me/consents | identity | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
## CAP · Capture & OCR

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-010 | P0 | 카메라 명함 촬영 | 🟡 부분 | /app/scan | /capture/cards | CardScanner (on-device) |  | 명암 보정·회전(EXIF/auto) 구현, 자동 테두리/원근 보정 미구현 |
| F-011 | P0 | 앞·뒤면 병합 | 🟢 구현 | /app/scan | /capture/cards (backLines) | capture |  |  |
| F-012 | P1 | 사진첩 일괄 가져오기 | ⬜ 미착수 |  |  |  |  |  |
| F-013 | P1 | 다중 명함 분리 | ⬜ 미착수 |  |  |  |  |  |
| F-014 | P1 | 배지 스캔 | 🟡 부분 |  | /capture/cards kind=badge | capture |  | badge 저장 구분만 |
| F-015 | P0 | OCR 다국어 | 🟢 구현 | /app/scan (언어 선택) | /capture/parse | tesseract.js kor/jpn/chi_sim + parser | packages/domain/test/domain.test.ts, tests/scenarios S-051~S-054 | 구조화 파서는 4개 언어 자동테스트; 기기 OCR 엔진 자체는 실기기 수동 검증 |
| F-016 | P0 | AI 필드 구조화 | ✅ 구현+자동테스트 | /app/scan | /capture/cards, /capture/parse | domain/ocrParser | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts | 규칙 기반 구조화(원문 외 값 생성 금지) |
| F-017 | P0 | 신뢰도 표시 | ✅ 구현+자동테스트 | ReviewFields | /capture/cards | domain/ocrParser | packages/domain/test/domain.test.ts | 필드별 confidence + bbox |
| F-018 | P0 | 저신뢰 검토 | ✅ 구현+자동테스트 | ReviewFields |  | domain.needsReview | packages/domain/test/domain.test.ts |  |
| F-019 | P0 | 명함 원본 보관 | 🟡 부분 |  | business_cards.raw_ocr | capture |  | OCR 원문/좌표 보관. 이미지 원본 저장(암호화 object storage)은 미구현 — 기기 밖 전송 안 함 |
| F-020 | P0 | 중복 후보 탐지 | ✅ 구현+자동테스트 | /app/scan, /app/people/[id] | /contacts/duplicates | domain/duplicate | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts |  |
| F-021 | P0 | 정보 병합 | ✅ 구현+자동테스트 | /app/people/[id] | /contacts/{id}/merge, /merge/undo | relationship.mergeContact | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts | 필드별 선택 + undo |
## CARD · Living Business Card

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-022 | P0 | 3초 카드 | ✅ 구현+자동테스트 | LivingCard 3초 | /profiles | card | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-023 | P0 | 30초 카드 | 🟢 구현 | LivingCard 30초 | /profiles | card |  |  |
| F-024 | P1 | 딥 프로필 | 🟢 구현 | LivingCard 딥 | /profiles | card |  | 미디어/파일 업로드 미구현 |
| F-025 | P0 | Offer | ✅ 구현+자동테스트 | CardEditor | /profiles | card | services/api/test/api.integration.test.ts |  |
| F-026 | P0 | Need | ✅ 구현+자동테스트 | CardEditor | /profiles | card | services/api/test/api.integration.test.ts |  |
| F-027 | P1 | Interest | 🟢 구현 | CardEditor | /profiles | card (deep.interests) |  |  |
| F-028 | P1 | Asset | 🟢 구현 | CardEditor | /profiles | card (deep.assets) |  |  |
| F-029 | P1 | Network | 🟢 구현 | CardEditor | /profiles | card (deep.network) |  |  |
| F-030 | P1 | Project | 🟢 구현 | CardEditor | /profiles | card (deep.projects) |  |  |
| F-031 | P1 | 프로필 변형 | 🟡 부분 | CardEditor | /profiles (variants) | card |  | 변형 저장만, 수신자별 자동 선택 미구현 |
| F-032 | P2 | AI Adaptive Card | ⬜ 미착수 |  |  |  |  |  |
| F-033 | P1 | Living Update | 🟡 부분 |  |  | profile.updated outbox |  | 이벤트 발행만, 연결 상대 알림 미구현 |
| F-034 | P0 | 공개범위 | ✅ 구현+자동테스트 | CardEditor | /p/{slug}, /exchange/sessions/{token} | domain/acl | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/scenarios S-014~S-016,S-037 |  |
| F-035 | P1 | Access Request | ✅ 구현+자동테스트 | /p/[slug], /app/me | /profiles/{id}/access-requests, /access-requests | card | tests/scenarios S-016 |  |
| F-036 | P0 | Action Card | 🟢 구현 | LivingCard |  | LivingCard (tel/mailto/vCard) |  | 예약/견적/NDA CTA 미구현 |
## XCH · Adaptive Handoff & Exchange

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-037 | P0 | 공유 1탭 | ✅ 구현+자동테스트 | /app/exchange | /exchange/sessions | handoff | tests/e2e/guest-exchange.spec.ts |  |
| F-038 | P0 | Capability Detection | ✅ 구현+자동테스트 | ExchangeConsole.detectCapabilities | /exchange/sessions | domain/handoff | packages/domain/test/domain.test.ts |  |
| F-039 | P1 | 앱 근접 교환 | ⬜ 미착수 |  |  |  |  | 네이티브 앱 필요 (apps/mobile 미구현) |
| F-040 | P2 | 근접 확인 | ⬜ 미착수 |  |  |  |  |  |
| F-041 | P0 | OS Share | 🟢 구현 | /app/exchange | /exchange/manage/{id}/attempts | handoff |  | navigator.share — 헤드리스 테스트 불가 |
| F-042 | P1 | iOS App Clip | 🟡 부분 |  |  | .well-known/apple-app-site-association |  | AASA 자리표시자만, App Clip 미구현 |
| F-043 | P0 | Android PWA Landing | ✅ 구현+자동테스트 | /x/[token] (PWA) |  | web | tests/e2e/guest-exchange.spec.ts |  |
| F-044 | P1 | NFC 액세서리 | 🟡 부분 | /app/settings |  | handoff ladder | packages/domain/test/domain.test.ts, tests/scenarios S-024 | 사다리 단계만, 태그 기록 미구현 |
| F-045 | P1 | 단축코드 수신 | ✅ 구현+자동테스트 | /c, /c/[code] | /exchange/sessions/{code} | handoff | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-046 | P1 | 웹-웹 페어링 | 🟡 부분 |  |  | domain/handoff (web_rendezvous) | packages/domain/test/domain.test.ts | 채널 계획만 |
| F-047 | P3 | 음향 페어링 실험 | ⬜ 미착수 |  |  |  |  | P3 실험 |
| F-048 | P0 | QR 최종 폴백 | ✅ 구현+자동테스트 | /app/exchange | /exchange/manage/{id}/attempts | domain/handoff | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-049 | P0 | 교환 상호 동의 | ✅ 구현+자동테스트 | GuestFlow consent | /exchange/sessions/{token}/reply | handoff | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-050 | P0 | 토큰 보안 | ✅ 구현+자동테스트 |  | /exchange/sessions | domain/token | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/scenarios S-028,S-030 | 192-bit, SHA-256 해시 저장, TTL, 1회성, revoke, rate limit |
| F-051 | P1 | 그룹 교환 | ✅ 구현+자동테스트 | /app/exchange?group=1 | /exchange/sessions (group) | handoff | services/api/test/api.integration.test.ts, tests/scenarios S-035 | 정원 초과 409 |
| F-052 | P2 | 오프라인 큐 | ⬜ 미착수 |  |  |  |  | 네이티브 앱 필요 |
## GST · Guest Viral Conversion

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-053 | P0 | 비회원 즉시 열람 | ✅ 구현+자동테스트 | /x/[token] | /exchange/sessions/{token} | handoff | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-054 | P0 | 즉시 회신 CTA | ✅ 구현+자동테스트 | GuestFlow |  |  | tests/e2e/guest-exchange.spec.ts |  |
| F-055 | P0 | 게스트 명함 촬영 | 🟢 구현 | GuestFlow + CardScanner | /capture/parse | domain/ocrParser | tests/scenarios S-051~S-062 | 파서 자동테스트; 카메라 촬영은 실기기 수동 검증 |
| F-056 | P0 | 게스트 직접입력 | ✅ 구현+자동테스트 | GuestFlow | /exchange/sessions/{token}/reply | handoff | tests/e2e/guest-exchange.spec.ts |  |
| F-057 | P2 | Contact Picker 보조 | ⬜ 미착수 |  |  |  |  |  |
| F-058 | P0 | 회신 동의 | ✅ 구현+자동테스트 | ReviewFields(selectable) | /exchange/sessions/{token}/reply | handoff | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts | 체크한 필드만 전송 |
| F-059 | P0 | 가입 후 Claim | ✅ 구현+자동테스트 | /claim | /guest/claim | handoff | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-060 | P0 | One Tap 가입 | 🟡 부분 | /login | /auth/google | identity |  | Google OAuth 리다이렉트. One Tap 위젯 미구현 |
| F-061 | P0 | 프로필 자동완성 | ✅ 구현+자동테스트 | /claim | /guest/claim | handoff.claimGuest | services/api/test/api.integration.test.ts | 초안으로 Living Card 자동 생성 |
| F-062 | P1 | Offer/Need 2문항 | 🟢 구현 | GuestFlow, CardEditor |  |  |  |  |
| F-063 | P1 | 첫 공유 유도 | 🟢 구현 | ExchangeConsole '다음 사람과 교환' |  |  |  |  |
| F-064 | P1 | Referral Attribution | ⬜ 미착수 |  |  |  |  |  |
## REL · Contacts & Relationship Core

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-065 | P0 | Contact 레코드 | ✅ 구현+자동테스트 | /app/people | /contacts | relationship | services/api/test/api.integration.test.ts |  |
| F-066 | P0 | Business Card 레코드 | ✅ 구현+자동테스트 |  | business_cards | capture | services/api/test/api.integration.test.ts |  |
| F-067 | P0 | Encounter | ✅ 구현+자동테스트 | 타임라인 | /contacts/{id}/encounters | relationship | services/api/test/api.integration.test.ts |  |
| F-068 | P0 | Relationship | ✅ 구현+자동테스트 |  |  | relationship | services/api/test/api.integration.test.ts |  |
| F-069 | P1 | 회사 엔터티 | 🟢 구현 | /app/people (회사별 그룹) |  | relationship.upsertCompany |  |  |
| F-070 | P0 | 태그 | 🟢 구현 | /app/people, /app/scan | /contacts (tags) | relationship |  |  |
| F-071 | P1 | 자연어 검색 | ✅ 구현+자동테스트 | /app/ai | /ai/search | ai.relationshipSearch | services/api/test/api.integration.test.ts | 어휘+기간 해석. 임베딩 검색 미구현 |
| F-072 | P0 | 중복 병합 | ✅ 구현+자동테스트 | /app/people/[id] | /contacts/{id}/merge | relationship | services/api/test/api.integration.test.ts |  |
| F-073 | P0 | 변경 이력 | ✅ 구현+자동테스트 | /app/people/[id] 타임라인 | /contacts/{id} | relationship (contact_field_history) | services/api/test/assist.integration.test.ts | 필드 단위 이전값→새값 |
| F-074 | P2 | 관계 강도 | 🟡 부분 |  |  | worker (strength nudge) |  |  |
| F-075 | P0 | 개인 메모 | ✅ 구현+자동테스트 | /app/people/[id] | /contacts/{id}/notes | relationship | services/api/test/api.integration.test.ts | 항상 private |
| F-076 | P1 | 공유 메모 | ⬜ 미착수 |  |  |  |  |  |
| F-077 | P1 | 담당자/소유자 | ⬜ 미착수 |  |  |  |  |  |
| F-078 | P0 | 연락 필요일 | 🟢 구현 | /app/people | /followups | meeting.createFollowup |  | relationships.next_followup_at |
## MEET · Meeting Intelligence

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-079 | P0 | Meeting Card | ✅ 구현+자동테스트 | /app/meetings/[id] | /meetings | meeting | services/api/test/api.integration.test.ts |  |
| F-080 | P0 | 음성 메모 | 🟢 구현 | /app/people/[id] 마이크 버튼 | /contacts/{id}/notes (kind=voice) | Web Speech API |  | 기기 음성인식 지원 브라우저에서 받아쓰기; 오디오 서버 미전송 |
| F-081 | P1 | 회의 녹음 | 🟡 부분 | /app/meetings/[id] | /meetings/{id}/recordings | meeting | services/api/test/api.integration.test.ts | 동의 게이트만; 저장소/STT 미연결 시 503 |
| F-082 | P1 | 전사 | ⬜ 미착수 |  |  |  |  | STT 워커 미구현 |
| F-083 | P1 | 화자분리 | ⬜ 미착수 |  |  |  |  |  |
| F-084 | P1 | 회의 요약 | ✅ 구현+자동테스트 | /app/meetings/[id] 자동 정리 | /meetings/{id}/extract | assist (Claude opus-5-5 / rules) | services/api/test/assist.integration.test.ts, tests/scenarios S-078 | ANTHROPIC_API_KEY 설정 시 Claude 요약, 미설정 시 표시된 줄만 |
| F-085 | P1 | To-do 추출 | ✅ 구현+자동테스트 | MeetingEditor | /meetings/{id}/extract | assist | services/api/test/assist.integration.test.ts, tests/scenarios S-078 | 확인 후 적용 |
| F-086 | P1 | 약속 추출 | ✅ 구현+자동테스트 | MeetingEditor | /meetings/{id}/extract | assist | services/api/test/assist.integration.test.ts | 확인 후 적용 |
| F-087 | P1 | 일정 후보 | 🟡 부분 | MeetingEditor | /meetings/{id}/extract (nextMeetingHint) | assist | services/api/test/assist.integration.test.ts | 후보 문구 추출만, 캘린더 연동 미구현 |
| F-088 | P1 | CRM 연결 | ⬜ 미착수 |  |  |  |  |  |
| F-089 | P1 | Meeting Prep | ✅ 구현+자동테스트 | /app/meetings/[id] | /meetings/{id}/brief | meeting.getMeetingBrief | services/api/test/api.integration.test.ts |  |
| F-090 | P0 | Recording Consent | ✅ 구현+자동테스트 | /app/meetings/[id] | /meetings/{id}/consent | domain/consent | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/scenarios S-074~S-076 |  |
## AI · Relationship AI & Match

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-091 | P0 | AI 프로필 요약 | ✅ 구현+자동테스트 | /app/people/[id] 요약 | /profiles/{id}/summary | assist | services/api/test/assist.integration.test.ts | Claude 또는 규칙 요약, 확인 라벨 |
| F-092 | P1 | Need↔Offer 매칭 | ✅ 구현+자동테스트 | /app/ai | /matches | domain/match | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts |  |
| F-093 | P1 | Match Explanation | ✅ 구현+자동테스트 | /app/ai | /matches | domain/match (reasons) | packages/domain/test/domain.test.ts |  |
| F-094 | P1 | 관계 기억 질의 | ✅ 구현+자동테스트 | /app/ai | /ai/search | ai | services/api/test/api.integration.test.ts |  |
| F-095 | P0 | Follow-up 추천 | ✅ 구현+자동테스트 | /app, /app/people/[id] | /followups | handoff (thank-you draft) | services/api/test/api.integration.test.ts | 초안만, 자동 발송 없음 |
| F-096 | P1 | Pre-meeting Brief | ✅ 구현+자동테스트 | /app/meetings/[id] | /meetings/{id}/brief | meeting | services/api/test/api.integration.test.ts |  |
| F-097 | P1 | 소개 추천 | ⬜ 미착수 |  |  |  |  |  |
| F-098 | P2 | 미접촉 위험 | ⬜ 미착수 |  |  |  |  |  |
| F-099 | P2 | Opportunity Detection | ⬜ 미착수 |  |  |  |  |  |
| F-100 | P0 | 데이터 출처 표기 | ✅ 구현+자동테스트 | ReviewFields, PersonDetail |  | contacts.field_provenance | services/api/test/api.integration.test.ts |  |
| F-101 | P0 | 환각 방지 | ✅ 구현+자동테스트 |  |  | domain/ocrParser.assertGrounded | packages/domain/test/domain.test.ts |  |
| F-102 | P0 | Human Confirmation | ✅ 구현+자동테스트 | ReviewFields, AiLabel | assist(needsConfirmation) |  | services/api/test/assist.integration.test.ts, tests/scenarios S-078,S-080 | AI 결과는 라벨 + 사용자 확인 후 저장 |
## COM · Communication & Scheduling

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-103 | P0 | 전화/메일/메시지 CTA | 🟢 구현 | LivingCard, PersonDetail |  |  |  |  |
| F-104 | P1 | AI 감사메일 | ✅ 구현+자동테스트 | PersonDetail 후속 메일 초안 | /contacts/{id}/draft | assist | services/api/test/assist.integration.test.ts | 자동 발송 없음 |
| F-105 | P1 | 후속 메시지 | 🟢 구현 | PersonDetail (안부/자료 전달 초안, mailto) | /contacts/{id}/draft | assist |  |  |
| F-106 | P1 | 이메일 발송 | ⬜ 미착수 |  |  |  |  | Gmail 발송 미구현 |
| F-107 | P1 | 캘린더 예약 | ⬜ 미착수 |  |  |  |  |  |
| F-108 | P1 | 일정 승인 | ⬜ 미착수 |  |  |  |  |  |
| F-109 | P0 | 리마인더 | ✅ 구현+자동테스트 | /app (후속 필요) | worker.processReminders | followup.due + SMTP | services/api/test/assist.integration.test.ts | 푸시 미구현, 메일은 SMTP 설정 시 |
| F-110 | P2 | Web Push | ⬜ 미착수 |  |  |  |  |  |
| F-111 | P1 | 템플릿 | ⬜ 미착수 |  |  |  |  |  |
| F-112 | P2 | 언어 번역 | ⬜ 미착수 |  |  |  |  |  |
## INT · Integrations & Export

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-113 | P0 | Google Contacts | ✅ 구현+자동테스트 | /app/settings | /integrations/google/contacts/sync | integration | services/api/test/google.integration.test.ts | 가짜 Google 서버로 생성·etag 갱신·재시도·토큰 갱신 검증. 실제 Google 샌드박스 검증은 OAuth 클라이언트 필요 |
| F-114 | P0 | Google OAuth | ✅ 구현+자동테스트 | /login, /app/settings | /auth/google, /integrations/google/* | integration | services/api/test/google.integration.test.ts, tests/scenarios S-094 | 서명된 state, 자격증명 AES-GCM 암호화. 실계정 검증은 OAuth 클라이언트 필요 |
| F-115 | P1 | Gmail | ⬜ 미착수 |  |  |  |  |  |
| F-116 | P1 | Google Drive | 🟡 부분 |  |  | drive.file scope | services/api/test/google.integration.test.ts | Sheets 생성에만 사용; Drive 파일 저장 기능 미구현 |
| F-117 | P1 | Google Sheets | ✅ 구현+자동테스트 | /app/settings → Google Sheets로 내보내기 | /integrations/google/sheets/export | integration.exportToGoogleSheets | services/api/test/google.integration.test.ts | 새 스프레드시트 생성 + RAW 값 기록(수식 실행 방지). 실계정 검증은 OAuth 클라이언트 필요 |
| F-118 | P1 | Google Calendar | ⬜ 미착수 |  |  |  |  |  |
| F-119 | P2 | Outlook/Microsoft | ⬜ 미착수 |  |  |  |  |  |
| F-120 | P2 | Salesforce | ⬜ 미착수 |  |  |  |  |  |
| F-121 | P2 | HubSpot | ⬜ 미착수 |  |  |  |  |  |
| F-122 | P2 | Dynamics | ⬜ 미착수 |  |  |  |  |  |
| F-123 | P2 | Webhook/Zapier/Make | ⬜ 미착수 |  |  |  |  |  |
| F-124 | P0 | Excel/CSV | ✅ 구현+자동테스트 | /app/settings | /exports | integration.renderExport | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/scenarios S-087,S-088 | XLSX + CSV(수식 주입 방지) |
| F-125 | P0 | Word DOCX | ✅ 구현+자동테스트 | /app/settings (Word) | /exports format=docx | lib/docx | services/api/test/assist.integration.test.ts, tests/scenarios S-089 |  |
| F-126 | P1 | TXT/PDF/vCard | 🟡 부분 | /app/settings | /exports | integration | tests/scenarios S-090 | TXT/vCard/JSON 구현, PDF 미구현 |
| F-127 | P1 | 필드 매핑 | 🟢 구현 | /app/settings | /exports (fields) |  |  |  |
| F-128 | P0 | Sync Journal | 🟢 구현 | /app/settings | /integrations | sync_jobs + external_mappings | services/api/test/google.integration.test.ts | 작업 이력·재시도·dead 상태 |
## ENT · Enterprise & Admin

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-129 | P1 | 조직/워크스페이스 | ⬜ 미착수 |  |  |  |  |  |
| F-130 | P1 | 역할 권한 | ⬜ 미착수 |  |  |  |  |  |
| F-131 | P1 | 팀 주소록 | ⬜ 미착수 |  |  |  |  |  |
| F-132 | P1 | 회사 소유 리드 | ⬜ 미착수 |  |  |  |  |  |
| F-133 | P2 | 관계 그래프 | ⬜ 미착수 |  |  |  |  |  |
| F-134 | P2 | Who Knows Whom | ⬜ 미착수 |  |  |  |  |  |
| F-135 | P1 | 활동 대시보드 | 🟡 부분 | /app/insights | /insights/kpis | analytics | services/api/test/api.integration.test.ts | 개인 범위 |
| F-136 | P1 | Data Retention | 🟡 부분 |  |  | worker (OTP/idempotency 정리) |  |  |
| F-137 | P0 | 감사로그 | ✅ 구현+자동테스트 |  | /me/audit | platform.audit | services/api/test/api.integration.test.ts |  |
| F-138 | P1 | 브랜딩 | ⬜ 미착수 |  |  |  |  |  |
| F-139 | P2 | 정책 강제 | ⬜ 미착수 |  |  |  |  |  |
| F-140 | P2 | API 키 | ⬜ 미착수 |  |  |  |  |  |
## EVT · Events & Networking

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-141 | P1 | 행사 공간 | ✅ 구현+자동테스트 | /app/events | /events | event | services/api/test/api.integration.test.ts |  |
| F-142 | P1 | 참가자 등록 | ✅ 구현+자동테스트 | /app/events | /events/join | event | services/api/test/api.integration.test.ts | opt-in |
| F-143 | P1 | 현장 교환 | 🟢 구현 | /app/exchange (장소) |  |  |  |  |
| F-144 | P1 | 배지 OCR | ⬜ 미착수 |  |  |  |  |  |
| F-145 | P2 | AI Match List | ✅ 구현+자동테스트 | /app/events/[id] | /events/{id}/matches | event | services/api/test/api.integration.test.ts | P2 선구현 |
| F-146 | P2 | 미팅 요청 | ⬜ 미착수 |  |  |  |  |  |
| F-147 | P2 | 부스 Lead Flow | ⬜ 미착수 |  |  |  |  |  |
| F-148 | P1 | 그룹 교환 | ✅ 구현+자동테스트 | /app/exchange?group=1 |  | handoff | services/api/test/api.integration.test.ts |  |
| F-149 | P2 | Event ROI | ⬜ 미착수 |  |  |  |  |  |
| F-150 | P1 | 오프라인 모드 | ⬜ 미착수 |  |  |  |  |  |
| F-151 | P2 | 주최자 API | ⬜ 미착수 |  |  |  |  |  |
## INTRO · Introductions & Connection Rooms

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-152 | P1 | AI 소개 후보 | ⬜ 미착수 |  |  |  |  |  |
| F-153 | P1 | 소개 동의 | ✅ 구현+자동테스트 | /app/intros | /introductions/{id}/consent | connection | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/scenarios S-081,S-082 |  |
| F-154 | P1 | Connection Room | ✅ 구현+자동테스트 | /app/rooms/[id] | /rooms/{id} | connection | services/api/test/api.integration.test.ts, tests/scenarios S-083 |  |
| F-155 | P1 | 3자 소개 메시지 | ⬜ 미착수 |  |  |  |  |  |
| F-156 | P1 | 공유 파일 | ⬜ 미착수 |  |  |  |  |  |
| F-157 | P1 | 미팅 예약 | ⬜ 미착수 |  |  |  |  |  |
| F-158 | P2 | Room 요약 | ⬜ 미착수 |  |  |  |  |  |
| F-159 | P2 | 소개 성과 | ⬜ 미착수 |  |  |  |  |  |
## SEC · Privacy, Security & Compliance

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-160 | P0 | 필드 단위 ACL | ✅ 구현+자동테스트 | CardEditor |  | domain/acl | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts |  |
| F-161 | P0 | Consent Ledger | ✅ 구현+자동테스트 | /app/settings | /me/consents | consent_records | services/api/test/api.integration.test.ts |  |
| F-162 | P0 | 데이터 최소화 | 🟢 구현 |  |  | on-device OCR, 선택 필드만 전송 |  |  |
| F-163 | P0 | 암호화 | 🟡 부분 |  |  | AES-256-GCM 자격증명, TLS(HSTS) |  | DB at-rest 암호화는 인프라 설정 |
| F-164 | P0 | 테넌트 격리 | ✅ 구현+자동테스트 |  |  | owner-scoped queries | services/api/test/api.integration.test.ts, tests/scenarios S-018,S-019,S-034,S-069,S-086,S-091 | 개인 범위 격리. 조직 테넌트 미구현 |
| F-165 | P0 | 비밀관리 | 🟢 구현 |  |  | .env.example, render.yaml |  |  |
| F-166 | P0 | 감사 추적 | ✅ 구현+자동테스트 |  |  | audit_logs | services/api/test/api.integration.test.ts |  |
| F-167 | P0 | 삭제/탈퇴 | ✅ 구현+자동테스트 | /app/settings | /me/privacy/delete | security | services/api/test/api.integration.test.ts, tests/scenarios S-093 | 7일 유예 후 하드 삭제 |
| F-168 | P1 | 데이터 이동성 | ✅ 구현+자동테스트 | /app/settings | /me/privacy/export | security | services/api/test/api.integration.test.ts, tests/scenarios S-092 |  |
| F-169 | P0 | 녹음 준수 | ✅ 구현+자동테스트 |  | /meetings/{id}/recordings | meeting | services/api/test/api.integration.test.ts |  |
| F-170 | P0 | Rate Limit | 🟢 구현 |  | all | platform.rateLimit |  |  |
| F-171 | P0 | Anti-enumeration | ✅ 구현+자동테스트 |  | /exchange | high-entropy tokens + short-code rate limit | packages/domain/test/domain.test.ts, tests/scenarios S-030 |  |
| F-172 | P1 | Malware Scan | ⬜ 미착수 |  |  |  |  | 업로드 없음(사진은 기기 내 처리) |
| F-173 | P0 | DLP/PII 로그 마스킹 | ✅ 구현+자동테스트 |  |  | domain/redact | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts |  |
## OPS · Platform, Offline, Quality & Ops

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-174 | P0 | PWA | 🟢 구현 | manifest, sw.js |  |  |  |  |
| F-175 | P0 | Responsive UX | ✅ 구현+자동테스트 | all |  |  | tests/e2e/guest-exchange.spec.ts, tests/scenarios S-095~S-098 | iPhone SE / Android 360 / iPad / 데스크톱 |
| F-176 | P1 | 접근성 | 🟡 부분 |  |  |  | tests/scenarios S-099,S-100 | 키보드·포커스·모션감소 자동테스트. 전체 axe 감사 미실시 |
| F-177 | P0 | 다국어 | ✅ 구현+자동테스트 | /x/[token] 언어 선택 |  | packages/domain/src/i18n.ts (ko/en/ja 리소스, pickLocale) | packages/domain/test/i18n.test.ts, tests/e2e/i18n.spec.ts | 게스트 수신·링크 상태 화면 ko/en/ja(Accept-Language·?lang·쿠키). 앱 내부 화면은 한국어 — 리소스 분리 구조로 확장 |
| F-178 | P1 | 오프라인 캡처 | ⬜ 미착수 |  |  |  |  |  |
| F-179 | P0 | 재동기화 | 🟡 부분 |  |  | Idempotency-Key, sync_jobs | tests/scenarios S-026,S-027 |  |
| F-180 | P0 | 관찰성 | 🟢 구현 |  | /metrics, /health | platform.recordRequest (Prometheus) |  | 라우트별 지연 히스토그램·오류 카운터. 분산 트레이싱 미구현 |
| F-181 | P1 | Feature Flag | ⬜ 미착수 |  |  |  |  |  |
| F-182 | P0 | 모바일 딥링크 | 🟡 부분 |  |  | AASA 자리표시자 |  |  |
| F-183 | P0 | CI/CD | ✅ 구현+자동테스트 |  |  | .github/workflows/ci.yml |  | typecheck·unit·integration·migrate·traceability·build·e2e·100 시나리오·docker |
| F-184 | P0 | 백업/복구 | 🟢 구현 |  |  | scripts/backup.sh, scripts/restore-drill.sh |  | 로컬 복구 리허설 통과(12개 핵심 테이블 행 수 일치). 운영은 관리형 PITR 병행 |
| F-185 | P0 | 성능예산 | ✅ 구현+자동테스트 |  |  | scripts/loadtest.mjs |  | 5,000 연락처·동시 20, 8개 시나리오 p95 SLO 통과(통계 낡은 최악 조건 포함) |
| F-186 | P1 | 재해복구 | 🟡 부분 |  |  | scripts/restore-drill.sh |  | DB 복구 리허설만; 리전 장애 DR 미구현 |
| F-187 | P1 | 비용계측 | ⬜ 미착수 |  |  |  |  |  |
## BIZ · Analytics, Billing & Growth

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-188 | P1 | 제품 분석 | 🟡 부분 | /app/insights | /insights/kpis | analytics | services/api/test/api.integration.test.ts |  |
| F-189 | P1 | 바이럴 계수 | 🟡 부분 | /app/insights |  | analytics (claim rate) |  |  |
| F-190 | P1 | 개인 플랜 | ⬜ 미착수 |  |  |  |  |  |
| F-191 | P1 | 기업 플랜 | ⬜ 미착수 |  |  |  |  |  |
| F-192 | P1 | 사용량 계량 | ⬜ 미착수 |  |  |  |  |  |
| F-193 | P2 | 결제 | ⬜ 미착수 |  |  |  |  |  |
| F-194 | P2 | 구독 관리 | ⬜ 미착수 |  |  |  |  |  |
| F-195 | P2 | 관리자 매출지표 | ⬜ 미착수 |  |  |  |  |  |
| F-196 | P1 | 실험 프레임워크 | ⬜ 미착수 |  |  |  |  |  |
| F-197 | P3 | Referral Reward | ⬜ 미착수 |  |  |  |  |  |
