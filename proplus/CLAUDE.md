# PROPLUS — 개발 지침 (proplus/ 서브트리 전용 Project Memory)

저장소 루트의 `CLAUDE.md` 는 **LINKOS** 지침이다. 이 파일은 **`proplus/` 안에서 작업할 때의 상시 지침**이다.
두 제품은 같은 저장소를 쓰지만 DB·기능원장·프로세스·쿠키·스토리지·감사로그가 분리되어 있다
(근거: `docs/02_ADR.md` ADR-009, `docs/00_DEV_STRATEGY.md` §1).
출처는 `dd/PROPLUS_Technical_Document_Set/` 번들이고 기능 ID 는 **`P-xxx`** 다.

## 1. Source of Truth

- 기능 원장: `proplus/docs/01_FEATURE_REGISTRY.yaml` (`P-xxx`). ID 를 삭제·통합·이름변경·묵시적 보류 금지.
- 제품 결정: `proplus/docs/00_DEV_STRATEGY.md` — 특히 **§2 비타협 원칙 N-1~N-15**.
- 아키텍처 결정: `proplus/docs/02_ADR.md` (ADR-001~011). 결정을 바꾸려면 항목을 고치지 말고 새 ADR 을 추가한다.
  (예외: 측정에 근거한 결정이 재측정으로 뒤집히면 해당 ADR 하단에 **날짜가 붙은 갱신 절**을 덧붙인다 — ADR-011 참조.
  원래 항목은 지우지 않는다. 왜 그때 그렇게 판단했는지가 다음 사람에게 필요하다.)
- 내부 계약: `proplus/docs/CONTRACTS.md` — 파일 목록·함수 시그니처·디자인 토큰. **이름을 임의로 바꾸지 않는다.**
- DB: `proplus/db/migrations/*.sql` 가 실제 스키마다(컬럼명·제약·뷰). **추가만 한다.** 원본 테이블·트리거·뷰를 지우지 않는다.
- 추적성: `proplus/docs/TRACEABILITY.md` 는 `pnpm proplus:traceability` 로 재생성한다.
  **테스트가 없는 기능은 원장에서 `status: done` 으로 표시하지 않는다.**

## 2. 비타협 원칙 (전략 §2 — 코드에서 강제한다)

| # | 원칙 | 강제 수단 |
|---|---|---|
| N-1 | 자기기재(`self_declared`)는 절대 `verified` 가 될 수 없다 | `domain/proof.ts` 전이 함수 + `badges_require_verified` 트리거 |
| N-2 | 배지는 결제로 획득할 수 없다 | 배지 발급 경로에 구독·요금제 인자를 두지 않는다 (`canIssueBadge`) |
| N-3 | 단일 신뢰점수를 MVP 에 출시하지 않는다 | 점수 컬럼·정렬키 부재. 완성도는 워크스페이스 안내 전용이며 공개 DTO 제외 |
| N-4 | 공개 API 는 allowlist 필드만 반환한다 | `domain/publicDto.ts` 재구성 + `public_*_view`. 블랙리스트 금지 |
| N-5 | 증거 원본과 공개 배지 데이터는 분리 저장한다 | `evidence_files` ↔ `badges` 테이블 분리. 공개 조회에 증거 조인 없음 |
| N-6 | 검증 상태 변경은 전부 감사로그에 남는다 | `verifications` AFTER 트리거 → `audit_logs` (앱이 깜빡해도 남는다) |
| N-7 | 감사로그는 append-only | `BEFORE UPDATE OR DELETE` 트리거가 예외 발생 |
| N-8 | 측정 지표는 기간·분모·제외조건 없이 표시 불가 | `metric_claims` 4필드 `NOT NULL` + `public_metric_view` 가 걸러낸다 |
| N-9 | 만료·취소 시 공개 배지를 즉시 갱신한다 | 만료는 **읽기 시점** 판정(뷰). 배치 지연에 의존하지 않는다 |
| N-10 | 미니사이트에 사용자 JS 금지 | `domain/blockSchema.ts` allowlist + `sanitizeText()` + **`dangerouslySetInnerHTML`·`eval` 부재를 architecture.test.ts 가 강제**. 임의 HTML 저장 컬럼 없음. CSP 는 보조 겹이고 `apps/web/src/proxy.ts` 가 요청별 nonce + `'strict-dynamic'` 으로 보낸다(`next.config.ts` 아님 — 두 곳에서 보내면 교집합이 적용된다). Next 업그레이드 때마다 `node proplus/scripts/check-csp-nonce.mjs` 로 **응답 HTML 의 `<script>`** 확인 — 이력과 함정은 ADR-011 |
| N-11 | 상담처리 동의와 마케팅 동의는 분리 기록 | `consent_records.purpose` enum + 리드 생성 시 `service` 필수 / `marketing` 선택 |
| N-12 | 조직은 개인 프로필을 소유하지 않는다 | `profiles.user_id` 개인 고정. 조직은 `memberships` 로만 관여. 퇴사 시 소속 배지만 만료 |
| N-13 | 로그·이벤트에 PII 원문 금지 | `domain/redact.ts` 경유. 이벤트 payload 는 식별자만 |
| N-14 | 분쟁 중에는 확정적 비난 표현 금지 | `disputed` 의 공개 라벨은 `"확인 필요"` 상수로 고정 |
| N-15 | 유료 노출은 일반 결과와 구분하고 랭킹 근거를 공개한다 | 검색 응답에 `placement` + `rankingBasis[]` 필수, 코드는 화이트리스트 |

