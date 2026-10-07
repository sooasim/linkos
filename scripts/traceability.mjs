#!/usr/bin/env node
// Generates docs/TRACEABILITY.md from the feature registry (source of truth) + the implementation map below.
// Status: T = implemented + automated test · I = implemented (no automated test yet) · P = partial · N = not started
// `--check` fails when a registry Feature ID is missing from the map (CI gate: no silent omission).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reg = YAML.parse(readFileSync(resolve(root, "dd/LINKOS_Product_Blueprint_v1/03_FEATURE_REGISTRY.yaml"), "utf8"));

const UT = "packages/domain/test/domain.test.ts";
const IT = "services/api/test/api.integration.test.ts";
const E2E = "tests/e2e/guest-exchange.spec.ts";
const GT = "services/api/test/google.integration.test.ts";
const AT = "services/api/test/assist.integration.test.ts";
const S = (ids) => `tests/scenarios ${ids}`;

// [status, UI route, API, module, tests, note]
const M = {
  "F-001": ["T", "/login", "/auth/otp, /auth/verify, /auth/google, /auth/apple, /auth/passkey/*", "identity, apple, passkey", `${IT}, ${E2E}, ${S("S-001~S-006")}, services/api/test/apple.integration.test.ts`, "Email OTP + Google OIDC + Sign in with Apple + 패스키"],
  "F-002": ["T", "/x/[token], /c/[code]", "/exchange/sessions/{token}", "handoff", `${IT}, ${E2E}`, ""],
  "F-003": ["T", "/claim", "/guest/claim", "handoff.claimGuest", `${IT}, ${E2E}`, ""],
  "F-004": ["T", "/join/[token], /app/org/members", "/orgs/{id}/invites", "modules/org.ts", "services/api/test/track-a.integration.test.ts, packages/domain/test/org.test.ts", "이메일 바인딩 초대·만료·회수, 인증 도메인 자동가입/승인"],
  "F-005": ["I", "/app/me/edit?new=1", "/profiles", "card", "", ""],
  "F-006": ["T", "/login, /app/settings", "/auth/passkey/*", "modules/passkey.ts (@simplewebauthn)", "services/api/test/track-a.integration.test.ts", "ES256 소프트 인증기로 등록·로그인·재사용·origin·카운터 검증. 실브라우저 플로우는 수동 검증 필요"],
  "F-007": ["T", "/app/settings", "/me/devices", "identity.resolveSession", `${IT}, ${S("S-004,S-006,S-010")}`, "refresh rotation + reuse detection + device revoke"],
  "F-008": ["T", "/login (회사 SSO), /app/org/settings", "/auth/sso/*, /sso/saml/{orgId}/{metadata,acs}, /scim/v2/*", "modules/enterprise.ts, saml.ts (@node-saml/node-saml), ssoLogin.ts, ssoPolicy.ts", "services/api/test/saml.integration.test.ts, services/api/test/track-a.integration.test.ts, packages/domain/test/sso.test.ts", "OIDC + SAML 2.0(SP-initiated, 서명·XSW·재생 방어, 인증서 교체) + SCIM + sso_required 강제(Owner OTP break-glass). IdP-initiated·SLO·암호화 assertion 미지원"],
  "F-009": ["T", "/login (consent step)", "/auth/verify, /me/consents", "identity", `${UT}, ${IT}, ${E2E}`, ""],
  "F-010": ["T", "/app/scan", "", "packages/domain/src/imaging.ts, lib/imagePipeline.ts", "packages/domain/test/imaging.test.ts", "테두리 검출·원근 보정·대비 보정(합성 이미지 단위테스트). 실 OCR 브라우저 테스트는 CDN 데이터 필요로 미실시"],
  "F-011": ["I", "/app/scan", "/capture/cards (backLines)", "capture", "", ""],
  "F-012": ["I", "/app/scan/import", "/capture/cards", "BatchImport.tsx (암호화 온디바이스 큐)", "", "최대 200장, 재개 가능. 브라우저 테스트 없음; 페이지가 열려 있을 때만 진행"],
  "F-013": ["T", "/app/scan", "", "packages/domain/src/imaging.ts", "packages/domain/test/imaging.test.ts", "한 장에 여러 명함 분할"],
  "F-014": ["T", "/app/events/[id]", "/events/{id}/leads", "packages/domain/src/badge.ts", "services/api/test/track-c.integration.test.ts, packages/domain/test/track-c.test.ts, tests/scenarios/k-capture-files.spec.ts", "배지 파서 → 행사 리드(단일 트랜잭션)"],
  "F-015": ["I", "/app/scan (언어 선택)", "/capture/parse", "tesseract.js kor/jpn/chi_sim + parser", `${UT}, ${S("S-051~S-054")}`, "구조화 파서는 4개 언어 자동테스트; 기기 OCR 엔진 자체는 실기기 수동 검증"],
  "F-016": ["T", "/app/scan", "/capture/cards, /capture/parse", "domain/ocrParser", `${UT}, ${IT}`, "규칙 기반 구조화(원문 외 값 생성 금지)"],
  "F-017": ["T", "ReviewFields", "/capture/cards", "domain/ocrParser", UT, "필드별 confidence + bbox"],
  "F-018": ["T", "ReviewFields", "", "domain.needsReview", UT, ""],
  "F-019": ["T", "/app/scan", "/files/{id}", "lib/storage.ts, modules/files.ts (파일별 AES-256-GCM)", "services/api/test/track-c.integration.test.ts", "로컬/S3 호환, 서명 URL 5~10분, 보존기간 후 삭제. 게스트 플로우는 업로드 안 함"],
  "F-020": ["T", "/app/scan, /app/people/[id]", "/contacts/duplicates", "domain/duplicate", `${UT}, ${IT}`, ""],
  "F-021": ["T", "/app/people/[id]", "/contacts/{id}/merge, /merge/undo", "relationship.mergeContact", `${UT}, ${IT}`, "필드별 선택 + undo"],
  "F-022": ["T", "LivingCard 3초", "/profiles", "card", `${IT}, ${E2E}`, ""],
  "F-023": ["I", "LivingCard 30초", "/profiles", "card", "", ""],
  "F-024": ["I", "LivingCard 딥", "/profiles", "card", "", "미디어/파일 업로드 미구현"],
  "F-025": ["T", "CardEditor", "/profiles", "card", IT, ""],
  "F-026": ["T", "CardEditor", "/profiles", "card", IT, ""],
  "F-027": ["I", "CardEditor", "/profiles", "card (deep.interests)", "", ""],
  "F-028": ["I", "CardEditor", "/profiles", "card (deep.assets)", "", ""],
  "F-029": ["I", "CardEditor", "/profiles", "card (deep.network)", "", ""],
  "F-030": ["I", "CardEditor", "/profiles", "card (deep.projects)", "", ""],
  "F-031": ["T", "/x/[token]", "", "living.adaptCardForSession", "services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts", "세션 audience 에 따라 변형 자동 선택"],
  "F-032": ["T", "/app/me/edit", "/cards/adaptive", "living.adaptiveSuggest", "services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts", "규칙 경로 테스트; Claude 경로는 미검증"],
  "F-033": ["T", "/app/inbox", "/living-updates", "living.fanOutLivingUpdate", "services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts", "연결 상대에게 갱신 알림, 수락 시 provenance=sync"],
  "F-034": ["T", "CardEditor", "/p/{slug}, /exchange/sessions/{token}", "domain/acl", `${UT}, ${IT}, ${S("S-014~S-016,S-037")}`, ""],
  "F-035": ["T", "/p/[slug], /app/me", "/profiles/{id}/access-requests, /access-requests", "card", S("S-016"), ""],
  "F-036": ["I", "LivingCard", "", "LivingCard (tel/mailto/vCard)", "", "예약/견적/NDA CTA 미구현"],
  "F-037": ["T", "/app/exchange", "/exchange/sessions", "handoff", E2E, ""],
  "F-038": ["T", "ExchangeConsole.detectCapabilities", "/exchange/sessions", "domain/handoff", UT, ""],
  "F-039": ["I", "apps/mobile ProximityStep", "/channels/proximity/*", "modules/channels.ts, packages/domain/src/pairing.ts", "services/api/test/track-e.integration.test.ts, packages/domain/test/native-channels.test.ts", "서버·규칙 테스트. BLE 실기기 동작·RSSI 보정 미검증"],
  "F-040": ["I", "apps/mobile", "/channels/proximity/*", "modules/channels.ts", "services/api/test/track-e.integration.test.ts, packages/domain/test/native-channels.test.ts", "4자리 상호 확인 후 원자적 교환. 실기기 미검증"],
  "F-041": ["I", "/app/exchange", "/exchange/manage/{id}/attempts", "handoff", "", "navigator.share — 헤드리스 테스트 불가"],
  "F-042": ["P", "apps/ios-app-clip", "", "SwiftUI App Clip", "", "코드 작성; Swift 툴체인이 없어 컴파일 미검증. TEAMID 자리표시자"],
  "F-043": ["T", "/x/[token] (PWA)", "", "web", E2E, ""],
  "F-044": ["T", "/app/exchange", "/nfc-tags, /n/{tagId}", "modules/channels.ts", "services/api/test/track-e.integration.test.ts", "128bit 태그 해시 저장, 1회성 세션 생성, rate limit"],
  "F-045": ["T", "/c, /c/[code]", "/exchange/sessions/{code}", "handoff", `${UT}, ${IT}, ${E2E}`, ""],
  "F-046": ["T", "/c, /app/exchange", "/channels/rendezvous/*", "components/ReceiveMode.tsx", "services/api/test/track-e.integration.test.ts", "4자리 90초 코드, 8회 시도 제한"],
  "F-047": ["T", "/app/exchange", "", "packages/domain/src/acoustic.ts", "packages/domain/test/native-channels.test.ts", "P3 실험(기본 꺼짐). 실제 스피커/마이크 미검증"],
  "F-048": ["T", "/app/exchange", "/exchange/manage/{id}/attempts", "domain/handoff", `${UT}, ${IT}, ${E2E}`, ""],
  "F-049": ["T", "GuestFlow consent", "/exchange/sessions/{token}/reply", "handoff", `${IT}, ${E2E}`, ""],
  "F-050": ["T", "", "/exchange/sessions", "domain/token", `${UT}, ${IT}, ${S("S-028,S-030")}`, "192-bit, SHA-256 해시 저장, TTL, 1회성, revoke, rate limit"],
  "F-051": ["T", "/app/exchange?group=1", "/exchange/sessions (group)", "handoff", `${IT}, ${S("S-035")}`, "정원 초과 409"],
  "F-052": ["T", "/app/exchange (앱)", "/offline/*", "packages/domain/src/hmac.ts, offlineQueue.ts", "services/api/test/track-e.integration.test.ts, tests/e2e/offline-sync.spec.ts", "기기 HMAC 서명 패스+영수증 검증, 멱등 동기화. 네이티브 앱 실기기 미검증"],
  "F-053": ["T", "/x/[token]", "/exchange/sessions/{token}", "handoff", `${IT}, ${E2E}`, ""],
  "F-054": ["T", "GuestFlow", "", "", E2E, ""],
  "F-055": ["I", "GuestFlow + CardScanner", "/capture/parse", "domain/ocrParser", S("S-051~S-062"), "파서 자동테스트; 카메라 촬영은 실기기 수동 검증"],
  "F-056": ["T", "GuestFlow", "/exchange/sessions/{token}/reply", "handoff", E2E, ""],
  "F-057": ["I", "/x/[token]", "", "GuestFlow Contact Picker", "", "지원 브라우저에서만 버튼 표시. 브라우저 미검증"],
  "F-058": ["T", "ReviewFields(selectable)", "/exchange/sessions/{token}/reply", "handoff", `${IT}, ${E2E}`, "체크한 필드만 전송"],
  "F-059": ["T", "/claim", "/guest/claim", "handoff", `${IT}, ${E2E}`, ""],
  "F-060": ["T", "/login, /claim", "/auth/google/onetap, /auth/apple, /auth/apple/callback", "modules/identity.ts, modules/apple.ts", "services/api/test/track-e.integration.test.ts, services/api/test/apple.integration.test.ts", "Google One Tap + Sign in with Apple(form_post, nonce, ES256 client secret, 신규 가입 동의 단계). 가짜 서버로 검증 — 실제 Apple/Google 계정은 스테이징 수동 확인 필요"],
  "F-061": ["T", "/claim", "/guest/claim", "handoff.claimGuest", IT, "초안으로 Living Card 자동 생성"],
  "F-062": ["I", "GuestFlow, CardEditor", "", "", "", ""],
  "F-063": ["I", "ExchangeConsole '다음 사람과 교환'", "", "", "", ""],
  "F-064": ["T", "/r/[code], /app/settings", "/referrals", "modules/referral.ts", "services/api/test/track-a.integration.test.ts", "Claim·조직초대·추천링크 귀속(신규 계정만). Google 로그인 콜백 미연결"],
  "F-065": ["T", "/app/people", "/contacts", "relationship", IT, ""],
  "F-066": ["T", "", "business_cards", "capture", IT, ""],
  "F-067": ["T", "타임라인", "/contacts/{id}/encounters", "relationship", IT, ""],
  "F-068": ["T", "", "", "relationship", IT, ""],
  "F-069": ["I", "/app/people (회사별 그룹)", "", "relationship.upsertCompany", "", ""],
  "F-070": ["I", "/app/people, /app/scan", "/contacts (tags)", "relationship", "", ""],
  "F-071": ["T", "/app/ai", "/ai/search", "ai.relationshipSearch", IT, "어휘+기간 해석. 임베딩 검색 미구현"],
  "F-072": ["T", "/app/people/[id]", "/contacts/{id}/merge", "relationship", IT, ""],
  "F-073": ["T", "/app/people/[id] 타임라인", "/contacts/{id}", "relationship (contact_field_history)", AT, "필드 단위 이전값→새값"],
  "F-074": ["T", "/app/people/[id]", "/contacts/{id}/strength", "packages/domain/src/strength.ts", "services/api/test/track-a.integration.test.ts, packages/domain/test/org.test.ts", "구성 요인 저장, 워커 재계산"],
  "F-075": ["T", "/app/people/[id]", "/contacts/{id}/notes", "relationship", IT, "항상 private"],
  "F-076": ["T", "/app/people/[id]", "/contacts/{id}/team-notes", "modules/org.ts", "services/api/test/track-a.integration.test.ts", "팀 메모 — 개인 메모는 팀 뷰·이관에 절대 포함되지 않음을 테스트"],
  "F-077": ["T", "/app/team", "/orgs/{id}/leads/{id}/assign", "modules/org.ts", "services/api/test/track-a.integration.test.ts", "담당자 지정 시 관계·만남 이력 이관"],
  "F-078": ["I", "/app/people", "/followups", "meeting.createFollowup", "", "relationships.next_followup_at"],
  "F-079": ["T", "/app/meetings/[id]", "/meetings", "meeting", IT, ""],
  "F-080": ["I", "/app/people/[id] 마이크 버튼", "/contacts/{id}/notes (kind=voice)", "Web Speech API", "", "기기 음성인식 지원 브라우저에서 받아쓰기; 오디오 서버 미전송"],
  "F-081": ["T", "/app/meetings/[id]", "/meetings/{id}/recording/*", "modules/recording.ts", "services/api/test/track-c.integration.test.ts, tests/e2e/meeting-recording.spec.ts", "동의 후에만 녹음, 50초 단위 업로드, 동의 철회 시 차단"],
  "F-082": ["T", "/app/meetings/[id]", "", "lib/stt.ts (Google STT v2 / Whisper)", "services/api/test/track-c.integration.test.ts", "가짜 STT 서버로 검증. 파트 간 화자 라벨 일관성 없음"],
  "F-083": ["T", "/app/meetings/[id]", "", "lib/stt.ts + worker", "services/api/test/track-c.integration.test.ts", "화자·타임스탬프·언어, meeting.transcript.ready"],
  "F-084": ["T", "/app/meetings/[id] 자동 정리", "/meetings/{id}/extract", "assist (Claude opus-5-5 / rules)", `${AT}, ${S("S-078")}`, "ANTHROPIC_API_KEY 설정 시 Claude 요약, 미설정 시 표시된 줄만"],
  "F-085": ["T", "MeetingEditor", "/meetings/{id}/extract", "assist", `${AT}, ${S("S-078")}`, "확인 후 적용"],
  "F-086": ["T", "MeetingEditor", "/meetings/{id}/extract", "assist", AT, "확인 후 적용"],
  "F-087": ["T", "/app/meetings/[id]", "/meetings/{id}/schedule", "packages/domain/src/scheduling.ts", "services/api/test/track-b.integration.test.ts, packages/domain/test/comms.test.ts", "한/영 규칙 파서(날짜 없으면 후보 없음), LLM은 폴백"],
  "F-088": ["T", "/app/meetings/[id]", "/meetings/{id}/crm", "modules/crm.ts", "services/api/test/track-b.integration.test.ts", "Salesforce Task/HubSpot Note/Dynamics annotation"],
  "F-089": ["T", "/app/meetings/[id]", "/meetings/{id}/brief", "meeting.getMeetingBrief", IT, ""],
  "F-090": ["T", "/app/meetings/[id]", "/meetings/{id}/consent", "domain/consent", `${UT}, ${IT}, ${S("S-074~S-076")}`, ""],
  "F-091": ["T", "/app/people/[id] 요약", "/profiles/{id}/summary", "assist", AT, "Claude 또는 규칙 요약, 확인 라벨"],
  "F-092": ["T", "/app/ai", "/matches", "domain/match", `${UT}, ${IT}`, ""],
  "F-093": ["T", "/app/ai", "/matches", "domain/match (reasons)", UT, ""],
  "F-094": ["T", "/app/ai", "/ai/search", "ai", IT, ""],
  "F-095": ["T", "/app, /app/people/[id]", "/followups", "handoff (thank-you draft)", IT, "초안만, 자동 발송 없음"],
  "F-096": ["T", "/app/meetings/[id]", "/meetings/{id}/brief", "meeting", IT, ""],
  "F-097": ["T", "/app/intros", "/intros/suggestions", "modules/network.ts", "services/api/test/track-a.integration.test.ts", "Need↔Offer+강도, 근거·경로, ai_inferred 라벨"],
  "F-098": ["T", "/app/ai", "/ai/cooling", "modules/network.ts", "services/api/test/track-a.integration.test.ts", "VIP·평소 연락 주기 기반 냉각 감지"],
  "F-099": ["T", "/app/ai", "/ai/opportunities", "modules/network.ts", "services/api/test/track-a.integration.test.ts", "규칙·키워드 기반(LLM 아님)"],
  "F-100": ["T", "ReviewFields, PersonDetail", "", "contacts.field_provenance", IT, ""],
  "F-101": ["T", "", "", "domain/ocrParser.assertGrounded", UT, ""],
  "F-102": ["T", "ReviewFields, AiLabel", "assist(needsConfirmation)", "", `${AT}, ${S("S-078,S-080")}`, "AI 결과는 라벨 + 사용자 확인 후 저장"],
  "F-103": ["I", "LivingCard, PersonDetail", "", "", "", ""],
  "F-104": ["T", "PersonDetail 후속 메일 초안", "/contacts/{id}/draft", "assist", AT, "자동 발송 없음"],
  "F-105": ["I", "PersonDetail (안부/자료 전달 초안, mailto)", "/contacts/{id}/draft", "assist", "", ""],
  "F-106": ["T", "/app/messages", "/messages/{id}/send", "modules/comms.ts", "services/api/test/track-b.integration.test.ts", "approved:true 필수, Gmail→Outlook→SMTP, 중복 발송 방지, 감사로그(주소 원문 없음)"],
  "F-107": ["T", "/b/[token], /app/calendar", "/booking/*", "modules/calendar.ts", "services/api/test/track-b.integration.test.ts", "로그인 없는 예약 페이지, 슬롯=가용-바쁨-여유시간"],
  "F-108": ["T", "/app/meetings/[id]", "/calendar/candidates/{id}/approve", "modules/calendar.ts", "services/api/test/track-b.integration.test.ts", "승인 후 Google 이벤트(클라이언트 id로 중복 방지), If-Match, ICS"],
  "F-109": ["T", "/app (후속 필요)", "worker.processReminders", "followup.due + SMTP", AT, "푸시 미구현, 메일은 SMTP 설정 시"],
  "F-110": ["T", "/app/settings", "/push/*", "modules/push.ts (VAPID web-push)", "services/api/test/track-b.integration.test.ts", "410 구독 삭제, 유형별 설정, 인앱 알림함에도 미러링. iOS는 홈화면 PWA만"],
  "F-111": ["T", "/app/messages", "/templates", "packages/domain/src/template.ts", "services/api/test/track-b.integration.test.ts, packages/domain/test/comms.test.ts", "개인·팀 템플릿, 미지정 변수 거부"],
  "F-112": ["T", "/app/messages", "/translate", "modules/comms.ts (structured())", "services/api/test/track-b.integration.test.ts", "메시지 UI만; 카드 번역은 API 전용"],
  "F-113": ["T", "/app/settings", "/integrations/google/contacts/sync", "integration", GT, "가짜 Google 서버로 생성·etag 갱신·재시도·토큰 갱신 검증. 실제 Google 샌드박스 검증은 OAuth 클라이언트 필요"],
  "F-114": ["T", "/login, /app/settings", "/auth/google, /integrations/google/*", "integration", `${GT}, ${S("S-094")}`, "서명된 state, 자격증명 AES-GCM 암호화. 실계정 검증은 OAuth 클라이언트 필요"],
  "F-115": ["T", "/app/messages", "/messages/{id}/gmail-draft", "modules/comms.ts", "services/api/test/track-b.integration.test.ts", "가짜 Google 서버로 검증. 실계정 미검증"],
  "F-116": ["T", "/app/settings", "/integrations/google/drive", "modules/integration.ts", "services/api/test/track-b.integration.test.ts", "drive.file 범위 LINKOS 폴더"],
  "F-117": ["T", "/app/settings → Google Sheets로 내보내기", "/integrations/google/sheets/export", "integration.exportToGoogleSheets", GT, "새 스프레드시트 생성 + RAW 값 기록(수식 실행 방지). 실계정 검증은 OAuth 클라이언트 필요"],
  "F-118": ["T", "/app/calendar", "/calendar/*", "modules/calendar.ts", "services/api/test/track-b.integration.test.ts", "생성·수정·삭제·free/busy (가짜 서버)"],
  "F-119": ["T", "/app/integrations", "/integrations/microsoft/*", "modules/crm.ts", "services/api/test/track-b.integration.test.ts", "푸시 전용(Outlook 연락처 가져오기 없음). 가짜 Graph 서버로 검증"],
  "F-120": ["T", "/app/integrations", "/integrations/salesforce/*", "modules/crm.ts", "services/api/test/track-b.integration.test.ts", "Contact/Lead upsert, 충돌 처리. 실계정 미검증"],
  "F-121": ["T", "/app/integrations, /app/meetings/[id]", "/integrations/hubspot/*, /integrations/{provider}/{companies/sync,deals,deal-settings}", "modules/crm.ts, modules/crmHubspot.ts, packages/domain/src/crmDeals.ts", "services/api/test/track-b.integration.test.ts, services/api/test/hubspot-deals.integration.test.ts, packages/domain/test/crmDeals.test.ts", "Contacts·미팅 노트·회사(도메인 중복판정·연결)·딜(초안→사용자 승인 후에만 전송). 가짜 HubSpot 서버로 검증"],
  "F-122": ["T", "/app/integrations", "/integrations/dynamics/*", "modules/crm.ts", "services/api/test/track-b.integration.test.ts", "Contacts/Leads, If-Match, 중복 감지→충돌. 실계정 미검증"],
  "F-123": ["T", "/app/integrations", "/webhooks", "modules/webhooks.ts", "services/api/test/track-b.integration.test.ts, packages/domain/test/comms.test.ts", "HMAC 서명, 백오프, SSRF 가드(DNS 재검사), 20회 실패 시 비활성"],
  "F-124": ["T", "/app/settings", "/exports", "integration.renderExport", `${UT}, ${IT}, ${S("S-087,S-088")}`, "XLSX + CSV(수식 주입 방지)"],
  "F-125": ["T", "/app/settings (Word)", "/exports format=docx", "lib/docx", `${AT}, ${S("S-089")}`, ""],
  "F-126": ["T", "/app/people", "/exports (pdf)", "services/api/src/lib/pdf.ts (pdfkit + Pretendard)", "services/api/test/track-b.integration.test.ts", "standalone 빌드에서 폰트 포함 확인"],
  "F-127": ["I", "/app/settings", "/exports (fields)", "", "", ""],
  "F-128": ["I", "/app/settings", "/integrations", "sync_jobs + external_mappings", GT, "작업 이력·재시도·dead 상태"],
  "F-129": ["T", "/app/org", "/orgs", "modules/org.ts", "services/api/test/track-a.integration.test.ts, packages/domain/test/org.test.ts", "조직 생성, active_org 전환, 비회원 404"],
  "F-130": ["T", "/app/org/members", "/orgs/{id}/members", "packages/domain/src/org.ts (역할×권한 매트릭스)", "services/api/test/track-a.integration.test.ts, packages/domain/test/org.test.ts", "5개 역할 × 14개 행동 통합 매트릭스"],
  "F-131": ["T", "/app/team", "/orgs/{id}/contacts", "modules/org.ts", "services/api/test/track-a.integration.test.ts", "조직 간 격리, viewer PII 마스킹"],
  "F-132": ["T", "/app/team", "/orgs/{id}/leads", "modules/org.ts", "services/api/test/track-a.integration.test.ts", "회사 리드 이관(퇴사·SCIM 해지·계정삭제), 개인 연락처는 본인 소유 유지"],
  "F-133": ["T", "/app/org/graph", "/orgs/{id}/graph", "modules/network.ts (서버 결정론적 레이아웃)", "services/api/test/track-a.integration.test.ts, packages/domain/test/org.test.ts", "개인 인맥은 회사 단위 집계로만 노출"],
  "F-134": ["T", "/app/org", "/orgs/{id}/who-knows", "modules/network.ts", "services/api/test/track-a.integration.test.ts", "관계 강도 순, 개인 연락처 이름 비공개, 옵트아웃·감사로그"],
  "F-135": ["T", "/app/org", "/orgs/{id}/activity", "modules/enterprise.ts", "services/api/test/track-a.integration.test.ts", "조직 대시보드"],
  "F-136": ["T", "/app/org/settings", "/orgs/{id}/retention", "modules/enterprise.ts + worker", "services/api/test/track-a.integration.test.ts", "보존 정책·미리보기·워커 삭제(retention.purged 감사)"],
  "F-137": ["T", "", "/me/audit", "platform.audit", IT, ""],
  "F-138": ["T", "/app/org/settings, /p/[slug]", "/orgs/{id}/branding", "modules/enterprise.ts", "services/api/test/track-a.integration.test.ts", "브랜딩은 /p/[slug] 에만 표시; 로고는 data: 이미지만(CSP)"],
  "F-139": ["T", "/app/org/settings", "/orgs/{id}/policies", "modules/policy.ts", "services/api/test/track-a.integration.test.ts", "녹음 일방동의 차단, 역할별 내보내기 차단, 과공개 필드 차단"],
  "F-140": ["T", "/app/org/settings", "/ext/contacts, /ext/leads", "modules/enterprise.ts (API key sha256)", "services/api/test/track-a.integration.test.ts", "스코프·회수·rate limit"],
  "F-141": ["T", "/app/events", "/events", "event", IT, ""],
  "F-142": ["T", "/app/events", "/events/join", "event", IT, "opt-in"],
  "F-143": ["I", "/app/exchange (장소)", "", "", "", ""],
  "F-144": ["T", "/app/events/[id]", "/events/{id}/leads", "modules/capture.ts commitCapture", "services/api/test/track-c.integration.test.ts, tests/scenarios/k-capture-files.spec.ts", "배지 OCR → 행사 리드, Idempotency-Key"],
  "F-145": ["T", "/app/events/[id]", "/events/{id}/matches", "event", IT, "P2 선구현"],
  "F-146": ["T", "/app/events/[id]", "/events/{id}/meeting-requests", "modules/calendar.ts", "services/api/test/track-b.integration.test.ts", "opt-in 참가자만, 상대 이메일 비노출"],
  "F-147": ["T", "/app/events/[id]/booth", "/events/{id}/leads", "modules/booth.ts", "services/api/test/track-d.integration.test.ts", "부스 리드 수집·등급"],
  "F-148": ["T", "/app/exchange?group=1", "", "handoff", IT, ""],
  "F-149": ["T", "/app/events/[id]/booth", "/events/{id}/roi", "modules/booth.ts", "services/api/test/track-d.integration.test.ts", "행사 ROI"],
  "F-150": ["T", "/app/events/[id]", "/events/{id}/leads", "lib/offline.ts", "tests/e2e/offline-sync.spec.ts", "행사장 오프라인 리드 큐"],
  "F-151": ["T", "", "/organizer/events/{id}/{attendees,leads}", "modules/booth.ts", "services/api/test/track-d.integration.test.ts", "주최자 API 토큰, 모든 내보내기 감사로그"],
  "F-152": ["T", "/app/intros", "/intros/suggestions", "modules/network.ts", "services/api/test/track-a.integration.test.ts", "source=ai_suggested 기록"],
  "F-153": ["T", "/app/intros", "/introductions/{id}/consent", "connection", `${UT}, ${IT}, ${S("S-081,S-082")}`, ""],
  "F-154": ["T", "/app/rooms/[id]", "/rooms/{id}", "connection", `${IT}, ${S("S-083")}`, ""],
  "F-155": ["T", "/app/intros", "/intros/{id}/drafts", "modules/intro.ts", "services/api/test/track-a.integration.test.ts", "이중 옵트인 초안만(발송 없음, mailto)"],
  "F-156": ["T", "/app/rooms/[id]", "/rooms/{id}/files", "modules/files.ts", "services/api/test/track-c.integration.test.ts", "javascript: 링크 거부"],
  "F-157": ["T", "/app/rooms/[id]", "/rooms/{id}/meetings", "modules/calendar.ts", "services/api/test/track-b.integration.test.ts", "슬롯 제안·승인·나머지 대체"],
  "F-158": ["T", "/app/rooms/[id]", "/rooms/{id}/summary", "modules/intro.ts", "services/api/test/track-a.integration.test.ts", "structured() + 규칙 폴백"],
  "F-159": ["T", "/app/rooms/[id]", "/rooms/{id}/outcome", "modules/intro.ts", "services/api/test/track-a.integration.test.ts", "성과 기록·전환 통계"],
  "F-160": ["T", "CardEditor", "", "domain/acl", `${UT}, ${IT}`, ""],
  "F-161": ["T", "/app/settings", "/me/consents", "consent_records", IT, ""],
  "F-162": ["I", "", "", "on-device OCR, 선택 필드만 전송", "", ""],
  "F-163": ["P", "", "", "AES-256-GCM 자격증명, TLS(HSTS)", "", "DB at-rest 암호화는 인프라 설정"],
  "F-164": ["T", "", "", "owner-scoped queries", `${IT}, ${S("S-018,S-019,S-034,S-069,S-086,S-091")}`, "개인 범위 격리. 조직 테넌트 미구현"],
  "F-165": ["I", "", "", ".env.example, render.yaml", "", ""],
  "F-166": ["T", "", "", "audit_logs", IT, ""],
  "F-167": ["T", "/app/settings", "/me/privacy/delete", "security", `${IT}, ${S("S-093")}`, "7일 유예 후 하드 삭제"],
  "F-168": ["T", "/app/settings", "/me/privacy/export", "security", `${IT}, ${S("S-092")}`, ""],
  "F-169": ["T", "", "/meetings/{id}/recordings", "meeting", IT, ""],
  "F-170": ["I", "", "all", "platform.rateLimit", "", ""],
  "F-171": ["T", "", "/exchange", "high-entropy tokens + short-code rate limit", `${UT}, ${S("S-030")}`, ""],
  "F-172": ["T", "", "/files", "lib/filescan.ts", "services/api/test/track-c.integration.test.ts", "매직바이트·크기, EXIF 제거 재인코딩, 활성 PDF·EICAR 격리, 선택적 ClamAV"],
  "F-173": ["T", "", "", "domain/redact", `${UT}, ${IT}`, ""],
  "F-174": ["I", "manifest, sw.js", "", "", "", ""],
  "F-175": ["T", "all", "", "", `${E2E}, ${S("S-095~S-098")}`, "iPhone SE / Android 360 / iPad / 데스크톱"],
  "F-176": ["T", "전체", "", "globals.css 토큰, Fx.tsx reduced-motion", "tests/e2e/a11y.spec.ts, tests/scenarios/j-ui-devices.spec.ts", "axe WCAG A/AA 자동 감사(공개 페이지 라이트/다크), 앱 페이지 수동 axe 감사 통과"],
  "F-177": ["T", "/x/[token] 언어 선택", "", "packages/domain/src/i18n.ts (ko/en/ja 리소스, pickLocale)", "packages/domain/test/i18n.test.ts, tests/e2e/i18n.spec.ts", "게스트 수신·링크 상태 화면 ko/en/ja(Accept-Language·?lang·쿠키). 앱 내부 화면은 한국어 — 리소스 분리 구조로 확장"],
  "F-178": ["T", "/app/sync", "", "packages/domain/src/offlineQueue.ts, lib/offline.ts", "packages/domain/test/track-c.test.ts, tests/e2e/offline-sync.spec.ts", "암호화 IndexedDB 큐, 원래 Idempotency-Key로 재전송"],
  "F-179": ["T", "/app/sync", "", "lib/offline.ts, sw.js", "tests/e2e/offline-sync.spec.ts", "Background Sync, 409 충돌은 필드별 선택"],
  "F-180": ["T", "", "", "services/api/src/lib/tracing.ts (OTLP)", "services/api/test/track-d.integration.test.ts", "OTEL_EXPORTER_OTLP_ENDPOINT 설정 시만 동작; 트랜잭션 내 직접 client.query 는 스팬 없음"],
  "F-181": ["T", "/app/admin", "/admin/flags", "modules/growth.ts, lib/flags.ts", "services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts", "사용자/조직 타게팅, % 롤아웃, 킬스위치"],
  "F-182": ["I", "", "", "apple-app-site-association, assetlinks.json, apps/mobile/app.config.ts", "", "딥링크 설정. 실제 TEAMID/지문 필요"],
  "F-183": ["T", "", "", ".github/workflows/ci.yml", "", "typecheck·unit·integration·migrate·traceability·build·e2e·100 시나리오·docker"],
  "F-184": ["I", "", "", "scripts/backup.sh, scripts/restore-drill.sh", "", "로컬 복구 리허설 통과(12개 핵심 테이블 행 수 일치). 운영은 관리형 PITR 병행"],
  "F-185": ["T", "", "", "scripts/loadtest.mjs", "", "5,000 연락처·동시 20, 8개 시나리오 p95 SLO 통과(통계 낡은 최악 조건 포함)"],
  "F-186": ["I", "", "", "scripts/dr/*, RUNBOOK.md", "", "백업 복제·복원 검증 스크립트(로컬 디렉터리로 리허설). S3/GCS 경로 미검증"],
  "F-187": ["T", "/app/admin", "", "lib/metering.ts recordCost", "services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts", "추정 단가(COST_RATES_JSON 재정의)"],
  "F-188": ["T", "/app/admin", "/analytics/events", "lib/metering.ts track, growth.funnelReport", "services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts", "가입→교환→게스트→Claim 퍼널"],
  "F-189": ["T", "/app/admin, /app/insights", "", "growth.viralReport", "services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts", "K-factor, 2차 공유율, Claim율"],
  "F-190": ["T", "/app/billing", "/billing/*", "packages/domain/src/plans.ts, modules/billing.ts", "services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts", "플랜 해석"],
  "F-191": ["T", "/app/billing", "/billing/*", "modules/billing.ts", "services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts", "좌석 검사 함수(조직 멤버 API 연결 필요)"],
  "F-192": ["T", "/app/billing", "", "billing.consume()", "services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts", "교환·스캔·AI 사용량 계량, AI 한도 초과 시 규칙 폴백. 게스트는 비계량"],
  "F-193": ["T", "/app/billing", "/billing/checkout, /billing/portal", "modules/billing.ts (Stripe)", "services/api/test/track-d.integration.test.ts", "가짜 Stripe 서버로 검증"],
  "F-194": ["T", "", "/billing/webhooks/stripe", "modules/billing.ts", "services/api/test/track-d.integration.test.ts", "서명 검증, 1회 처리, 순서 역전 무시, 더닝 유예"],
  "F-195": ["T", "/app/admin", "/admin/revenue", "billing.revenueReport", "services/api/test/track-d.integration.test.ts", "관리자 전용"],
  "F-196": ["T", "/app/admin, /x/[token]", "/admin/experiments", "modules/growth.ts", "services/api/test/track-d.integration.test.ts, packages/domain/test/trackD.test.ts", "guest_reply_cta 카피 실험(ko/en/ja)"],
  "F-197": ["T", "/app/settings", "/referrals", "modules/referral.ts", "services/api/test/track-a.integration.test.ts, packages/domain/test/org.test.ts", "P3. 교환 완료 후 보상, 월 한도, REFERRAL_REWARDS_ENABLED=1 일 때만"],
};

