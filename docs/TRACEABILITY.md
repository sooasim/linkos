# LINKOS TRACEABILITY

> 자동 생성: `pnpm traceability` (source: `dd/LINKOS_Product_Blueprint_v1/03_FEATURE_REGISTRY.yaml`). 직접 편집하지 말고 `scripts/traceability.mjs` 의 매핑을 수정하세요.

백서 부록 B 규칙: Feature ID → UX → API → module → DB → event → test → deploy 중 하나라도 비면 "완료"가 아니다. **아래 표는 현재 상태를 정직하게 기록하며, Production Ready 배지는 아직 부여하지 않는다.**

## 요약

| 우선순위 | 전체 | ✅ T | 🟢 I | 🟡 P | ⬜ N |
|---|---|---|---|---|---|
| P0 | 81 | 78 | 2 | 1 | 0 |
| P1 | 85 | 83 | 1 | 1 | 0 |
| P2 | 29 | 28 | 1 | 0 | 0 |
| P3 | 2 | 2 | 0 | 0 | 0 |
| 합계 | 197 | 191 | 4 | 2 | 0 |

## IAM · Identity & Onboarding

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-001 | P0 | 회원가입/로그인 | ✅ 구현+자동테스트 | /login | /auth/otp, /auth/verify, /auth/google, /auth/apple, /auth/passkey/* | identity, apple, passkey | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts, tests/scenarios S-001~S-006, services/api/test/apple.integration.test.ts | Email OTP + Google OIDC + Sign in with Apple + 패스키 |
| F-002 | P0 | 게스트 세션 | ✅ 구현+자동테스트 | /x/[token], /c/[code] | /exchange/sessions/{token} | handoff | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-003 | P0 | 계정 Claim | ✅ 구현+자동테스트 | /claim | /guest/claim | handoff.claimGuest | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-004 | P1 | 조직 가입 | ✅ 구현+자동테스트 | /join/[token], /app/org/members | /orgs/{id}/invites | modules/org.ts | services/api/test/track-a.integration.test.ts, packages/domain/test/org.test.ts | 이메일 바인딩 초대·만료·회수, 인증 도메인 자동가입/승인 |
| F-005 | P1 | 다중 프로필 | ✅ 구현+자동테스트 | /app/me/edit?new=1 | /profiles | card | services/api/test/audit.integration.test.ts |  |
| F-006 | P1 | Passkey | ✅ 구현+자동테스트 | /login, /app/settings | /auth/passkey/* | modules/passkey.ts (@simplewebauthn) | services/api/test/track-a.integration.test.ts | ES256 소프트 인증기로 등록·로그인·재사용·origin·카운터 검증. 실브라우저 플로우는 수동 검증 필요 |
| F-007 | P0 | 세션 보안 | ✅ 구현+자동테스트 | /app/settings | /me/devices | identity.resolveSession | services/api/test/api.integration.test.ts, tests/scenarios S-004,S-006,S-010 | refresh rotation + reuse detection + device revoke |
| F-008 | P2 | B2B SSO | ✅ 구현+자동테스트 | /login (회사 SSO), /app/org/settings | /auth/sso/*, /sso/saml/{orgId}/{metadata,acs}, /scim/v2/* | modules/enterprise.ts, saml.ts (@node-saml/node-saml), ssoLogin.ts, ssoPolicy.ts | services/api/test/saml.integration.test.ts, services/api/test/track-a.integration.test.ts, packages/domain/test/sso.test.ts | OIDC + SAML 2.0(SP-initiated, 서명·XSW·재생 방어, 인증서 교체) + SCIM + sso_required 강제(Owner OTP break-glass). IdP-initiated·SLO·암호화 assertion 미지원 |
| F-009 | P0 | 연령/약관 동의 | ✅ 구현+자동테스트 | /login (consent step) | /auth/verify, /me/consents | identity | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
## CAP · Capture & OCR

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-010 | P0 | 카메라 명함 촬영 | ✅ 구현+자동테스트 | /app/scan |  | packages/domain/src/imaging.ts, lib/imagePipeline.ts | packages/domain/test/imaging.test.ts | 테두리 검출·원근 보정·대비 보정(합성 이미지 단위테스트). 실 OCR 브라우저 테스트는 CDN 데이터 필요로 미실시 |
| F-011 | P0 | 앞·뒤면 병합 | ✅ 구현+자동테스트 | /app/scan | /capture/cards (backLines) | capture | services/api/test/audit.integration.test.ts |  |
| F-012 | P1 | 사진첩 일괄 가져오기 | ✅ 구현+자동테스트 | /app/scan/import | /capture/cards | BatchImport.tsx (암호화 온디바이스 큐) | tests/e2e/batch-import.spec.ts | 200장 상한·암호화 큐 적재·새로고침 재개를 브라우저에서 검증. 기기 OCR 엔진은 CDN 언어 데이터가 필요해 e2e 에서 제외(파서는 S-051~S-062). 페이지가 열려 있을 때만 진행 |
| F-013 | P1 | 다중 명함 분리 | ✅ 구현+자동테스트 | /app/scan |  | packages/domain/src/imaging.ts | packages/domain/test/imaging.test.ts | 한 장에 여러 명함 분할 |
| F-014 | P1 | 배지 스캔 | ✅ 구현+자동테스트 | /app/events/[id] | /events/{id}/leads | packages/domain/src/badge.ts | services/api/test/track-c.integration.test.ts, packages/domain/test/track-c.test.ts, tests/scenarios/k-capture-files.spec.ts | 배지 파서 → 행사 리드(단일 트랜잭션) |
| F-015 | P0 | OCR 다국어 | 🟢 구현 | /app/scan (언어 선택) | /capture/parse | tesseract.js kor/jpn/chi_sim + parser | packages/domain/test/domain.test.ts, tests/scenarios S-051~S-054 | 구조화 파서는 4개 언어 자동테스트; 기기 OCR 엔진 자체는 실기기 수동 검증 |
| F-016 | P0 | AI 필드 구조화 | ✅ 구현+자동테스트 | /app/scan | /capture/cards, /capture/parse | domain/ocrParser | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts | 규칙 기반 구조화(원문 외 값 생성 금지) |
| F-017 | P0 | 신뢰도 표시 | ✅ 구현+자동테스트 | ReviewFields | /capture/cards | domain/ocrParser | packages/domain/test/domain.test.ts | 필드별 confidence + bbox |
| F-018 | P0 | 저신뢰 검토 | ✅ 구현+자동테스트 | ReviewFields |  | domain.needsReview | packages/domain/test/domain.test.ts |  |
| F-019 | P0 | 명함 원본 보관 | ✅ 구현+자동테스트 | /app/scan, /app/people/[id] (명함 원본 패널) | /files/{id} | lib/storage.ts, modules/files.ts (파일별 AES-256-GCM) | services/api/test/track-c.integration.test.ts, tests/e2e/people-gaps.spec.ts | 로컬/S3 호환, 서명 URL 5~10분, 보존기간 후 삭제. 게스트 플로우는 업로드 안 함 |
| F-020 | P0 | 중복 후보 탐지 | ✅ 구현+자동테스트 | /app/scan, /app/people/[id] | /contacts/duplicates | domain/duplicate | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts |  |
| F-021 | P0 | 정보 병합 | ✅ 구현+자동테스트 | /app/people/[id] | /contacts/{id}/merge, /merge/undo | relationship.mergeContact | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts | 필드별 선택 + undo |
## CARD · Living Business Card

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-022 | P0 | 3초 카드 | ✅ 구현+자동테스트 | LivingCard 3초 | /profiles | card | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts, packages/domain/test/cardDesign.test.ts, services/api/test/card-templates.integration.test.ts, tests/e2e/card-templates.spec.ts | 3초 카드 + 디자인 스튜디오(X-008): 오리지널 템플릿 50종(8 레이아웃·8 카테고리, 전 템플릿 WCAG AA 자동 검사), 아이콘 291·이모지 912 뱅크, 업종별 추천 |
| F-023 | P0 | 30초 카드 | ✅ 구현+자동테스트 | LivingCard 30초 | /profiles | card | services/api/test/audit.integration.test.ts |  |
| F-024 | P1 | 딥 프로필 | ✅ 구현+자동테스트 | LivingCard 딥 | /profiles, /profiles/{id}/media | card, files.addProfileMedia | services/api/test/track-c.integration.test.ts | 미디어/파일 업로드 포함(최대 21MB, 악성코드 검사 후 암호화 저장, 공개범위별 ACL 필터) |
| F-025 | P0 | Offer | ✅ 구현+자동테스트 | CardEditor | /profiles | card | services/api/test/api.integration.test.ts |  |
| F-026 | P0 | Need | ✅ 구현+자동테스트 | CardEditor | /profiles | card | services/api/test/api.integration.test.ts |  |
| F-027 | P1 | Interest | ✅ 구현+자동테스트 | CardEditor | /profiles | card (deep.interests) | services/api/test/audit.integration.test.ts |  |
| F-028 | P1 | Asset | ✅ 구현+자동테스트 | CardEditor | /profiles | card (deep.assets) | services/api/test/audit.integration.test.ts |  |
| F-029 | P1 | Network | ✅ 구현+자동테스트 | CardEditor | /profiles | card (deep.network) | services/api/test/audit.integration.test.ts |  |
| F-030 | P1 | Project | ✅ 구현+자동테스트 | CardEditor | /profiles | card (deep.projects) | services/api/test/audit.integration.test.ts |  |
| F-031 | P1 | 프로필 변형 | ✅ 구현+자동테스트 | /x/[token], /app/me/edit (상대별 미리보기) |  | living.adaptCardForSession | services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts, tests/e2e/settings-gaps.spec.ts | 세션 audience 에 따라 변형 자동 선택 |
| F-032 | P2 | AI Adaptive Card | ✅ 구현+자동테스트 | /app/me/edit | /profiles/{id}/adaptive, /profiles/{id}/adaptive/confirm | living.adaptiveSuggest | services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts | 규칙 경로 테스트; Claude 경로는 미검증 |
| F-033 | P1 | Living Update | ✅ 구현+자동테스트 | /app/inbox | /living-updates | living.fanOutLivingUpdate | services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts | 연결 상대에게 갱신 알림, 수락 시 provenance=sync |
| F-034 | P0 | 공개범위 | ✅ 구현+자동테스트 | CardEditor | /p/{slug}, /exchange/sessions/{token} | domain/acl | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/scenarios S-014~S-016,S-037 |  |
| F-035 | P1 | Access Request | ✅ 구현+자동테스트 | /p/[slug], /app/me | /profiles/{id}/access-requests, /access-requests | card | tests/scenarios S-016 |  |
| F-036 | P0 | Action Card | ✅ 구현+자동테스트 | LivingCard, /app/me/edit (Action Card 설정), /app/inbox (받은 요청) | /action-requests, /action-requests/{id} | LivingCard (tel/mailto/vCard), components/ActionCtas.tsx, living.listActionRequests | services/api/test/track-d.integration.test.ts, services/api/test/qa-api.integration.test.ts | 예약·견적·제안·NDA 요청 CTA 구현. 로그인 없이 보내고 rate limit 적용, 받은 요청은 알림함에서 답장·완료·거절 |
## XCH · Adaptive Handoff & Exchange

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-037 | P0 | 공유 1탭 | ✅ 구현+자동테스트 | /app/exchange | /exchange/sessions | handoff | tests/e2e/guest-exchange.spec.ts, services/api/test/backend-gaps.integration.test.ts, packages/domain/test/backend-gaps.test.ts |  |
| F-038 | P0 | Capability Detection | ✅ 구현+자동테스트 | ExchangeConsole.detectCapabilities | /exchange/sessions | domain/handoff | packages/domain/test/domain.test.ts |  |
| F-039 | P1 | 앱 근접 교환 | 🟢 구현 | apps/mobile ProximityStep | /exchange/manage/{id}/proximity, /exchange/proximity/resolve, /exchange/proximity/matches/{id}/confirm | modules/channels.ts, packages/domain/src/pairing.ts | services/api/test/track-e.integration.test.ts, packages/domain/test/native-channels.test.ts | 서버·규칙 테스트. BLE 실기기 동작·RSSI 보정 미검증 |
| F-040 | P2 | 근접 확인 | 🟢 구현 | apps/mobile | /exchange/proximity/matches/{id}, /exchange/proximity/matches/{id}/confirm | modules/channels.ts | services/api/test/track-e.integration.test.ts, packages/domain/test/native-channels.test.ts | 4자리 상호 확인 후 원자적 교환. 실기기 미검증 |
| F-041 | P0 | OS Share | ✅ 구현+자동테스트 | /app/exchange | /exchange/manage/{id}/attempts | handoff | tests/e2e/audit-extras.spec.ts | navigator.share — 헤드리스 테스트 불가 |
| F-042 | P1 | iOS App Clip | 🟡 부분 | apps/ios-app-clip |  | SwiftUI App Clip |  | 코드 작성; Swift 툴체인이 없어 컴파일 미검증. TEAMID 자리표시자 |
| F-043 | P0 | Android PWA Landing | ✅ 구현+자동테스트 | /x/[token] (PWA) |  | web | tests/e2e/guest-exchange.spec.ts |  |
| F-044 | P1 | NFC 액세서리 | ✅ 구현+자동테스트 | /app/exchange | /nfc-tags, /n/{tagId} | modules/channels.ts | services/api/test/track-e.integration.test.ts | 128bit 태그 해시 저장, 1회성 세션 생성, rate limit |
| F-045 | P1 | 단축코드 수신 | ✅ 구현+자동테스트 | /c, /c/[code] | /exchange/sessions/{code} | handoff, packages/domain/src/codeGuard.ts | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts, services/api/test/code-guard.integration.test.ts, packages/domain/test/codeGuard.test.ts | 틀린 코드만 센다(IP 10분 8회·하루 30회). 전역 압력은 전면 차단이 아니라 IP별 허용치를 좁히는 신호 — 전면 차단은 self-DoS 였다 |
| F-046 | P1 | 웹-웹 페어링 | ✅ 구현+자동테스트 | /c, /app/exchange | /exchange/manage/{id}/rendezvous, /exchange/rendezvous, /exchange/rendezvous/{listenToken} | components/ReceiveMode.tsx | services/api/test/track-e.integration.test.ts | 4자리 90초 코드, 8회 시도 제한 |
| F-047 | P3 | 음향 페어링 실험 | ✅ 구현+자동테스트 | /app/exchange |  | packages/domain/src/acoustic.ts | packages/domain/test/native-channels.test.ts | P3 실험(기본 꺼짐). 실제 스피커/마이크 미검증 |
| F-048 | P0 | QR 최종 폴백 | ✅ 구현+자동테스트 | /app/exchange | /exchange/manage/{id}/attempts | domain/handoff | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-049 | P0 | 교환 상호 동의 | ✅ 구현+자동테스트 | GuestFlow consent | /exchange/sessions/{token}/reply | handoff | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-050 | P0 | 토큰 보안 | ✅ 구현+자동테스트 |  | /exchange/sessions | domain/token | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/scenarios S-028,S-030 | 192-bit, SHA-256 해시 저장, TTL, 1회성, revoke, rate limit |
| F-051 | P1 | 그룹 교환 | ✅ 구현+자동테스트 | /app/exchange?group=1 | /exchange/sessions (group) | handoff | services/api/test/api.integration.test.ts, tests/scenarios S-035 | 정원 초과 409 |
| F-052 | P2 | 오프라인 큐 | ✅ 구현+자동테스트 | /app/exchange (앱) | /exchange/offline-receipts | packages/domain/src/hmac.ts, offlineQueue.ts | services/api/test/track-e.integration.test.ts, tests/e2e/offline-sync.spec.ts | 기기 HMAC 서명 패스+영수증 검증, 멱등 동기화. 네이티브 앱 실기기 미검증 |
## GST · Guest Viral Conversion

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-053 | P0 | 비회원 즉시 열람 | ✅ 구현+자동테스트 | /x/[token], /x/[token] (리뷰 단계 → CONSENT_PENDING) | /exchange/sessions/{token} | handoff | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts, services/api/test/backend-gaps.integration.test.ts, tests/e2e/i18n-app-voice.spec.ts |  |
| F-054 | P0 | 즉시 회신 CTA | ✅ 구현+자동테스트 | GuestFlow |  |  | tests/e2e/guest-exchange.spec.ts |  |
| F-055 | P0 | 게스트 명함 촬영 | 🟢 구현 | GuestFlow + CardScanner | /capture/parse | domain/ocrParser | tests/scenarios S-051~S-062 | 파서 자동테스트; 카메라 촬영은 실기기 수동 검증 |
| F-056 | P0 | 게스트 직접입력 | ✅ 구현+자동테스트 | GuestFlow | /exchange/sessions/{token}/reply | handoff | tests/e2e/guest-exchange.spec.ts |  |
| F-057 | P2 | Contact Picker 보조 | ✅ 구현+자동테스트 | /x/[token] |  | GuestFlow Contact Picker | tests/e2e/audit-extras.spec.ts | 지원 브라우저에서만 버튼 표시. 브라우저 미검증 |
| F-058 | P0 | 회신 동의 | ✅ 구현+자동테스트 | ReviewFields(selectable) | /exchange/sessions/{token}/reply | handoff | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts | 체크한 필드만 전송 |
| F-059 | P0 | 가입 후 Claim | ✅ 구현+자동테스트 | /claim | /guest/claim | handoff | services/api/test/api.integration.test.ts, tests/e2e/guest-exchange.spec.ts |  |
| F-060 | P0 | One Tap 가입 | ✅ 구현+자동테스트 | /login, /claim | /auth/google/onetap, /auth/apple, /auth/apple/callback | modules/identity.ts, modules/apple.ts | services/api/test/track-e.integration.test.ts, services/api/test/apple.integration.test.ts | Google One Tap + Sign in with Apple(form_post, nonce, ES256 client secret, 신규 가입 동의 단계). 가짜 서버로 검증 — 실제 Apple/Google 계정은 스테이징 수동 확인 필요 |
| F-061 | P0 | 프로필 자동완성 | ✅ 구현+자동테스트 | /claim | /guest/claim | handoff.claimGuest | services/api/test/api.integration.test.ts | 초안으로 Living Card 자동 생성 |
| F-062 | P1 | Offer/Need 2문항 | ✅ 구현+자동테스트 | GuestFlow, CardEditor |  |  | services/api/test/api.integration.test.ts |  |
| F-063 | P1 | 첫 공유 유도 | ✅ 구현+자동테스트 | ExchangeConsole '다음 사람과 교환', /app?welcome=1 (첫 공유 카드) |  |  | tests/e2e/audit-extras.spec.ts, tests/e2e/people-gaps.spec.ts |  |
| F-064 | P1 | Referral Attribution | ✅ 구현+자동테스트 | /r/[code], /app/settings | /referrals | modules/referral.ts | services/api/test/track-a.integration.test.ts, services/api/test/whitepaper-gaps.integration.test.ts | Claim·조직초대·추천링크 귀속(신규 계정만). Google 로그인 콜백 미연결 |
## REL · Contacts & Relationship Core

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-065 | P0 | Contact 레코드 | ✅ 구현+자동테스트 | /app/people, /app/people (직접 추가) | /contacts | relationship | services/api/test/api.integration.test.ts, tests/e2e/people-gaps.spec.ts |  |
| F-066 | P0 | Business Card 레코드 | ✅ 구현+자동테스트 | /app/people/[id] (명함 원본) | business_cards | capture | services/api/test/api.integration.test.ts, tests/e2e/people-gaps.spec.ts |  |
| F-067 | P0 | Encounter | ✅ 구현+자동테스트 | 타임라인, /app/people/[id] (만남 기록 폼) | /contacts/{id}/encounters | relationship | services/api/test/api.integration.test.ts, tests/e2e/people-gaps.spec.ts, services/api/test/people-gaps.integration.test.ts, services/api/test/backend-gaps.integration.test.ts |  |
| F-068 | P0 | Relationship | ✅ 구현+자동테스트 |  |  | relationship | services/api/test/api.integration.test.ts |  |
| F-069 | P1 | 회사 엔터티 | ✅ 구현+자동테스트 | /app/people (회사별 그룹) |  | relationship.upsertCompany | services/api/test/audit.integration.test.ts |  |
| F-070 | P0 | 태그 | ✅ 구현+자동테스트 | /app/people, /app/scan, /app/people/[id] (태그 편집), /app/people (태그 필터) | /contacts (tags) | relationship | services/api/test/audit.integration.test.ts, tests/e2e/people-gaps.spec.ts, services/api/test/people-gaps.integration.test.ts |  |
| F-071 | P1 | 자연어 검색 | ✅ 구현+자동테스트 | /app/ai | /ai/search | ai.relationshipSearch | services/api/test/api.integration.test.ts | 어휘+기간 해석. 임베딩 검색 미구현 |
| F-072 | P0 | 중복 병합 | ✅ 구현+자동테스트 | /app/people/[id], /app/people (직접 추가 중복 확인) | /contacts/{id}/merge | relationship | services/api/test/api.integration.test.ts, tests/e2e/people-gaps.spec.ts |  |
| F-073 | P0 | 변경 이력 | ✅ 구현+자동테스트 | /app/people/[id] 타임라인 | /contacts/{id} | relationship (contact_field_history) | services/api/test/assist.integration.test.ts | 필드 단위 이전값→새값 |
| F-074 | P2 | 관계 강도 | ✅ 구현+자동테스트 | /app/people/[id] | /contacts/{id}/strength | packages/domain/src/strength.ts | services/api/test/track-a.integration.test.ts, packages/domain/test/org.test.ts | 구성 요인 저장, 워커 재계산 |
| F-075 | P0 | 개인 메모 | ✅ 구현+자동테스트 | /app/people/[id] | /contacts/{id}/notes | relationship | services/api/test/api.integration.test.ts | 항상 private |
| F-076 | P1 | 공유 메모 | ✅ 구현+자동테스트 | /app/people/[id], /app/team (팀 메모 삭제) | /orgs/{id}/contacts/{contactId}/notes, /orgs/{id}/notes/{noteId} | modules/org.ts | services/api/test/track-a.integration.test.ts, services/api/test/settings-gaps.integration.test.ts, tests/e2e/settings-gaps.spec.ts | 팀 메모 — 개인 메모는 팀 뷰·이관에 절대 포함되지 않음을 테스트 |
| F-077 | P1 | 담당자/소유자 | ✅ 구현+자동테스트 | /app/team | /orgs/{id}/contacts/{contactId}/assign | modules/org.ts | services/api/test/track-a.integration.test.ts | 담당자 지정 시 관계·만남 이력 이관 |
| F-078 | P0 | 연락 필요일 | ✅ 구현+자동테스트 | /app/people, /app/people/[id] (후속 할 일 추가·기한) | /followups | meeting.createFollowup | services/api/test/audit.integration.test.ts, tests/e2e/people-gaps.spec.ts, services/api/test/people-gaps.integration.test.ts | relationships.next_followup_at |
## MEET · Meeting Intelligence

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-079 | P0 | Meeting Card | ✅ 구현+자동테스트 | /app/meetings/[id] | /meetings | meeting | services/api/test/api.integration.test.ts |  |
| F-080 | P0 | 음성 메모 | ✅ 구현+자동테스트 | /app/people/[id] 마이크 버튼, /app/exchange (교환 직후 음성 메모 CTA) → /app/people/[id]#note, /app/people/[id] (받아쓰기 타이머·정리하기→후속 할 일 확인) | /contacts/{id}/notes (kind=voice) | Web Speech API | tests/e2e/exchange-events-gaps.spec.ts, tests/e2e/i18n-app-voice.spec.ts | 기기 음성인식 지원 브라우저에서 받아쓰기; 오디오 서버 미전송 |
| F-081 | P1 | 회의 녹음 | ✅ 구현+자동테스트 | /app/meetings/[id] | /meetings/{id}/recordings, /meetings/{id}/recordings/{rid}/parts/{seq}, /meetings/{id}/recordings/{rid}/finalize | modules/recording.ts | services/api/test/track-c.integration.test.ts, tests/e2e/meeting-recording.spec.ts | 동의 후에만 녹음, 50초 단위 업로드, 동의 철회 시 차단 |
| F-082 | P1 | 전사 | ✅ 구현+자동테스트 | /app/meetings/[id] |  | lib/stt.ts (Google STT v2 / Whisper) | services/api/test/track-c.integration.test.ts | 가짜 STT 서버로 검증. 파트 간 화자 라벨 일관성 없음 |
| F-083 | P1 | 화자분리 | ✅ 구현+자동테스트 | /app/meetings/[id] |  | lib/stt.ts + worker | services/api/test/track-c.integration.test.ts | 화자·타임스탬프·언어, meeting.transcript.ready |
| F-084 | P1 | 회의 요약 | ✅ 구현+자동테스트 | /app/meetings/[id] 자동 정리 | /meetings/{id}/extract | assist (Claude opus-5-5 / rules) | services/api/test/assist.integration.test.ts, tests/scenarios S-078 | ANTHROPIC_API_KEY 설정 시 Claude 요약, 미설정 시 표시된 줄만 |
| F-085 | P1 | To-do 추출 | ✅ 구현+자동테스트 | MeetingEditor | /meetings/{id}/extract | assist | services/api/test/assist.integration.test.ts, tests/scenarios S-078 | 확인 후 적용 |
| F-086 | P1 | 약속 추출 | ✅ 구현+자동테스트 | MeetingEditor | /meetings/{id}/extract | assist | services/api/test/assist.integration.test.ts | 확인 후 적용 |
| F-087 | P1 | 일정 후보 | ✅ 구현+자동테스트 | /app/meetings/[id] | /meetings/{id}/schedule | packages/domain/src/scheduling.ts | services/api/test/track-b.integration.test.ts, packages/domain/test/comms.test.ts | 한/영 규칙 파서(날짜 없으면 후보 없음), LLM은 폴백 |
| F-088 | P1 | CRM 연결 | ✅ 구현+자동테스트 | /app/meetings/[id] | /meetings/{id}/crm | modules/crm.ts | services/api/test/track-b.integration.test.ts | Salesforce Task/HubSpot Note/Dynamics annotation |
| F-089 | P1 | Meeting Prep | ✅ 구현+자동테스트 | /app/meetings/[id], /app/meetings (브리프: 지난 미팅·프로필 변경) | /meetings/{id}/brief | meeting.getMeetingBrief | services/api/test/api.integration.test.ts, services/api/test/backend-gaps.integration.test.ts |  |
| F-090 | P0 | Recording Consent | ✅ 구현+자동테스트 | /app/meetings/[id], /app/meetings (녹음 동의 정책 선택) | /meetings/{id}/consent | domain/consent | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/scenarios S-074~S-076, tests/e2e/exchange-events-gaps.spec.ts, services/api/test/exchange-events-gaps.integration.test.ts, packages/domain/test/exchangeEventsGaps.test.ts |  |
## AI · Relationship AI & Match

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-091 | P0 | AI 프로필 요약 | ✅ 구현+자동테스트 | /app/people/[id] 요약 | /profiles/{id}/summary | assist | services/api/test/assist.integration.test.ts | Claude 또는 규칙 요약, 확인 라벨 |
| F-092 | P1 | Need↔Offer 매칭 | ✅ 구현+자동테스트 | /app/ai | /matches | domain/match | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, packages/domain/test/match-privacy.test.ts, services/api/test/backend-gaps.integration.test.ts |  |
| F-093 | P1 | Match Explanation | ✅ 구현+자동테스트 | /app/ai | /matches | domain/match (reasons) | packages/domain/test/domain.test.ts |  |
| F-094 | P1 | 관계 기억 질의 | ✅ 구현+자동테스트 | /app/ai | /ai/search | ai | services/api/test/api.integration.test.ts |  |
| F-095 | P0 | Follow-up 추천 | ✅ 구현+자동테스트 | /app, /app/people/[id] | /followups | handoff (thank-you draft) | services/api/test/api.integration.test.ts | 초안만, 자동 발송 없음 |
| F-096 | P1 | Pre-meeting Brief | ✅ 구현+자동테스트 | /app/meetings/[id], /app/meetings (브리프 히스토리) | /meetings/{id}/brief | meeting | services/api/test/api.integration.test.ts, services/api/test/backend-gaps.integration.test.ts, packages/domain/test/backend-gaps.test.ts |  |
| F-097 | P1 | 소개 추천 | ✅ 구현+자동테스트 | /app/intros | /introductions/suggested, /ai/intro-candidates | modules/network.ts | services/api/test/track-a.integration.test.ts | Need↔Offer+강도, 근거·경로, ai_inferred 라벨 |
| F-098 | P2 | 미접촉 위험 | ✅ 구현+자동테스트 | /app/ai, /app (AI 추천 블록) | /relationships/cooling | modules/network.ts | services/api/test/track-a.integration.test.ts, tests/e2e/people-gaps.spec.ts | VIP·평소 연락 주기 기반 냉각 감지 |
| F-099 | P2 | Opportunity Detection | ✅ 구현+자동테스트 | /app/ai | /ai/opportunities | modules/network.ts | services/api/test/track-a.integration.test.ts | 규칙·키워드 기반(LLM 아님) |
| F-100 | P0 | 데이터 출처 표기 | ✅ 구현+자동테스트 | ReviewFields, PersonDetail |  | contacts.field_provenance | services/api/test/api.integration.test.ts |  |
| F-101 | P0 | 환각 방지 | ✅ 구현+자동테스트 |  |  | domain/ocrParser.assertGrounded | packages/domain/test/domain.test.ts |  |
| F-102 | P0 | Human Confirmation | ✅ 구현+자동테스트 | ReviewFields, AiLabel | assist(needsConfirmation) |  | services/api/test/assist.integration.test.ts, tests/scenarios S-078,S-080 | AI 결과는 라벨 + 사용자 확인 후 저장 |
## COM · Communication & Scheduling

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-103 | P0 | 전화/메일/메시지 CTA | ✅ 구현+자동테스트 | LivingCard, PersonDetail |  |  | tests/e2e/audit-extras.spec.ts |  |
| F-104 | P1 | AI 감사메일 | ✅ 구현+자동테스트 | PersonDetail 후속 메일 초안 | /contacts/{id}/draft | assist | services/api/test/assist.integration.test.ts | 자동 발송 없음 |
| F-105 | P1 | 후속 메시지 | ✅ 구현+자동테스트 | PersonDetail (안부/자료 전달 초안, mailto) | /contacts/{id}/draft | assist | services/api/test/track-b.integration.test.ts, packages/domain/test/comms.test.ts |  |
| F-106 | P1 | 이메일 발송 | ✅ 구현+자동테스트 | /app/messages, /app/messages (초안 삭제) | /messages/{id}/send | modules/comms.ts | services/api/test/track-b.integration.test.ts, services/api/test/settings-gaps.integration.test.ts, tests/e2e/settings-gaps.spec.ts | approved:true 필수, Gmail→Outlook→SMTP, 중복 발송 방지, 감사로그(주소 원문 없음) |
| F-107 | P1 | 캘린더 예약 | ✅ 구현+자동테스트 | /b/[token], /app/calendar | /booking/* | modules/calendar.ts | services/api/test/track-b.integration.test.ts | 로그인 없는 예약 페이지, 슬롯=가용-바쁨-여유시간 |
| F-108 | P1 | 일정 승인 | ✅ 구현+자동테스트 | /app/meetings/[id] | /calendar/candidates/{id}/decision, /calendar/candidates/{id}/ics | modules/calendar.ts | services/api/test/track-b.integration.test.ts | 승인 후 Google 이벤트(클라이언트 id로 중복 방지), If-Match, ICS |
| F-109 | P0 | 리마인더 | ✅ 구현+자동테스트 | /app (후속 필요), /app/people/[id] (리마인더 기한), 알림함 배지 | worker.processReminders | followup.due → push.notify + SMTP | services/api/test/assist.integration.test.ts, tests/e2e/people-gaps.spec.ts, services/api/test/people-gaps.integration.test.ts | followup.due 아웃박스를 워커가 받아 Web Push(F-110) 로 알린다. 메일은 SMTP 설정 시 함께 발송 |
| F-110 | P2 | Web Push | ✅ 구현+자동테스트 | /app/settings, /app/settings (푸시 기록) | /push/* | modules/push.ts (VAPID web-push) | services/api/test/track-b.integration.test.ts, services/api/test/settings-gaps.integration.test.ts, tests/e2e/settings-gaps.spec.ts | 410 구독 삭제, 유형별 설정, 인앱 알림함에도 미러링. iOS는 홈화면 PWA만 |
| F-111 | P1 | 템플릿 | ✅ 구현+자동테스트 | /app/messages | /templates | packages/domain/src/template.ts | services/api/test/track-b.integration.test.ts, packages/domain/test/comms.test.ts | 개인·팀 템플릿, 미지정 변수 거부 |
| F-112 | P2 | 언어 번역 | ✅ 구현+자동테스트 | /app/messages, /app/me/edit (번역본 만들기·검토), /p/[slug]?lang= | /translate | modules/comms.ts (structured()) | services/api/test/track-b.integration.test.ts, services/api/test/card-translations.integration.test.ts, tests/e2e/i18n-app-voice.spec.ts | 메시지 UI만; 카드 번역은 API 전용 |
## INT · Integrations & Export

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-113 | P0 | Google Contacts | ✅ 구현+자동테스트 | /app/settings | /integrations/google/contacts/sync | integration | services/api/test/google.integration.test.ts | 가짜 Google 서버로 생성·etag 갱신·재시도·토큰 갱신 검증. 실제 Google 샌드박스 검증은 OAuth 클라이언트 필요 |
| F-114 | P0 | Google OAuth | ✅ 구현+자동테스트 | /login, /app/settings | /auth/google, /integrations/google/* | integration | services/api/test/google.integration.test.ts, tests/scenarios S-094 | 서명된 state, 자격증명 AES-GCM 암호화. 실계정 검증은 OAuth 클라이언트 필요 |
| F-115 | P1 | Gmail | ✅ 구현+자동테스트 | /app/messages | /messages/{id}/gmail-draft | modules/comms.ts | services/api/test/track-b.integration.test.ts | 가짜 Google 서버로 검증. 실계정 미검증 |
| F-116 | P1 | Google Drive | ✅ 구현+자동테스트 | /app/settings | /integrations/google/drive | modules/integration.ts | services/api/test/track-b.integration.test.ts | drive.file 범위 LINKOS 폴더 |
| F-117 | P1 | Google Sheets | ✅ 구현+자동테스트 | /app/settings → Google Sheets로 내보내기 | /integrations/google/sheets/export | integration.exportToGoogleSheets | services/api/test/google.integration.test.ts | 새 스프레드시트 생성 + RAW 값 기록(수식 실행 방지). 실계정 검증은 OAuth 클라이언트 필요 |
| F-118 | P1 | Google Calendar | ✅ 구현+자동테스트 | /app/calendar | /calendar/* | modules/calendar.ts | services/api/test/track-b.integration.test.ts | 생성·수정·삭제·free/busy (가짜 서버) |
| F-119 | P2 | Outlook/Microsoft | ✅ 구현+자동테스트 | /app/integrations | /integrations/microsoft/* | modules/crm.ts | services/api/test/track-b.integration.test.ts | 푸시 전용(Outlook 연락처 가져오기 없음). 가짜 Graph 서버로 검증 |
| F-120 | P2 | Salesforce | ✅ 구현+자동테스트 | /app/integrations | /integrations/salesforce/* | modules/crm.ts | services/api/test/track-b.integration.test.ts | Contact/Lead upsert, 충돌 처리. 실계정 미검증 |
| F-121 | P2 | HubSpot | ✅ 구현+자동테스트 | /app/integrations, /app/meetings/[id] | /integrations/hubspot/*, /integrations/{provider}/{companies/sync,deals,deal-settings} | modules/crm.ts, modules/crmHubspot.ts, packages/domain/src/crmDeals.ts | services/api/test/track-b.integration.test.ts, services/api/test/hubspot-deals.integration.test.ts, packages/domain/test/crmDeals.test.ts | Contacts·미팅 노트·회사(도메인 중복판정·연결)·딜(초안→사용자 승인 후에만 전송). 가짜 HubSpot 서버로 검증 |
| F-122 | P2 | Dynamics | ✅ 구현+자동테스트 | /app/integrations | /integrations/dynamics/* | modules/crm.ts | services/api/test/track-b.integration.test.ts | Contacts/Leads, If-Match, 중복 감지→충돌. 실계정 미검증 |
| F-123 | P2 | Webhook/Zapier/Make | ✅ 구현+자동테스트 | /app/integrations | /webhooks | modules/webhooks.ts | services/api/test/track-b.integration.test.ts, packages/domain/test/comms.test.ts | HMAC 서명, 백오프, SSRF 가드(DNS 재검사), 20회 실패 시 비활성 |
| F-124 | P0 | Excel/CSV | ✅ 구현+자동테스트 | /app/settings | /exports | integration.renderExport | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/scenarios S-087,S-088 | XLSX + CSV(수식 주입 방지) |
| F-125 | P0 | Word DOCX | ✅ 구현+자동테스트 | /app/settings (Word), /app/settings (내보내기 기간·미팅/관계 보고서) | /exports format=docx | lib/docx | services/api/test/assist.integration.test.ts, tests/scenarios S-089, services/api/test/settings-gaps.integration.test.ts, tests/e2e/settings-gaps.spec.ts |  |
| F-126 | P1 | TXT/PDF/vCard | ✅ 구현+자동테스트 | /app/people | /exports (pdf) | services/api/src/lib/pdf.ts (pdfkit + Pretendard) | services/api/test/track-b.integration.test.ts | standalone 빌드에서 폰트 포함 확인 |
| F-127 | P1 | 필드 매핑 | ✅ 구현+자동테스트 | /app/settings | /exports (fields) |  | services/api/test/track-b.integration.test.ts, services/api/test/hubspot-deals.integration.test.ts |  |
| F-128 | P0 | Sync Journal | ✅ 구현+자동테스트 | /app/settings | /integrations | sync_jobs + external_mappings | services/api/test/google.integration.test.ts, services/api/test/track-b.integration.test.ts, services/api/test/audit.integration.test.ts | 작업 이력·재시도·dead 상태 |
## ENT · Enterprise & Admin

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-129 | P1 | 조직/워크스페이스 | ✅ 구현+자동테스트 | /app/org, /app/org/settings (조직 삭제) | /orgs | modules/org.ts | services/api/test/track-a.integration.test.ts, packages/domain/test/org.test.ts, services/api/test/settings-gaps.integration.test.ts, tests/e2e/settings-gaps.spec.ts | 조직 생성, active_org 전환, 비회원 404 |
| F-130 | P1 | 역할 권한 | ✅ 구현+자동테스트 | /app/org/members | /orgs/{id}/members | packages/domain/src/org.ts (역할×권한 매트릭스) | services/api/test/track-a.integration.test.ts, packages/domain/test/org.test.ts | 5개 역할 × 14개 행동 통합 매트릭스 |
| F-131 | P1 | 팀 주소록 | ✅ 구현+자동테스트 | /app/team | /orgs/{id}/contacts | modules/org.ts | services/api/test/track-a.integration.test.ts | 조직 간 격리, viewer PII 마스킹 |
| F-132 | P1 | 회사 소유 리드 | ✅ 구현+자동테스트 | /app/team | /orgs/{id}/leads | modules/org.ts | services/api/test/track-a.integration.test.ts | 회사 리드 이관(퇴사·SCIM 해지·계정삭제), 개인 연락처는 본인 소유 유지 |
| F-133 | P2 | 관계 그래프 | ✅ 구현+자동테스트 | /app/org/graph | /orgs/{id}/graph | modules/network.ts (서버 결정론적 레이아웃) | services/api/test/track-a.integration.test.ts, packages/domain/test/org.test.ts | 개인 인맥은 회사 단위 집계로만 노출 |
| F-134 | P2 | Who Knows Whom | ✅ 구현+자동테스트 | /app/org, /app/org (내 멤버십 설정) | /orgs/{id}/who-knows | modules/network.ts | services/api/test/track-a.integration.test.ts, services/api/test/settings-gaps.integration.test.ts, tests/e2e/settings-gaps.spec.ts | 관계 강도 순, 개인 연락처 이름 비공개, 옵트아웃·감사로그 |
| F-135 | P1 | 활동 대시보드 | ✅ 구현+자동테스트 | /app/org | /orgs/{id}/activity | modules/enterprise.ts | services/api/test/track-a.integration.test.ts | 조직 대시보드 |
| F-136 | P1 | Data Retention | ✅ 구현+자동테스트 | /app/org/settings | /orgs/{id}/retention | modules/enterprise.ts + worker | services/api/test/track-a.integration.test.ts, services/api/test/whitepaper-gaps.integration.test.ts | 보존 정책·미리보기·워커 삭제(retention.purged 감사) |
| F-137 | P0 | 감사로그 | ✅ 구현+자동테스트 | /app/settings (내 활동 기록) | /me/audit | platform.audit | services/api/test/api.integration.test.ts, services/api/test/settings-gaps.integration.test.ts, tests/e2e/settings-gaps.spec.ts |  |
| F-138 | P1 | 브랜딩 | ✅ 구현+자동테스트 | /app/org/settings, /p/[slug], /app/org (명함 브랜딩 토글) | /orgs/{id}/branding | modules/enterprise.ts | services/api/test/track-a.integration.test.ts, services/api/test/settings-gaps.integration.test.ts, tests/e2e/settings-gaps.spec.ts | 브랜딩은 /p/[slug] 에만 표시; 로고는 data: 이미지만(CSP) |
| F-139 | P2 | 정책 강제 | ✅ 구현+자동테스트 | /app/org/settings, /app/team (CRM 동기화 정책 안내) | /orgs/{id}/policies | modules/policy.ts | services/api/test/track-a.integration.test.ts, services/api/test/whitepaper-gaps.integration.test.ts, packages/domain/test/whitepaper-gaps.test.ts, services/api/test/backend-gaps.integration.test.ts | 녹음 일방동의 차단, 역할별 내보내기 차단, 과공개 필드 차단 |
| F-140 | P2 | API 키 | ✅ 구현+자동테스트 | /app/org/settings | /ext/contacts, /ext/leads | modules/enterprise.ts (API key sha256) | services/api/test/track-a.integration.test.ts | 스코프·회수·rate limit |
## EVT · Events & Networking

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-141 | P1 | 행사 공간 | ✅ 구현+자동테스트 | /app/events | /events | event | services/api/test/api.integration.test.ts |  |
| F-142 | P1 | 참가자 등록 | ✅ 구현+자동테스트 | /app/events, /app/events/[id] (참가자 등록 CSV) | /events/join | event | services/api/test/api.integration.test.ts, tests/e2e/exchange-events-gaps.spec.ts, services/api/test/exchange-events-gaps.integration.test.ts, packages/domain/test/exchangeEventsGaps.test.ts | opt-in |
| F-143 | P1 | 현장 교환 | ✅ 구현+자동테스트 | /app/exchange (장소), /app/events/[id] (이 행사로 교환 시작), /app/exchange?event= |  |  | services/api/test/audit.integration.test.ts, tests/e2e/exchange-events-gaps.spec.ts, services/api/test/exchange-events-gaps.integration.test.ts |  |
| F-144 | P1 | 배지 OCR | ✅ 구현+자동테스트 | /app/events/[id] | /events/{id}/leads | modules/capture.ts commitCapture | services/api/test/track-c.integration.test.ts, tests/scenarios/k-capture-files.spec.ts | 배지 OCR → 행사 리드, Idempotency-Key |
| F-145 | P2 | AI Match List | ✅ 구현+자동테스트 | /app/events/[id], /app/events/[id] (추천 필터·모든 이유) | /events/{id}/matches | event | services/api/test/api.integration.test.ts, tests/e2e/exchange-events-gaps.spec.ts | P2 선구현 |
| F-146 | P2 | 미팅 요청 | ✅ 구현+자동테스트 | /app/events/[id], /app/events/[id] (현장 미팅 요청) | /events/{id}/meeting-requests | modules/calendar.ts | services/api/test/track-b.integration.test.ts, tests/e2e/exchange-events-gaps.spec.ts | opt-in 참가자만, 상대 이메일 비노출 |
| F-147 | P2 | 부스 Lead Flow | ✅ 구현+자동테스트 | /app/events/[id]/booth, /app/events/[id]/booth (스태프 추가·제거) | /events/{id}/leads | modules/booth.ts | services/api/test/track-d.integration.test.ts, tests/e2e/exchange-events-gaps.spec.ts, services/api/test/exchange-events-gaps.integration.test.ts | 부스 리드 수집·등급 |
| F-148 | P1 | 그룹 교환 | ✅ 구현+자동테스트 | /app/exchange?group=1 |  | handoff | services/api/test/api.integration.test.ts |  |
| F-149 | P2 | Event ROI | ✅ 구현+자동테스트 | /app/events/[id]/booth | /events/{id}/roi | modules/booth.ts | services/api/test/track-d.integration.test.ts | 행사 ROI |
| F-150 | P1 | 오프라인 모드 | ✅ 구현+자동테스트 | /app/events/[id] | /events/{id}/leads | lib/offline.ts | tests/e2e/offline-sync.spec.ts | 행사장 오프라인 리드 큐 |
| F-151 | P2 | 주최자 API | ✅ 구현+자동테스트 |  | /organizer/events/{id}/{attendees,leads} | modules/booth.ts | services/api/test/track-d.integration.test.ts | 주최자 API 토큰, 모든 내보내기 감사로그 |
## INTRO · Introductions & Connection Rooms

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-152 | P1 | AI 소개 후보 | ✅ 구현+자동테스트 | /app/intros | /introductions/suggested | modules/network.ts | services/api/test/track-a.integration.test.ts | source=ai_suggested 기록 |
| F-153 | P1 | 소개 동의 | ✅ 구현+자동테스트 | /app/intros | /introductions/{id}/consent | connection | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts, tests/scenarios S-081,S-082 |  |
| F-154 | P1 | Connection Room | ✅ 구현+자동테스트 | /app/rooms/[id] | /rooms/{id} | connection | services/api/test/api.integration.test.ts, tests/scenarios S-083 |  |
| F-155 | P1 | 3자 소개 메시지 | ✅ 구현+자동테스트 | /app/intros | /introductions/{id}/draft | modules/intro.ts | services/api/test/track-a.integration.test.ts | 이중 옵트인 초안만(발송 없음, mailto) |
| F-156 | P1 | 공유 파일 | ✅ 구현+자동테스트 | /app/rooms/[id] | /rooms/{id}/files | modules/files.ts | services/api/test/track-c.integration.test.ts | javascript: 링크 거부 |
| F-157 | P1 | 미팅 예약 | ✅ 구현+자동테스트 | /app/rooms/[id] | /rooms/{id}/meetings | modules/calendar.ts | services/api/test/track-b.integration.test.ts | 슬롯 제안·승인·나머지 대체 |
| F-158 | P2 | Room 요약 | ✅ 구현+자동테스트 | /app/rooms/[id] | /rooms/{id}/summary | modules/intro.ts | services/api/test/track-a.integration.test.ts | structured() + 규칙 폴백 |
| F-159 | P2 | 소개 성과 | ✅ 구현+자동테스트 | /app/rooms/[id] | /introductions/{id}/outcome, /introductions/stats | modules/intro.ts | services/api/test/track-a.integration.test.ts | 성과 기록·전환 통계 |
## SEC · Privacy, Security & Compliance

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-160 | P0 | 필드 단위 ACL | ✅ 구현+자동테스트 | CardEditor |  | domain/acl | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts |  |
| F-161 | P0 | Consent Ledger | ✅ 구현+자동테스트 | /app/settings | /me/consents | consent_records | services/api/test/api.integration.test.ts, services/api/test/backend-gaps.integration.test.ts |  |
| F-162 | P0 | 데이터 최소화 | ✅ 구현+자동테스트 |  |  | on-device OCR, 선택 필드만 전송 | services/api/test/audit.integration.test.ts |  |
| F-163 | P0 | 암호화 | 🟡 부분 |  |  | AES-256-GCM 자격증명, TLS(HSTS) | services/api/test/whitepaper-gaps.integration.test.ts | DB at-rest 암호화는 인프라 설정 |
| F-164 | P0 | 테넌트 격리 | ✅ 구현+자동테스트 |  |  | owner-scoped queries, organization_id scoping | services/api/test/api.integration.test.ts, services/api/test/track-a.integration.test.ts, tests/scenarios S-018,S-019,S-034,S-069,S-086,S-091 | 개인 범위 격리 + 조직 간 격리(팀 주소록·회사 리드·API 키·SCIM 모두 다른 조직 데이터 불가, 비멤버에게는 존재 자체를 숨겨 404) |
| F-165 | P0 | 비밀관리 | ✅ 구현+자동테스트 |  |  | .env.example, render.yaml | services/api/test/audit.integration.test.ts, services/api/test/whitepaper-gaps.integration.test.ts |  |
| F-166 | P0 | 감사 추적 | ✅ 구현+자동테스트 | /app/settings (내 활동 기록) |  | audit_logs | services/api/test/api.integration.test.ts, services/api/test/settings-gaps.integration.test.ts, tests/e2e/settings-gaps.spec.ts, services/api/test/whitepaper-gaps.integration.test.ts, services/api/test/backend-gaps.integration.test.ts |  |
| F-167 | P0 | 삭제/탈퇴 | ✅ 구현+자동테스트 | /app/settings | /me/privacy/delete | security | services/api/test/api.integration.test.ts, tests/scenarios S-093, services/api/test/backend-gaps.integration.test.ts | 7일 유예 후 하드 삭제 |
| F-168 | P1 | 데이터 이동성 | ✅ 구현+자동테스트 | /app/settings, /app/settings (개인정보 내보내기 대기열·다운로드) | /me/privacy/export | security | services/api/test/api.integration.test.ts, tests/scenarios S-092, services/api/test/backend-gaps.integration.test.ts, tests/e2e/i18n-app-voice.spec.ts |  |
| F-169 | P0 | 녹음 준수 | ✅ 구현+자동테스트 |  | /meetings/{id}/recordings | meeting | services/api/test/api.integration.test.ts |  |
| F-170 | P0 | Rate Limit | ✅ 구현+자동테스트 |  | all | platform.rateLimit | services/api/test/audit.integration.test.ts |  |
| F-171 | P0 | Anti-enumeration | ✅ 구현+자동테스트 |  | /exchange | high-entropy tokens + short-code rate limit (packages/domain/src/codeGuard.ts) | packages/domain/test/domain.test.ts, tests/scenarios S-030, packages/domain/test/codeGuard.test.ts, services/api/test/code-guard.integration.test.ts | 남는 위험: IP 를 많이 가진 분산 공격자는 IP 마다 첫 시도가 통과하므로 여전히 쓸어볼 수 있다. 근본 해결은 코드 엔트로피 상향(F-045 제품 결정) 또는 코드-기기 바인딩 |
| F-172 | P1 | Malware Scan | ✅ 구현+자동테스트 |  | /files | lib/filescan.ts | services/api/test/track-c.integration.test.ts | 매직바이트·크기, EXIF 제거 재인코딩, 활성 PDF·EICAR 격리, 선택적 ClamAV |
| F-173 | P0 | DLP/PII 로그 마스킹 | ✅ 구현+자동테스트 |  |  | domain/redact | packages/domain/test/domain.test.ts, services/api/test/api.integration.test.ts |  |
## OPS · Platform, Offline, Quality & Ops

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-174 | P0 | PWA | ✅ 구현+자동테스트 | manifest, sw.js |  |  | tests/e2e/audit-extras.spec.ts |  |
| F-175 | P0 | Responsive UX | ✅ 구현+자동테스트 | all |  |  | tests/e2e/guest-exchange.spec.ts, tests/scenarios S-095~S-098 | iPhone SE / Android 360 / iPad / 데스크톱 |
| F-176 | P1 | 접근성 | ✅ 구현+자동테스트 | 전체 |  | globals.css 토큰, Fx.tsx reduced-motion | tests/e2e/a11y.spec.ts, tests/scenarios/j-ui-devices.spec.ts | axe WCAG A/AA 자동 감사(공개 페이지 라이트/다크), 앱 페이지 수동 axe 감사 통과 |
| F-177 | P0 | 다국어 | ✅ 구현+자동테스트 | /x/[token] 언어 선택, 앱 셸·홈·인맥·교환·설정·로그인 ko/en (설정 → 언어) |  | packages/domain/src/i18n.ts (ko/en/ja 리소스, pickLocale) | packages/domain/test/i18n.test.ts, tests/e2e/i18n.spec.ts, tests/e2e/i18n-app-voice.spec.ts | 게스트 수신·링크 상태 화면 ko/en/ja(Accept-Language·?lang·쿠키). 앱 내부 화면은 한국어 — 리소스 분리 구조로 확장 |
| F-178 | P1 | 오프라인 캡처 | ✅ 구현+자동테스트 | /app/sync |  | packages/domain/src/offlineQueue.ts, lib/offline.ts | packages/domain/test/track-c.test.ts, tests/e2e/offline-sync.spec.ts | 암호화 IndexedDB 큐, 원래 Idempotency-Key로 재전송 |
| F-179 | P0 | 재동기화 | ✅ 구현+자동테스트 | /app/sync, 오프라인 배너 → /app/sync |  | lib/offline.ts, sw.js | tests/e2e/offline-sync.spec.ts | Background Sync, 409 충돌은 필드별 선택 |
| F-180 | P0 | 관찰성 | ✅ 구현+자동테스트 |  |  | services/api/src/lib/tracing.ts (OTLP) | services/api/test/track-d.integration.test.ts | OTEL_EXPORTER_OTLP_ENDPOINT 설정 시만 동작; 트랜잭션 내 직접 client.query 는 스팬 없음 |
| F-181 | P1 | Feature Flag | ✅ 구현+자동테스트 | /app/admin | /admin/flags | modules/growth.ts, lib/flags.ts | services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts | 사용자/조직 타게팅, % 롤아웃, 킬스위치 |
| F-182 | P0 | 모바일 딥링크 | ✅ 구현+자동테스트 |  |  | apple-app-site-association, assetlinks.json, apps/mobile/app.config.ts | tests/e2e/audit-extras.spec.ts | AASA/assetlinks 제공 e2e. 실제 Team ID·앱 서명 지문은 계정 필요 |
| F-183 | P0 | CI/CD | ✅ 구현+자동테스트 |  |  | .github/workflows/ci.yml |  | typecheck·unit·integration·migrate·traceability·build·e2e·100 시나리오·docker |
| F-184 | P0 | 백업/복구 | ✅ 구현+자동테스트 |  |  | scripts/backup.sh, scripts/restore-drill.sh, db/seeds/seed.ts | .github/workflows/ci.yml job dr | 매 PR 에서 pg_dump → 별도 DB pg_restore → 12개 핵심 테이블 행 수 비교(시드 데이터 기준). 운영은 관리형 PITR 병행 |
| F-185 | P0 | 성능예산 | ✅ 구현+자동테스트 |  |  | scripts/loadtest.mjs |  | 5,000 연락처·동시 20, 8개 시나리오 p95 SLO 통과(통계 낡은 최악 조건 포함) |
| F-186 | P1 | 재해복구 | ✅ 구현+자동테스트 |  |  | scripts/dr/*, RUNBOOK.md, db/seeds/seed.ts | .github/workflows/ci.yml job dr | 매 PR 에서 2개 위치 복제 → 보조 위치만으로 복원 검증(체크섬·매니페스트·schema_migrations·행 수·스모크·RPO/RTO). 디렉터리 경로로 리허설하며 S3/GCS 전송 경로는 미검증 |
| F-187 | P1 | 비용계측 | ✅ 구현+자동테스트 | /app/admin |  | lib/metering.ts recordCost | services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts | 추정 단가(COST_RATES_JSON 재정의) |
## BIZ · Analytics, Billing & Growth

| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |
|---|---|---|---|---|---|---|---|---|
| F-188 | P1 | 제품 분석 | ✅ 구현+자동테스트 | /app/admin | /analytics/events | lib/metering.ts track, growth.funnelReport | services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts, services/api/test/whitepaper-gaps.integration.test.ts | 가입→교환→게스트→Claim 퍼널 |
| F-189 | P1 | 바이럴 계수 | ✅ 구현+자동테스트 | /app/admin, /app/insights |  | growth.viralReport | services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts, services/api/test/whitepaper-gaps.integration.test.ts | K-factor, 2차 공유율, Claim율 |
| F-190 | P1 | 개인 플랜 | ✅ 구현+자동테스트 | /app/billing | /billing/* | packages/domain/src/plans.ts, modules/billing.ts | services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts | 플랜 해석 |
| F-191 | P1 | 기업 플랜 | ✅ 구현+자동테스트 | /app/billing, /join/[token], /app/org, /app/org/members (좌석 한도 안내) | /billing/* | modules/billing.ts | services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts, services/api/test/backend-gaps.integration.test.ts | 좌석 검사 함수(조직 멤버 API 연결 필요) |
| F-192 | P1 | 사용량 계량 | ✅ 구현+자동테스트 | /app/billing |  | billing.consume() | services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts | 교환·스캔·AI 사용량 계량, AI 한도 초과 시 규칙 폴백. 게스트는 비계량 |
| F-193 | P2 | 결제 | ✅ 구현+자동테스트 | /app/billing | /billing/checkout, /billing/portal | modules/billing.ts (Stripe) | services/api/test/track-d.integration.test.ts | 가짜 Stripe 서버로 검증 |
| F-194 | P2 | 구독 관리 | ✅ 구현+자동테스트 |  | /billing/webhooks/stripe | modules/billing.ts | services/api/test/track-d.integration.test.ts | 서명 검증, 1회 처리, 순서 역전 무시, 더닝 유예 |
| F-195 | P2 | 관리자 매출지표 | ✅ 구현+자동테스트 | /app/admin | /admin/revenue | billing.revenueReport | services/api/test/track-d.integration.test.ts | 관리자 전용 |
| F-196 | P1 | 실험 프레임워크 | ✅ 구현+자동테스트 | /app/admin, /x/[token] | /admin/experiments | modules/growth.ts | services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts | guest_reply_cta 카피 실험(ko/en/ja) |
| F-197 | P3 | Referral Reward | ✅ 구현+자동테스트 | /app/settings | /referrals | modules/referral.ts | services/api/test/track-a.integration.test.ts, packages/domain/test/org.test.ts | P3. 교환 완료 후 보상, 월 한도, REFERRAL_REWARDS_ENABLED=1 일 때만 |

## 추가 기능 (원장 외 · X-ID)

| ID | 기능 | 상태 | UI | API | 테스트 |
|---|---|---|---|---|---|
| X-001 | 메일 서명 생성기 | ✅ 구현+자동테스트 | /app/me/share#signature | /me/share/signature | packages/domain/test/extras.test.ts, services/api/test/extras.integration.test.ts, tests/e2e/audit-extras.spec.ts |
| X-002 | 화상회의 가상 배경 | ✅ 구현+자동테스트 | /app/me/share#background | /me/share/background | packages/domain/test/extras.test.ts, tests/e2e/audit-extras.spec.ts |
| X-003 | 명함 조회 분석 | ✅ 구현+자동테스트 | /app/insights | /card-views, /insights/card-views, /me/analytics-preference | packages/domain/test/extras.test.ts, services/api/test/extras.integration.test.ts, tests/e2e/audit-extras.spec.ts |
| X-004 | Apple·Google 지갑 패스 | ✅ 구현+자동테스트 | /app/me/share#wallet | /me/wallet/apple, /me/wallet/google | services/api/test/pkcs7.test.ts, services/api/test/extras.integration.test.ts |
| X-005 | 미팅 전 30초 브리핑 | ✅ 구현+자동테스트 | /app/brief | /prep-briefs, /prep-briefs/{id}, /me/assistant-preferences | services/api/test/extras.integration.test.ts |
| X-006 | 관계 재연결 다이제스트(초안만) | ✅ 구현+자동테스트 | /app/reconnect | /reconnect/digest, /reconnect/digest/{contactId}/draft | services/api/test/extras.integration.test.ts, tests/e2e/audit-extras.spec.ts |
| X-007 | 행사용 명함 포스터·테이블 텐트 PDF | ✅ 구현+자동테스트 | /app/me/share, /app/events/[id] | /exchange/manage/{id}/poster | services/api/test/extras.integration.test.ts |
| X-008 | 명함 디자인 스튜디오 — 오리지널 템플릿 50종 · 아이콘 291 · 이모지 912 | ✅ 구현+자동테스트 | /app/me/templates, /app/me/edit | /profiles/{id}/template | packages/domain/test/cardDesign.test.ts, services/api/test/card-templates.integration.test.ts, tests/e2e/card-templates.spec.ts |