이 15개는 **리뷰 체크리스트**다. PR 이 하나를 건드리면 해당 단위테스트가 같이 바뀌어야 한다.

## 3. 계층 규칙 (무엇을 **못** 하는지)

| 계층 | 위치 | 할 수 있는 것 | 금지 |
|---|---|---|---|
| 라우트 | `apps/web/src/app/api/v1/**` | 입력 검증(zod), 인증, 모듈 호출, 응답 조립 | 비즈니스 분기, SQL, 권한 계산 |
| 모듈 | `services/api/src/modules/*.ts` | SQL, 트랜잭션, outbox 기록, 감사로그 | HTTP 객체(Request/Response/쿠키) 의존, 다른 모듈 테이블 쓰기 |
| 도메인 | `packages/domain/src/*.ts` | 상태머신·ACL·정책·정규화·sanitize | **모든 I/O** — fetch·fs·pg 금지, `Date.now()` 금지(`now: Date` 를 받는다) |
| UI | `apps/web/src/app/**` | 렌더링 | 권한 판단. 서버가 이미 걸러 준 것만 그린다 |

- 모듈 함수는 `Ctx`(`userId`·`ip`·`userAgent`·`requestId`)를 첫 인자로 받는다.
- `proof` 는 중앙이고 **읽기 전용 소비 대상**이다. `proof → billing` 역방향 import 는 N-2 를 구조적으로 깨뜨린다 — 금지.
- `outbox.enqueue()` 는 풀이 아니라 **트랜잭션 client** 를 받는다. 도메인 쓰기와 같은 트랜잭션이어야 한다.
- `default export` 금지, named export 만. node 내장 모듈은 `node:` 접두사. `.ts` 확장자 import 금지.
- 엄격한 TypeScript(`strict` + `noUncheckedIndexedAccess`) — 배열 인덱싱 결과는 `undefined` 일 수 있다.

## 4. LINKOS 와 섞지 않기

- **`F-xxx` 를 쓰지 않는다.** LINKOS 197개 원장의 ID 이고 의미가 다르다. PROPLUS 기능은 `P-xxx` 뿐이다
  (`N-xxx` 는 LINKOS 쪽 인적네트워크 번들 ID 이므로 기능 ID 로 쓰지 않는다 — 이 파일 §2 의 N-번호는 비타협 원칙 번호다).
- **루트 `db/migrations/` 를 건드리지 않는다.** PROPLUS 스키마는 `proplus/db/migrations/` 다. 데이터베이스도 다르다(`proplus`).
- `@linkos/*` 패키지를 import 하지 않는다. 패턴은 복사하고 결합은 만들지 않는다(ADR-009).
- 쿠키는 `pp_session` / `pp_anon`, advisory lock 은 `727275`, 포트는 `4400`.
- 루트 `package.json`·`pnpm-workspace.yaml`·루트 `scripts/` 를 PROPLUS 작업으로 수정할 때는 `proplus:*` 스크립트 추가에 한정한다.

