# PROPLUS 내부 계약 (구현자 공용)

이 파일은 **구현 중 서로 다른 파일을 쓰는 사람/에이전트가 같은 이름을 쓰게 하려는 목적**이다.
제품 결정은 `00_DEV_STRATEGY.md`, 기능 목록은 `01_FEATURE_REGISTRY.yaml` 이 진실이다.

## 패키지 이름

| 패키지 | 경로 | import 경로 |
|---|---|---|
| `@proplus/domain` | `proplus/packages/domain` | `import { ... } from "@proplus/domain"` |
| `@proplus/api` | `proplus/services/api` | `import { ... } from "@proplus/api"` |
| `@proplus/web` | `proplus/apps/web` | — (앱) |

`@proplus/domain` 은 I/O 를 하지 않는다. `Date.now()` 를 쓰지 않고 `now: Date` 를 인자로 받는다.

## 이미 존재하는 도메인 파일 (고치지 말 것, import 해서 쓸 것)

### `src/types.ts`
```ts
VERIFICATION_METHODS, VerificationMethod          // 'self_declared'|'document_reviewed'|'issuer_confirmed'|'system_integrated'
PROOF_STATUSES, ProofStatus                       // submitted|under_review|needs_more_info|verified|rejected|expired|revoked|disputed
EvidenceSource, CONSENT_PURPOSES, ConsentPurpose
ProofActor                                        // 'owner'|'reviewer'|'system'
MemberRole, PlatformRole, LEAD_STAGES, LeadStage, Provenance
METHOD_LABEL_KO, METHOD_RANK, isAtLeast(method, min)
```

### `src/proof.ts`
```ts
canTransition(input: TransitionInput): TransitionResult     // {ok:true} | {ok:false,code,message}
allowedTransitions(from, actor): readonly ProofStatus[]
isTerminal(status): boolean
isEffectivelyExpired(expiresAt, now): boolean
effectiveStatus(status, expiresAt, now): ProofStatus
isExpiringSoon(expiresAt, now, withinDays?): boolean
computeExpiry(verifiedAt, ttlDays): Date | null
```

### `src/badge.ts`
```ts
DISPUTED_LABEL_KO = "확인 필요"
FORBIDDEN_CLAIM_PATTERNS, findForbiddenClaim(text): string | null
BadgeRow, PublicBadge
toPublicBadge(b, now, opts?): PublicBadge | null
toPublicBadges(rows, now, issuerRequired?): PublicBadge[]
canIssueBadge(input): {ok:true} | {ok:false,code,message}   // ← 구독/요금제 인자 없음 (N-2)
```

### `src/publicDto.ts`
```ts
PUBLIC_PROFILE_FIELDS, PUBLIC_OFFER_FIELDS, PUBLIC_METRIC_FIELDS, NEVER_PUBLIC_KEYS
pickPublic(src, fields)
findPrivateKey(value, path?): string | null
assertNoPrivateKeys(value): void
publicContact(settings, contact): {email?,phone?}
```

## 구현할 도메인 파일과 정확한 시그니처

모두 `proplus/packages/domain/src/` 아래. 각 파일은 **named export 만** 쓴다(default export 금지).

### `slug.ts`
```ts
RESERVED_SLUGS: ReadonlySet<string>      // api, app, admin, p, login, legal, search, assets, _next, static, health, me, about, help, proplus
normalizeSlug(raw: string): string        // 소문자, 공백/_→-, 허용문자 [a-z0-9-], 연속 - 축약, 양끝 - 제거
validateSlug(raw: string): {ok:true, slug:string} | {ok:false, code:string, message:string}
  // 거부: 길이<3 또는 >40, 예약어, 숫자만, 'xn--' 시작, 전부 '-'
```

### `sanitize.ts`
```ts
sanitizeText(input: string, maxLen?: number): string
  // HTML 태그 제거, 제어문자 제거, 공백 정규화, 길이 제한. 저장 전·렌더 전 둘 다 쓴다.
stripDangerousUrl(url: string): string | null
  // http/https 만 통과. javascript:, data:, vbscript:, file: 등은 null
isSafeExternalUrl(url: string): boolean
```