const LABEL = { T: "✅ 구현+자동테스트", I: "🟢 구현", P: "🟡 부분", N: "⬜ 미착수" };
const features = reg.features;
const missing = features.filter((f) => !M[f.id]).map((f) => f.id);
if (process.argv.includes("--check")) {
  if (missing.length || features.length !== reg.feature_count) {
    console.error(`traceability: missing ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`traceability: all ${features.length} Feature IDs mapped`);
  process.exit(0);
}

const count = (pred) => features.filter(pred).length;
const st = (f) => M[f.id]?.[0] ?? "N";
const lines = [];
lines.push("# LINKOS TRACEABILITY", "");
lines.push("> 자동 생성: `pnpm traceability` (source: `dd/LINKOS_Product_Blueprint_v1/03_FEATURE_REGISTRY.yaml`). 직접 편집하지 말고 `scripts/traceability.mjs` 의 매핑을 수정하세요.", "");
lines.push("백서 부록 B 규칙: Feature ID → UX → API → module → DB → event → test → deploy 중 하나라도 비면 \"완료\"가 아니다. **아래 표는 현재 상태를 정직하게 기록하며, Production Ready 배지는 아직 부여하지 않는다.**", "");
lines.push("## 요약", "", "| 우선순위 | 전체 | ✅ T | 🟢 I | 🟡 P | ⬜ N |", "|---|---|---|---|---|---|");
for (const p of ["P0", "P1", "P2", "P3"]) {
  const fs = features.filter((f) => f.priority === p);
  lines.push(`| ${p} | ${fs.length} | ${fs.filter((f) => st(f) === "T").length} | ${fs.filter((f) => st(f) === "I").length} | ${fs.filter((f) => st(f) === "P").length} | ${fs.filter((f) => st(f) === "N").length} |`);
}
lines.push(`| 합계 | ${features.length} | ${count((f) => st(f) === "T")} | ${count((f) => st(f) === "I")} | ${count((f) => st(f) === "P")} | ${count((f) => st(f) === "N")} |`, "");
let mod = "";
for (const f of features) {
  if (f.module_name !== mod) {
    mod = f.module_name;
    lines.push(`## ${f.module} · ${mod}`, "", "| ID | P | 기능 | 상태 | UI | API | 모듈 | 테스트 | 비고 |", "|---|---|---|---|---|---|---|---|---|");
  }
  const [s, ui, api, m, t, note] = M[f.id] ?? ["N", "", "", "", "", ""];
  const esc = (x) => String(x ?? "").replace(/\|/g, "\\|");
  lines.push(`| ${f.id} | ${f.priority} | ${esc(f.title)} | ${LABEL[s]} | ${esc(ui)} | ${esc(api)} | ${esc(m)} | ${esc(t)} | ${esc(note)} |`);
}
lines.push("");
writeFileSync(resolve(root, "docs/TRACEABILITY.md"), lines.join("\n"));
console.log(`docs/TRACEABILITY.md written (${features.length} features)`);