## 5. 보안·개인정보

- 토큰: ≥128bit 랜덤(base64url), **DB 에는 SHA-256 해시만**, TTL·1회성·revoke·rate limit. 토큰에 PII 금지.
- 증거 원본: 저장 암호화 + 60초 signed URL + **다운로드마다 `audit_logs`**. 공개 경로에서 접근 불가.
- 로그·분석 이벤트: 전화·이메일·주소·증거 내용 금지 → `redact()` 경유. 응답에 stack trace 노출 금지, `correlation_id` 로 추적.
- 동의는 종류별 분리 기록(`service`/`privacy`/`marketing`/`verification`/`recording`) + `policy_version`.
- 모든 create/update API 는 `Idempotency-Key` 헤더를 지원한다.
- SQL 은 파라미터 바인딩(`$1`)만. 문자열 연결로 쿼리를 만들지 않는다(ADR-007).
- 관리자 조회·승인·export 는 접근 사유와 함께 감사로그에 남긴다.

## 6. 디자인 토큰

`proplus/apps/web/src/app/globals.css` 한 곳이 토큰의 출처다. **하드코딩 색 금지** —
`var(--bg|--bg-elev|--bg-sunk|--fg|--fg-mute|--line|--line-strong|--accent|--accent-text|--accent-soft|--verified|--pending|--caution)` 만 쓴다.
정확한 값은 `docs/CONTRACTS.md` §디자인 토큰.

- 인상: 신뢰·전문성 — 차분한 중성 배경 + 단일 강조색(딥 틸) + 검증 상태 의미색. LINKOS 의 파스텔과 **다른 인상**이어야 한다.
- 배지 상태는 **색 + 텍스트 + 아이콘**을 함께 쓴다(브랜드 §7). 색만으로 상태를 말하지 않는다.
- 다크 모드는 토큰 재정의로 지원. 접근성: 대비 AA, 포커스 링, `prefers-reduced-motion`, 아이콘 버튼 `aria-label`.
- 공개 프로필(`/p/[slug]`)은 인증 없이 SSR 로 뜨고 무거운 JS·이미지를 올리지 않는다.

## 7. 작업 방법

```bash
pnpm proplus:migrate                 # 스키마 적용
pnpm proplus:db:seed                 # 데모 프로필 /p/demo-pro (멱등)
pnpm proplus:dev                     # http://localhost:4400
pnpm proplus:typecheck && pnpm proplus:test
pnpm proplus:traceability --check    # status=done 인데 테스트 참조 없는 기능이 있으면 실패
pnpm proplus:build && node proplus/scripts/check-no-prerender.mjs   # N-9: 정적 프리렌더 금지
node proplus/scripts/check-csp-nonce.mjs http://127.0.0.1:4400/     # N-10: 서버를 띄운 뒤. Next 업그레이드 필수
node proplus/scripts/reconcile-registry.mjs --dry                   # 원장 status 를 실제 코드·테스트와 대조
```

**주의 — 주석 안에서 조기 종료되는 두 문자열.** 이 저장소에서 실제로 세 번 발생한 실수다:
- SQL 템플릿 리터럴(`` ` ``) 안의 주석에 **백틱이나 달러-중괄호**를 쓰면 문자열이 끊긴다.
- 블록 주석 안의 `**강조**/다음말` 처럼 `*` 뒤에 `/` 가 오면 **주석이 거기서 닫힌다**.

- 새 기능: 코드 상단과 테스트 이름에 기능 ID 를 적는다 — `// P-0xx: 설명`. 추적성 스크립트가 이 패턴을 수집한다.
- 주석은 **왜**를 적는다. 무엇을 하는지는 코드가 말한다. 한국어로 쓰고 문서 근거를 표기한다 — `(보안정책 §4.2)`, `(기술백서 §7)`.
- 문서가 "미결정"이라고 적은 것은 임의로 결정하지 않는다. 스키마·어댑터만 두고 TODO 에 근거를 남긴다(전략 §8).
- 푸시 전: `proplus:typecheck` · `proplus:test` · `proplus:traceability --check` 가 모두 통과해야 한다.