### `blockSchema.ts`  (N-10)
```ts
BLOCK_KINDS = ['intro','badges','specialties','offers','faq','contact','links','metrics','career'] as const
type BlockKind = ...
interface Block { kind: BlockKind; position: number; props: Record<string, unknown>; visible: boolean }
validateBlock(input: unknown): {ok:true, block:Block} | {ok:false, code:string, message:string}
validateBlocks(input: unknown): {ok:true, blocks:Block[]} | {ok:false, code:string, message:string}
  // 각 kind 별 허용 props 키를 화이트리스트로 검사. 허용 밖 키는 **삭제**(에러 아님).
  // props 의 문자열 값은 sanitizeText 를 통과시킨다. html/script/style/on* 키는 거부.
  // position 중복·음수 거부. 최대 24개.
```

### `consent.ts`  (N-11)
```ts
interface ConsentInput { purpose: ConsentPurpose; granted: boolean; policyVersion: string }
REQUIRED_FOR_LEAD: readonly ConsentPurpose[]   // ['service']  — marketing 은 절대 필수가 아니다
validateLeadConsents(inputs: readonly ConsentInput[]): {ok:true} | {ok:false, code:string, message:string}
  // service 동의가 granted=true 로 있어야 통과. marketing 없음/거부도 통과.
hasConsent(records, purpose): boolean
separateConsents(inputs): { required: ConsentInput[]; optional: ConsentInput[] }
```

### `metric.ts`  (N-8)
```ts
interface MetricClaimInput {
  metricCode: string; value: number; unit: string;
  periodStart: string; periodEnd: string; sampleSize: number; basis: string;
  method?: VerificationMethod | null;
}
validateMetricClaim(i: MetricClaimInput): {ok:true} | {ok:false, code:string, message:string}
  // 거부: basis 빈값, sampleSize<=0, periodEnd<periodStart, 날짜 파싱 실패, value 비유한수
isVerifiableMetric(method): boolean      // system_integrated 만 true  (P-067)
formatMetricDisclosure(i): string
  // "2026-01-01~2026-06-30 · 표본 128건 · 집계기준: <basis>"  — 기간·분모 없이 수치만 보여주지 않는다
```

### `acl.ts`
```ts
type Capability = 'profile.edit'|'evidence.submit'|'evidence.review'|'badge.issue'|'badge.revoke'
  |'org.manage'|'org.member.verify'|'lead.read'|'lead.assign'|'audit.read'|'report.handle'|'admin.access'
interface Principal { userId: string | null; platformRole: PlatformRole; memberships: readonly {organizationId:string; role:MemberRole; status:string}[] }
can(p: Principal, cap: Capability, target?: {ownerUserId?:string; organizationId?:string}): boolean
  // evidence.review / badge.issue / badge.revoke / audit.read → platformRole reviewer|admin 만
  // org.manage / org.member.verify → 해당 조직의 manager|owner 만 (N-12: 프로필 소유권은 주지 않는다)
  // profile.edit → 본인만
assertCan(p, cap, target?): void     // 실패 시 throw new Error('forbidden:<cap>')
isOrgManager(p, organizationId): boolean
```

### `redact.ts`  (N-13)
```ts
redact(value: unknown): unknown
  // 재귀. 이메일/전화 패턴을 '[redacted:email]' / '[redacted:phone]' 로 치환.
  // 키 이름이 email|phone|contact|token|secret|password|authorization 를 포함하면 값을 '[redacted]'.
maskEmail(e: string): string         // 'ab***@example.com'
maskPhone(p: string): string         // '010-****-1234'
hashVisitor(ip: string, ua: string, salt: string): string   // sha256 hex 앞 32자 (node:crypto)
```

### `mask.ts`
```ts
maskContact(kind: 'email'|'phone', value: string): string    // redact.ts 의 mask* 를 kind 로 분기
```

### `token.ts`
```ts
generateToken(bytes?: number): string      // base64url, 기본 32바이트 (≥128bit, CLAUDE.md §3)
hashToken(t: string): string               // sha256 hex — DB 에는 이것만 저장
constantTimeEqual(a: string, b: string): boolean
```

### `rateLimit.ts`
```ts
interface Limit { limit: number; windowMs: number }
RATE_LIMITS: Record<string, Limit>
  // 'login': 5/15m, 'lead.create': 5/10m, 'evidence.submit': 20/1h,
  // 'profile.update': 60/1h, 'search': 60/1m, 'public.view': 240/1m,
  // 'report.create': 3/10m  ← 표적 신고로 운영 큐를 막는 것을 방어 (P-167)
  // 버킷을 추가하면 test/rateLimit.test.ts 의 DOCUMENTED 표도 함께 고쳐야 한다(의도된 게이트).
checkLimit(name, used, windowStart, now): {allowed:true} | {allowed:false, retryAfterSec:number}
bucketKey(name, who): string
windowStartFor(name, now): Date
```

