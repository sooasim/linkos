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

// [status, UI route, API, module, tests, note]
const M = {
  "F-001": ["T", "/login", "/auth/otp, /auth/verify, /auth/google", "identity", `${IT}, ${E2E}`, "Email OTP + Google OIDC. Apple Sign-in 미구현"],
  "F-002": ["T", "/x/[token], /c/[code]", "/exchange/sessions/{token}", "handoff", `${IT}, ${E2E}`, ""],
  "F-003": ["T", "/claim", "/guest/claim", "handoff.claimGuest", `${IT}, ${E2E}`, ""],
  "F-004": ["N", "", "", "", "", "organizations 테이블만 존재"],
  "F-005": ["I", "/app/me/edit?new=1", "/profiles", "card", "", ""],
  "F-006": ["N", "", "", "", "", "WebAuthn 미구현"],
  "F-007": ["T", "/app/settings", "/me/devices", "identity.resolveSession", IT, "refresh rotation + reuse detection + device revoke"],
  "F-008": ["N", "", "", "", "", ""],
  "F-009": ["T", "/login (consent step)", "/auth/verify, /me/consents", "identity", `${UT}, ${IT}, ${E2E}`, ""],
  "F-010": ["P", "/app/scan", "/capture/cards", "CardScanner (on-device)", "", "명암 보정·회전(EXIF/auto) 구현, 자동 테두리/원근 보정 미구현"],
  "F-011": ["I", "/app/scan", "/capture/cards (backLines)", "capture", "", ""],
  "F-012": ["N", "", "", "", "", ""],
  "F-013": ["N", "", "", "", "", ""],
  "F-014": ["P", "", "/capture/cards kind=badge", "capture", "", "badge 저장 구분만"],
  "F-015": ["P", "/app/scan", "", "tesseract.js kor+eng", UT, "한국어/영어. 일본어/중국어 언어팩 미적용"],
  "F-016": ["T", "/app/scan", "/capture/cards, /capture/parse", "domain/ocrParser", `${UT}, ${IT}`, "규칙 기반 구조화(원문 외 값 생성 금지)"],
  "F-017": ["T", "ReviewFields", "/capture/cards", "domain/ocrParser", UT, "필드별 confidence + bbox"],
  "F-018": ["T", "ReviewFields", "", "domain.needsReview", UT, ""],
  "F-019": ["P", "", "business_cards.raw_ocr", "capture", "", "OCR 원문/좌표 보관. 이미지 원본 저장(암호화 object storage)은 미구현 — 기기 밖 전송 안 함"],
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
  "F-031": ["P", "CardEditor", "/profiles (variants)", "card", "", "변형 저장만, 수신자별 자동 선택 미구현"],
  "F-032": ["N", "", "", "", "", ""],
  "F-033": ["P", "", "", "profile.updated outbox", "", "이벤트 발행만, 연결 상대 알림 미구현"],
  "F-034": ["T", "CardEditor", "/p/{slug}, /exchange/sessions/{token}", "domain/acl", `${UT}, ${IT}`, ""],
  "F-035": ["I", "/p/[slug], /app/me", "/profiles/{id}/access-requests, /access-requests", "card", "", ""],
  "F-036": ["I", "LivingCard", "", "LivingCard (tel/mailto/vCard)", "", "예약/견적/NDA CTA 미구현"],
  "F-037": ["T", "/app/exchange", "/exchange/sessions", "handoff", E2E, ""],
  "F-038": ["T", "ExchangeConsole.detectCapabilities", "/exchange/sessions", "domain/handoff", UT, ""],
  "F-039": ["N", "", "", "", "", "네이티브 앱 필요 (apps/mobile 미구현)"],
  "F-040": ["N", "", "", "", "", ""],
  "F-041": ["I", "/app/exchange", "/exchange/manage/{id}/attempts", "handoff", "", "navigator.share — 헤드리스 테스트 불가"],
  "F-042": ["P", "", "", ".well-known/apple-app-site-association", "", "AASA 자리표시자만, App Clip 미구현"],
  "F-043": ["T", "/x/[token] (PWA)", "", "web", E2E, ""],
  "F-044": ["P", "/app/settings", "", "handoff ladder", UT, "사다리 단계만, 태그 기록 미구현"],
  "F-045": ["T", "/c, /c/[code]", "/exchange/sessions/{code}", "handoff", `${UT}, ${IT}, ${E2E}`, ""],
  "F-046": ["P", "", "", "domain/handoff (web_rendezvous)", UT, "채널 계획만"],
  "F-047": ["N", "", "", "", "", "P3 실험"],
  "F-048": ["T", "/app/exchange", "/exchange/manage/{id}/attempts", "domain/handoff", `${UT}, ${IT}, ${E2E}`, ""],
  "F-049": ["T", "GuestFlow consent", "/exchange/sessions/{token}/reply", "handoff", `${IT}, ${E2E}`, ""],
  "F-050": ["T", "", "/exchange/sessions", "domain/token", `${UT}, ${IT}`, "192-bit, SHA-256 해시 저장, TTL, 1회성, revoke, rate limit"],
  "F-051": ["T", "/app/exchange?group=1", "/exchange/sessions (group)", "handoff", IT, ""],
  "F-052": ["N", "", "", "", "", "네이티브 앱 필요"],
  "F-053": ["T", "/x/[token]", "/exchange/sessions/{token}", "handoff", `${IT}, ${E2E}`, ""],
  "F-054": ["T", "GuestFlow", "", "", E2E, ""],
  "F-055": ["I", "GuestFlow + CardScanner", "/capture/parse", "domain/ocrParser", "", "OCR은 실제 카메라 필요(수동 검증)"],
  "F-056": ["T", "GuestFlow", "/exchange/sessions/{token}/reply", "handoff", E2E, ""],
  "F-057": ["N", "", "", "", "", ""],
  "F-058": ["T", "ReviewFields(selectable)", "/exchange/sessions/{token}/reply", "handoff", `${IT}, ${E2E}`, "체크한 필드만 전송"],
  "F-059": ["T", "/claim", "/guest/claim", "handoff", `${IT}, ${E2E}`, ""],
  "F-060": ["P", "/login", "/auth/google", "identity", "", "Google OAuth 리다이렉트. One Tap 위젯 미구현"],
  "F-061": ["T", "/claim", "/guest/claim", "handoff.claimGuest", IT, "초안으로 Living Card 자동 생성"],
  "F-062": ["I", "GuestFlow, CardEditor", "", "", "", ""],
  "F-063": ["I", "ExchangeConsole '다음 사람과 교환'", "", "", "", ""],
  "F-064": ["N", "", "", "", "", ""],
  "F-065": ["T", "/app/people", "/contacts", "relationship", IT, ""],
  "F-066": ["T", "", "business_cards", "capture", IT, ""],
  "F-067": ["T", "타임라인", "/contacts/{id}/encounters", "relationship", IT, ""],
  "F-068": ["T", "", "", "relationship", IT, ""],
  "F-069": ["I", "/app/people (회사별 그룹)", "", "relationship.upsertCompany", "", ""],
  "F-070": ["I", "/app/people, /app/scan", "/contacts (tags)", "relationship", "", ""],
  "F-071": ["T", "/app/ai", "/ai/search", "ai.relationshipSearch", IT, "어휘+기간 해석. 임베딩 검색 미구현"],
  "F-072": ["T", "/app/people/[id]", "/contacts/{id}/merge", "relationship", IT, ""],
  "F-073": ["P", "", "", "audit_logs, contacts.version", IT, "버전/감사로그 기록, 필드 이력 UI 미구현"],
  "F-074": ["P", "", "", "worker (strength nudge)", "", ""],
  "F-075": ["T", "/app/people/[id]", "/contacts/{id}/notes", "relationship", IT, "항상 private"],
  "F-076": ["N", "", "", "", "", ""],
  "F-077": ["N", "", "", "", "", ""],
  "F-078": ["I", "/app/people", "/followups", "meeting.createFollowup", "", "relationships.next_followup_at"],
  "F-079": ["T", "/app/meetings/[id]", "/meetings", "meeting", IT, ""],
  "F-080": ["N", "", "", "", "", ""],
  "F-081": ["P", "/app/meetings/[id]", "/meetings/{id}/recordings", "meeting", IT, "동의 게이트만; 저장소/STT 미연결 시 503"],
  "F-082": ["N", "", "", "", "", "STT 워커 미구현"],
  "F-083": ["N", "", "", "", "", ""],
  "F-084": ["P", "MeetingEditor", "", "", "", "수동 요약 입력"],
  "F-085": ["P", "MeetingEditor", "/meetings", "meeting", IT, "수동 To-do; 자동 추출 미구현"],
  "F-086": ["P", "MeetingEditor", "/meetings", "meeting", IT, "수동 약속; 자동 추출 미구현"],
  "F-087": ["N", "", "", "", "", ""],
  "F-088": ["N", "", "", "", "", ""],
  "F-089": ["T", "/app/meetings/[id]", "/meetings/{id}/brief", "meeting.getMeetingBrief", IT, ""],
  "F-090": ["T", "/app/meetings/[id]", "/meetings/{id}/consent", "domain/consent", `${UT}, ${IT}`, ""],
  "F-091": ["N", "", "", "", "", "LLM 미연결"],
  "F-092": ["T", "/app/ai", "/matches", "domain/match", `${UT}, ${IT}`, ""],
  "F-093": ["T", "/app/ai", "/matches", "domain/match (reasons)", UT, ""],
  "F-094": ["T", "/app/ai", "/ai/search", "ai", IT, ""],
  "F-095": ["T", "/app, /app/people/[id]", "/followups", "handoff (thank-you draft)", IT, "초안만, 자동 발송 없음"],
  "F-096": ["T", "/app/meetings/[id]", "/meetings/{id}/brief", "meeting", IT, ""],
  "F-097": ["N", "", "", "", "", ""],
  "F-098": ["N", "", "", "", "", ""],
  "F-099": ["N", "", "", "", "", ""],
  "F-100": ["T", "ReviewFields, PersonDetail", "", "contacts.field_provenance", IT, ""],
  "F-101": ["T", "", "", "domain/ocrParser.assertGrounded", UT, ""],
  "F-102": ["I", "ReviewFields, AiLabel", "", "", "", "AI 결과는 라벨 + 사용자 확인"],
  "F-103": ["I", "LivingCard, PersonDetail", "", "", "", ""],
  "F-104": ["P", "PersonDetail", "/followups", "", "", "템플릿 초안 (LLM 미연결)"],
  "F-105": ["P", "PersonDetail (mailto)", "", "", "", ""],
  "F-106": ["N", "", "", "", "", "Gmail 발송 미구현"],
  "F-107": ["N", "", "", "", "", ""],
  "F-108": ["N", "", "", "", "", ""],
  "F-109": ["P", "/app (후속 필요)", "/followups", "", "", "푸시/메일 리마인더 미구현"],
  "F-110": ["N", "", "", "", "", ""],
  "F-111": ["N", "", "", "", "", ""],
  "F-112": ["N", "", "", "", "", ""],
  "F-113": ["P", "/app/settings", "/integrations/google/contacts/sync", "integration", "", "People API create/update + etag 매핑 구현, Google 샌드박스 검증 미실시"],
  "F-114": ["P", "/login, /app/settings", "/auth/google, /integrations/google/*", "integration", "", "자격증명 필요, 샌드박스 검증 미실시"],
  "F-115": ["N", "", "", "", "", ""],
  "F-116": ["N", "", "", "", "", ""],
  "F-117": ["N", "", "", "", "", ""],
  "F-118": ["N", "", "", "", "", ""],
  "F-119": ["N", "", "", "", "", ""],
  "F-120": ["N", "", "", "", "", ""],
  "F-121": ["N", "", "", "", "", ""],
  "F-122": ["N", "", "", "", "", ""],
  "F-123": ["N", "", "", "", "", ""],
  "F-124": ["T", "/app/settings", "/exports", "integration.renderExport", `${UT}, ${IT}`, "XLSX + CSV(수식 주입 방지)"],
  "F-125": ["N", "", "", "", "", "DOCX 내보내기 미구현"],
  "F-126": ["P", "/app/settings", "/exports", "integration", "", "TXT/vCard/JSON 구현, PDF 미구현"],
  "F-127": ["I", "/app/settings", "/exports (fields)", "", "", ""],
  "F-128": ["P", "/app/settings", "/integrations", "sync_jobs", "", "작업 이력 표시"],
  "F-129": ["N", "", "", "", "", ""],
  "F-130": ["N", "", "", "", "", ""],
  "F-131": ["N", "", "", "", "", ""],
  "F-132": ["N", "", "", "", "", ""],
  "F-133": ["N", "", "", "", "", ""],
  "F-134": ["N", "", "", "", "", ""],
  "F-135": ["P", "/app/insights", "/insights/kpis", "analytics", IT, "개인 범위"],
  "F-136": ["P", "", "", "worker (OTP/idempotency 정리)", "", ""],
  "F-137": ["T", "", "/me/audit", "platform.audit", IT, ""],
  "F-138": ["N", "", "", "", "", ""],
  "F-139": ["N", "", "", "", "", ""],
  "F-140": ["N", "", "", "", "", ""],
  "F-141": ["T", "/app/events", "/events", "event", IT, ""],
  "F-142": ["T", "/app/events", "/events/join", "event", IT, "opt-in"],
  "F-143": ["I", "/app/exchange (장소)", "", "", "", ""],
  "F-144": ["N", "", "", "", "", ""],
  "F-145": ["T", "/app/events/[id]", "/events/{id}/matches", "event", IT, "P2 선구현"],
  "F-146": ["N", "", "", "", "", ""],
  "F-147": ["N", "", "", "", "", ""],
  "F-148": ["T", "/app/exchange?group=1", "", "handoff", IT, ""],
  "F-149": ["N", "", "", "", "", ""],
  "F-150": ["N", "", "", "", "", ""],
  "F-151": ["N", "", "", "", "", ""],
  "F-152": ["N", "", "", "", "", ""],
  "F-153": ["T", "/app/intros", "/introductions/{id}/consent", "connection", `${UT}, ${IT}`, ""],
  "F-154": ["T", "/app/rooms/[id]", "/rooms/{id}", "connection", IT, ""],
  "F-155": ["N", "", "", "", "", ""],
  "F-156": ["N", "", "", "", "", ""],
  "F-157": ["N", "", "", "", "", ""],
  "F-158": ["N", "", "", "", "", ""],
  "F-159": ["N", "", "", "", "", ""],
  "F-160": ["T", "CardEditor", "", "domain/acl", `${UT}, ${IT}`, ""],
  "F-161": ["T", "/app/settings", "/me/consents", "consent_records", IT, ""],
  "F-162": ["I", "", "", "on-device OCR, 선택 필드만 전송", "", ""],
  "F-163": ["P", "", "", "AES-256-GCM 자격증명, TLS(HSTS)", "", "DB at-rest 암호화는 인프라 설정"],
  "F-164": ["T", "", "", "owner-scoped queries", IT, "개인 범위 격리. 조직 테넌트 미구현"],
  "F-165": ["I", "", "", ".env.example, render.yaml", "", ""],
  "F-166": ["T", "", "", "audit_logs", IT, ""],
  "F-167": ["T", "/app/settings", "/me/privacy/delete", "security", IT, "7일 유예 후 하드 삭제"],
  "F-168": ["T", "/app/settings", "/me/privacy/export", "security", IT, ""],
  "F-169": ["T", "", "/meetings/{id}/recordings", "meeting", IT, ""],
  "F-170": ["I", "", "all", "platform.rateLimit", "", ""],
  "F-171": ["I", "", "/exchange", "high-entropy tokens + short-code rate limit", UT, ""],
  "F-172": ["N", "", "", "", "", "업로드 없음(사진은 기기 내 처리)"],
  "F-173": ["T", "", "", "domain/redact", `${UT}, ${IT}`, ""],
  "F-174": ["I", "manifest, sw.js", "", "", "", ""],
  "F-175": ["T", "all", "", "", E2E, "모바일/데스크톱 2 프로젝트"],
  "F-176": ["P", "", "", "", "", "포커스 링·aria·reduced-motion. 감사(axe) 미실시"],
  "F-177": ["P", "", "", "", "", "한국어 UI. 다국어 리소스 분리 미구현"],
  "F-178": ["N", "", "", "", "", ""],
  "F-179": ["P", "", "", "Idempotency-Key, sync_jobs", "", ""],
  "F-180": ["P", "", "/health", "structured logs + x-request-id", "", "메트릭/트레이싱 미구현"],
  "F-181": ["N", "", "", "", "", ""],
  "F-182": ["P", "", "", "AASA 자리표시자", "", ""],
  "F-183": ["T", "", "", ".github/workflows/ci.yml", "", ""],
  "F-184": ["N", "", "", "", "", "관리형 DB PITR 사용 권장 (RUNBOOK)"],
  "F-185": ["N", "", "", "", "", ""],
  "F-186": ["N", "", "", "", "", ""],
  "F-187": ["N", "", "", "", "", ""],
  "F-188": ["P", "/app/insights", "/insights/kpis", "analytics", IT, ""],
  "F-189": ["P", "/app/insights", "", "analytics (claim rate)", "", ""],
  "F-190": ["N", "", "", "", "", ""],
  "F-191": ["N", "", "", "", "", ""],
  "F-192": ["N", "", "", "", "", ""],
  "F-193": ["N", "", "", "", "", ""],
  "F-194": ["N", "", "", "", "", ""],
  "F-195": ["N", "", "", "", "", ""],
  "F-196": ["N", "", "", "", "", ""],
  "F-197": ["N", "", "", "", "", ""],
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