### `origin.ts`
```ts
isAllowedOrigin(origin: string|null, host: string|null, appOrigin?: string): boolean
  // origin 없음 → true (비브라우저). origin 이 appOrigin 또는 host 와 같으면 true.
```

### `leadStage.ts`
```ts
canChangeStage(from: LeadStage, to: LeadStage): boolean
  // 전진 자유, won/lost 에서 되돌리기는 'contacted' 이상으로만. 같은 단계 거부.
isClosed(s: LeadStage): boolean
LEAD_STAGE_LABEL_KO: Record<LeadStage, string>
```

### `plans.ts`
```ts
interface PlanLimits { offers:number; blocks:number; customDomain:boolean; booking:boolean; analyticsDays:number; teamSeats?:number }
withinLimit(limits: PlanLimits, key: keyof PlanLimits, current: number): boolean
// N-2 를 지키기 위해 badge 관련 키는 PlanLimits 에 **없다**
```

### `completeness.ts`  (N-3)
```ts
interface CompletenessInput { hasHeadline:boolean; hasBio:boolean; specialtyCount:number; badgeCount:number; offerCount:number; hasCta:boolean }
profileCompleteness(i): { percent:number; missing:string[] }
// 반환값은 워크스페이스 안내 전용. 공개 DTO 에 넣지 않는다(NEVER_PUBLIC_KEYS 에 'completeness' 가 있다).
```

### `search.ts`  (N-15)
```ts
type Placement = 'organic' | 'promoted'
interface SearchResult { profileId:string; slug:string; displayName:string; headline:string|null;
  specialties:string[]; region:string|null; badgeTypes:string[]; placement:Placement; rankingBasis:string[] }
RANKING_BASIS_CODES: readonly string[]   // 'specialty_match','region_match','badge_present','recently_active','promoted_placement'
buildRankingBasis(f: {specialtyMatch:boolean; regionMatch:boolean; hasBadge:boolean; recentlyActive:boolean; promoted:boolean}): string[]
validateSearchResults(rs: readonly SearchResult[]): void
  // rankingBasis 가 빈 배열이거나 RANKING_BASIS_CODES 밖 코드가 있으면 throw (N-15: 재현 가능한 근거만)
  // promoted 인데 rankingBasis 에 'promoted_placement' 가 없으면 throw
```

### `vcard.ts`
```ts
interface VCardInput { displayName:string; headline?:string|null; org?:string|null; url:string; email?:string|null; phone?:string|null }
buildVCard(i: VCardInput): string
// RFC 5545 스타일 CRLF. 공개 허용된 값만 호출부가 넘긴다 — 이 함수는 받은 것만 쓴다 (P-035).
```

### `mime.ts`
```ts
EVIDENCE_MIME: ReadonlySet<string>    // image/jpeg, image/png, image/webp, application/pdf
MAX_EVIDENCE_BYTES = 10 * 1024 * 1024
sniffMime(head: Uint8Array): string | null    // magic bytes: jpeg, png, webp, pdf
validateUpload(declared: string, size: number, head: Uint8Array): {ok:true, mime:string} | {ok:false, code:string, message:string}
  // declared 와 sniff 결과가 다르면 거부 (보안정책 §2 MIME sniffing)
```

### `events.ts`
```ts
PROPLUS_EVENTS = ['profile.published','profile.unpublished','evidence.submitted','verification.completed',
  'verification.expired','verification.revoked','badge.issued','lead.created','appointment.booked',
  'product.updated','transaction.verified','membership.revoked','appeal.submitted','report.created'] as const
type ProplusEvent = (typeof PROPLUS_EVENTS)[number]
interface EventEnvelope { eventId:string; eventType:ProplusEvent; occurredAt:string; tenantId:string|null;
  actorId:string|null; aggregateType:string; aggregateId:string|null; schemaVersion:number; correlationId:string|null;
  payload: Record<string, unknown> }
buildEnvelope(i): EventEnvelope      // payload 는 redact() 를 통과시킨다 (기술백서 §7: PII 금지)
```

### `index.ts`
위의 모든 파일 + 기존 types/proof/badge/publicDto 를 `export *` 로 재수출.

## `@proplus/api` 구조

```
proplus/services/api/
  package.json         name @proplus/api, deps: @proplus/domain, pg, zod, nodemailer
  tsconfig.json        extends ../../../tsconfig.base.json
  vitest.config.ts
  src/index.ts         배럴
  src/migrate.ts       MIGRATIONS_DIR = resolve(here,'../../db/migrations'), advisory lock 727275 (LINKOS 는 727274)
  src/worker.ts        outbox 폴링 + 만료 알림
  src/lib/db.ts        pool(), q(), one(), tx(), mapInputError(), closePool()  — globalThis.__proplusPool
  src/lib/errors.ts    ApiError + badRequest/unauthorized/forbidden/notFound/conflict/tooMany/unavailable
  src/lib/log.ts       log(level, event, fields)  — fields 는 redact() 통과
  src/lib/audit.ts     writeAudit(db, {...})
  src/lib/outbox.ts    enqueue(client, envelopeInput)  — 반드시 트랜잭션 client 를 받는다 (N-183)
  src/lib/idempotency.ts  idempotencyLookup/idempotencyStore/isValidIdempotencyKey
  src/lib/limits.ts    consumeLimit(name, who) → ApiError(429) 또는 void
  src/lib/storage.ts   putObject/getSignedUrl/deleteObject  — local 드라이버, 어댑터 인터페이스
  src/lib/mail.ts      sendMail  — SMTP_URL 없으면 로그만
  src/lib/crypto.ts    encryptField/decryptField (AES-256-GCM, FIELD_KEY env)
  src/lib/build.ts     buildInfo() → {version, revision}
  src/modules/*.ts     identity, profile, proof, org, lead, catalog, booking, analytics, admin, billing, search
```

모듈 함수는 `Ctx` 를 첫 인자로 받는다:
```ts
interface Ctx { userId: string | null; ip: string; userAgent: string; requestId: string }
```

## `@proplus/web` 라우트

```
proplus/apps/web/src/
  lib/server.ts        route() 래퍼 — LINKOS apps/web/src/lib/server.ts 와 같은 책임
                       쿠키 이름은 pp_session / pp_anon (LINKOS 의 lk_* 와 겹치지 않게)
  app/layout.tsx       Instrument Serif + Inter Tight + Pretendard
  app/globals.css      PROPLUS 토큰 (아래 §디자인)
  app/page.tsx         랜딩 (브랜드 §4 카피)
  app/p/[slug]/page.tsx        공개 프로필 (SSR, 인증 없음)
  app/login/page.tsx
  app/app/**           워크스페이스 (me, evidence, leads, analytics, offers, settings)
  app/admin/**         검증 콘솔
  app/api/v1/**        라우트 핸들러
```

## 디자인 토큰 (PROPLUS 전용)

브랜드 §7 "신뢰, 전문성, 현대성, 접근성 / 고대비, 넓은 여백, 명료한 타이포그래피".
LINKOS 의 파스텔("Porcelain & Pastel")과 **다른 인상**이어야 한다 — PROPLUS 는 신뢰·전문성이므로
차분한 중성 배경 + 단일 강조색(딥 틸) + 검증 상태용 의미색을 쓴다.

```css
--bg: #ffffff;  --bg-elev: #ffffff;  --bg-sunk: #f4f6f8;
--fg: #12233f;  --fg-mute: #5a6b80;
--line: rgba(18,35,63,0.10);  --line-strong: rgba(18,35,63,0.20);
--accent: #167d9a;        /* 딥 틸 — 다이어그램 09 의 PROOF 강조색과 같은 계열 */
--accent-text: #0f5f76;
--accent-soft: #dceaf2;
--verified: #1f7a4d;      /* 검증 완료 */
--pending: #8a6a1f;       /* 검토 중 */
--caution: #9a3412;       /* 분쟁/만료 */
--radius-card: 14px;
```

규칙: 하드코딩 색 금지, 토큰만. 배지 상태는 **색 + 텍스트 + 아이콘**을 함께 쓴다(브랜드 §7).
다크 모드는 토큰 재정의로 지원.

## 코드 주석 규칙

- 기능 ID 를 파일 상단이나 함수 주석에 적는다: `// P-053: 검증 상태 머신`
- 문서 근거를 적을 때는 출처를 표기한다: `(보안정책 §4.2)`, `(기술백서 §6)`
- 주석은 **왜**를 적는다. 무엇을 하는지는 코드가 말한다.
- 한국어 주석. 기존 LINKOS 저장소와 같은 관례다.
