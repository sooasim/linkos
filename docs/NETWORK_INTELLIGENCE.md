# 인적 네트워크 인텔리전스 — 상시 개발 지침 (N-ID)

출처: `E:\linkos\dd\AI_명함_인적네트워크_상용화_개발패키지_v3.0\AI_Business_Network_Platform_v3.0\`
(기술백서 v3.0 · SRS · 아키텍처 · GraphRAG 명세 · 추천엔진 명세 · 그래프 스키마 · 보안명세 · 화면명세 · 인수테스트)

이 문서는 그 번들에서 추출한 **상시 적용 지침**이다. `CLAUDE.md` 가 LINKOS 전체 규칙이고, 이 파일은
관계 인텔리전스(검색·관계강도·소개경로·공개판정·프로젝트 매칭) 영역의 규칙이다. 충돌 시 `CLAUDE.md` 가 우선한다.

---

## 0. 네임스페이스 — 왜 `N-ID` 인가

패키지는 자체 Feature ID(`F-001~F-305`)를 쓰지만 그 번호는 LINKOS 기능 원장(`F-001~F-197`)과
**겹치면서 의미가 다르다**. 패키지 `F-001`은 "계정/워크스페이스/역할", LINKOS `F-001`은 "회원가입/로그인"이다.

따라서 이 패키지에서 온 기능은 `N-xxx` 로 쓴다.

| 패키지 ID | 이 저장소 ID |
|---|---|
| F-001 ~ F-024 (P0) | **N-001 ~ N-024** |
| F-101 ~ F-110 (P1) | **N-101 ~ N-110** |
| F-201 ~ F-210 (P2) | **N-201 ~ N-210** |
| F-301 ~ F-305 (P3) | **N-301 ~ N-305** |

- 기능 원장(`03_FEATURE_REGISTRY.yaml`, 197개)은 **수정하지 않는다.** `feature_count: 197` 은 그대로 유지한다.
- `N-ID` 는 `scripts/traceability.mjs` 의 `NETWORK_INTEL` 맵에 기록하고 `docs/TRACEABILITY.md` 의 별도 섹션으로 생성된다 — `X-ID`(원장 외 추가기능)와 같은 방식이다.
- 코드 상단 주석과 테스트 이름에 `N-xxx` 를 표기한다. 기존 `F-xxx` 와 섞어 쓰지 않는다.
- 하나의 코드가 양쪽에 걸치면 둘 다 적는다: `// F-074 관계 강도 · N-103 9신호 확장`.

## 1. 제품 정의 (타협 불가)

이것은 명함관리 기능이 아니다. 답해야 하는 질문은 **"지금 이 사업을 추진하려면 누구/어느 회사와 연결되어야
하고, 어떤 인맥 경로가 실제로 소개가 될 가능성이 높은가?"** 다.

따라서:

1. **최단 경로를 "최적 소개 경로"라고 부르지 않는다.** hop 수가 적은 경로가 아니라 실제 소개 성공 가능성이 높은 경로를 기본 선택으로 제시한다.
2. **단일 친밀도 숫자를 관계강도로 쓰지 않는다.** 9개 신호에서 계산하고 구성요소를 항상 함께 보여준다.
3. **연결 수(인맥 몇 명)를 핵심 지표로 쓰지 않는다.** KPI 는 `활성 관계`, `접근 가능한 회사`, `프로젝트 커버리지` 다.
4. **3D 그래프를 장식용 기본 화면으로 쓰지 않는다.** List/2D/3D 는 목적에 따라 사용자가 고른다. 기본은 List.
5. **경쟁 서비스의 화면·문구·상표를 복제하지 않는다.** (`CLAUDE.md` §5 의 상표 금지 규칙과 동일하다.)

## 2. 공개 판정 — 5단계 권한 사다리 (N-022)

최대 위험은 내 주소록에 있는 제3자 정보가 당사자 의사 없이 2·3촌 사용자에게 노출되는 것이다.
**보유·탐색·신원·연락처·소개는 서로 다른 권한이다.** 하나를 통과했다고 다음이 열리지 않는다.

```
can_process → can_discover → can_request_intro → can_reveal_identity → can_reveal_contact
```

- 각 단계는 `packages/domain/src/disclosure.ts` 의 `evaluateDisclosure()` 한 곳에서만 판정한다.
- 판정 결과는 `full | masked | intro_only | hidden` 네 가지 payload 형태로 번역된다.
- `masked` 후보의 응답에는 이름·이메일·전화·회사명이 **어떤 필드에도 들어가지 않는다.** 대신 집계 라벨만 준다:
  `2촌 · 의료기기 유통 · 서울 · 소개경로 있음`
- 점수 할인으로 끝내지 않는다. 신원 공개가 금지되면 payload 자체를 masked 후보로 **변환**한다.
- 연락처 공개는 소개 승인 **이후**의 별도 게이트다. 기존 `contactsRevealed()`(소개 상태머신)와 함께 둘 다 통과해야 한다.
- `can_reveal_identity=false` 인 대상의 이름은 search / paths / graph / 로그 **어디에도** 나타나지 않는다. 인수 게이트 항목이다.

### 브라우저 금지사항

- 전체 그래프를 브라우저로 내려보내고 CSS·필터로 숨기는 방식 **금지**. 서버가 privacy-filtered slice 만 반환한다.
- masked 노드의 raw identity 가 HTML·JSON·network payload 에 존재하면 안 된다.

## 3. 관계강도 (N-103) · 감쇠 (N-104)

9개 신호에서 계산한다. 가중치는 초기 설명가능 모델이며 outcome 학습으로 재조정한다.

```
R = .18·frequency + .18·recency + .15·reciprocity + .12·meeting_depth
  + .10·deal_history + .10·tenure + .07·shared_context + .05·user_trust + .05·referral_success
```

- `recency = exp(-days / tau)`, 기본 `tau=180`. 관계 유형별로 tau 를 조정한다.
- `inferred` 전용 관계는 confidence 상한을 둔다(확인된 관계와 동급으로 올라가지 않는다).
- 사용자가 관계를 수정하면 audit 를 남기고 feature 를 재계산한다.
- 기존 `computeStrength()`(F-074, 6신호)는 **지우지 않는다.** 9신호 모델이 그것을 흡수해 쓴다.
- 휴면 관계는 decay 가 적용되고 설명에 stale 신호가 표시되어야 한다.

## 4. 소개 엣지 품질과 경로 비용 (N-105)

```
E = R × shareability × availability × context_fit × consent_gate
```

- `consent_gate = 0` 이면 그 엣지로 **공개·소개 action 을 생성하지 않는다.** 경로 계산 내부 feature 로도 최소화한다.
- 곱셈 항이 많아 과도하게 0 으로 수축하므로 각 factor 에 floor/calibration 을 적용한 값을 쓴다.

```
PathCost = Σ[-ln(max(ε, E))]
         + 0.22·hopPenalty + 0.18·dormancyPenalty + 0.20·privacyPenalty + 0.15·conflictPenalty
         - 0.25·sharedContextBonus
```

- **최소 3개의 대안 경로**를 비교 가능하게 반환한다. 단일 최단경로만 주는 API 는 미완성이다.
- 같은 소개자·같은 회사만 반복되지 않도록 introducer/company/edge overlap penalty 로 경로 다양성을 적용한다.
- 그래프는 후보 UUID/경로 UUID만 만든다. 최종 순위와 공개 판정은 canonical DB 쪽 deterministic 서비스가 한다.

## 5. 추천 점수 (N-016) 와 근거 (N-108)

```
S = .25·intentFit + .18·capabilityFit + .16·pathQuality + .12·relationshipStrength
  + .08·industryFit + .07·evidenceQuality + .05·recency + .04·geo
  + .03·dealHistory + .02·userPreference
```

- **Hard gate 가 점수보다 먼저다.** 소유권/차단/삭제 → 동의·공개권한 → 필수조건(must-have) → 최소 confidence. 점수로 하드 조건을 상쇄하지 않는다.
- 추천 응답의 표준 필드: `score`, `scoreComponents`, `evidence[]`, `paths[]`, `disclosure`, `nextActions`.
- **모든 추천 이유는 실재하는 `evidenceId` 에 연결되어야 한다.** "최근 6개월 3회 미팅" 같은 문장은 Interaction/Evidence 질의로 재현 가능해야 한다. 재현 불가능한 이유는 표시하지 않는다.
- 다양성: candidate MMR `λ=0.82` 로 시작.
- 민감 속성(`SENSITIVE_CATEGORIES`)은 추천 feature 로 쓰지 않는다. 기존 `sanitizeMatchProfile()` 을 통과시킨다.

## 6. 학습 라벨 (N-303 준비)

CTR 보다 아래 funnel 을 우선한다.
`intro_requested → intro_approved → introduced → meeting_held → qualified → won/lost`
부정 라벨: `wrong_relationship`, `not_relevant`, `privacy_blocked`.

**개인정보 정책은 A/B 실험 변수로 완화하지 않는다.**

## 7. LLM 경계 (GraphRAG)

LLM 은 이해·생성 계층이고 권한·사실·경로·점수의 최종 결정권자가 **아니다.** 모든 AI 출력은 `proposal`
또는 `explanation` 이며 canonical commit 은 deterministic 서비스가 한다.

| 컴포넌트 | 허용 | 최종권한 |
|---|---|---|
| IntentParser | 자연어 → SearchIntent JSON | 없음 |
| EntityExtractor | OCR/문서 → 필드 후보 | 없음 |
| QueryPlanner | SearchIntent → retriever plan | 없음 |
| ProjectDecomposer | 프로젝트 텍스트 → Role/Need 초안 | 없음 |
| EvidenceSynthesizer | candidate+evidence → 추천 설명 | 없음 |
| IntroWriter | 목적/관계/톤 → 소개 초안 | 자동전송 금지 |

LLM 금지: identity 확정, 동의·공개권한 판정, path score 계산, 자동 메시지 발송, 근거 없는 관계 생성.

### Hallucination guard (필수)

- canonical ID 없는 사람·회사를 추천 결과로 만들 수 없다. 응답 직전에 ID 존재를 검증한다.
- `evidenceId` 없는 relationship claim 은 `추정` 으로 표시하거나 제거한다.
- output schema validation 실패 시 retry → 실패하면 deterministic fallback. LLM 실패가 기능 실패가 되면 안 된다.
- 프롬프트에는 canonical ID, 공개 가능한 profile snapshot, score component, path summary, evidence 발췌만 넣는다.
  **소개 승인 전에 전화·이메일 원문을 프롬프트로 보내지 않는다.**

## 8. 그래프 / 벡터 어댑터

사용자 결정(2026-10-13): **어댑터 인터페이스만 둔다. Postgres 확장을 새로 도입하지 않는다.**

- `GraphRepository` 인터페이스 뒤에 기본 구현은 순수 SQL + 결정적 인메모리 알고리즘이다.
- `VectorIndex` 인터페이스 뒤에 기본 구현은 결정적 어휘 유사도(`textSimilarity`)다.
- Apache AGE / Neo4j / Qdrant / pgvector 임베딩 워커는 **나중에 끼우는 어댑터**다. 지금 설치·요구하지 않는다.
- 어느 어댑터를 쓰든: 동일 canonical UUID, 동일 edge semantics, 동일 fixture 에서 같은 reachable set.
- **그래프/벡터는 원본이 아니다.** PostgreSQL 이 유일한 canonical source이고 projection 은 언제든 재구축 가능해야 한다.
- 재구축은 `outbox_events` 리플레이로 한다. 쓰기와 같은 트랜잭션에서 outbox 에 기록하고 consumer 는 idempotent 해야 한다(`CLAUDE.md` §3 와 동일).
- graph property 에 전화·이메일·비공개 메모·동의 원문을 저장하지 않는다.

### 레이아웃도 서버가 계산한다

2D·3D 좌표는 `forceLayout()` / `forceLayout3D()` 로 **서버에서** 결정적으로 계산해 내려보낸다. 브라우저는 그릴
것만 받는다 — 이것이 §2 의 "전체 그래프를 내려보내고 숨기지 않는다"를 구조적으로 보장한다.

3D 렌더링에 `three` / `react-force-graph` 를 넣지 않는다. 500 노드 상한에서는 canvas 2D 원근 투영으로 충분하고,
1MB+ 번들과 WebGL 가용성 문제를 안고 갈 이유가 없다. 3D 뷰어를 교체하려면 `Network3D.tsx` 하나만 바꾸면 된다.

## 8.1 백그라운드 작업 (`modules/netintelJobs.ts`)

`pnpm worker` 의 tick 에서 호출된다. 모두 **idempotent** 해야 한다(at-least-once 소비).

| 작업 | 주기 | 하는 일 |
|---|---|---|
| `recomputeContactEdges` | 엣지별 1일 | 연락처끼리의 9신호 강도 + EdgeQuality factor 재계산. **점수가 0.01 이상 움직였을 때만** 신호 샘플과 이벤트를 남긴다 |
| `processSavedSearchAlerts` | 사용자 설정(일/주/월) | 저장된 검색 재실행 → **새로 생긴 후보만** 알림. 본문에 후보 이름을 넣지 않는다 |
| `scanDataQuality` | 매 tick(멱등) | 중복 연락처·끝난 소속·공유범위 미설정·projection 지연·실패 outbox·임베딩 적체를 큐에 담고, 고쳐진 항목은 자동으로 닫는다 |
| `consumeNetworkEvent` | outbox relay | `network.*` 이벤트 소비. 공유범위가 `none` 으로 바뀌면 열린 기회를 보류한다 |

**매 tick 전체 재계산 금지.** 반드시 `strength_computed_at` 같은 스로틀 컬럼으로 대상을 좁힌다 —
tick 간격이 2초이므로 스로틀이 없으면 쓰기가 폭증한다(`relationships.strength_computed_at` 과 같은 패턴).

## 8.2 더미 데이터 (`db/seeds/netintel.ts`)

`pnpm db:seed` 로 들어간다. 빈 DB 에서도 모든 화면이 의미 있는 상태로 보이는 것이 목적이고, 특히 아래를
**눈으로 확인할 수 있어야** 한다. 시드를 고칠 때 이 성질을 깨지 말 것 (통합테스트가 지킨다).

- 하노이 법인장은 **동료 소유** 연락처 + `path_only` → 끝까지 masked 로만 보인다(이름·회사·연락처 없음).
- 그 대상으로 가는 경로가 3개 이상이고 소개자가 서로 다르다 → S16 비교 화면이 비교할 것이 있다.
- 확정된 프로젝트에는 covered/partial/gap 이 모두 나타나고, 두 번째 프로젝트는 검토 대기 상태다.
- 탐색을 거부한 연락처 하나가 있어 어떤 응답에도 나타나지 않는다.
- 중복 연락처와 끝난 소속을 **일부러** 하나씩 남겨 데이터 품질 워커가 실제로 잡아낸다.
- 실제 개인정보 없음 — 모든 주소는 `@example.test` 다. 고정 UUID + `ON CONFLICT`/`NOT EXISTS` 로 멱등하다.

## 9. 테넌시 — 패키지 DDL 을 그대로 쓰지 말 것

패키지는 `workspace_id` + PostgreSQL RLS 를 전제한다. LINKOS 는 **`owner_user_id` 소유권 + `organizations`/`organization_members`** 다.

- 신규 테이블은 LINKOS 방식을 따른다: 개인 자산은 `owner_user_id`, 조직 자산은 `organization_id`.
- `SET LOCAL app.workspace_id` / `CREATE POLICY tenant_isolation` 을 도입하지 않는다.
- 조직 공유는 다른 소유자의 row 를 직접 조회하는 방식이 아니라 동의 기반 서비스 경로로만 한다(opt-in 확인 필수).
- 교차 소유자 조회는 `organization_members` 멤버십과 공유 opt-in 을 **둘 다** 확인한다.

## 10. 엔터티 구분 (패키지 §5 + `CLAUDE.md` §2.5)

`Contact ≠ BusinessCard ≠ Encounter ≠ Relationship` 에 더해:

`Person · Company · Role · Organization · Industry · Capability · Need · Project · Opportunity · Evidence`
는 각각 별도 엔터티다. Capability(제공 가능한 것)와 Need(필요한 것)를 한 테이블에 섞지 않는다.
Organization(협회·챕터·동문)은 Company(법인)와 다른 엔터티다.

주요 관계: `KNOWS, WORKS_AT, WORKED_AT, MEMBER_OF, MET_AT, INTRODUCED, REFERRED, PROVIDES, NEEDS,
SUPPLIES, PURCHASES_FROM, PARTICIPATES_IN, DECIDES_FOR`

## 11. 프로젝트 커버리지 (N-018 / N-019)

- 프로젝트 설명 → Role/Need 로 분해하고, 분해 결과는 **초안**이다. 사용자 검토 후 요구사항으로 확정한다.
- 각 요구사항은 `covered / partial / gap` 으로 계산한다. 셋 다 근거를 가진다.
- Gap 은 외부 공개 데이터를 무단 결합해 채우지 않는다. 사용자 승인에 따라 파트너 모집·회원 검색·계약된 provider adapter 로만 확장한다.

## 12. 기회 엔진 (N-021) · 스팸 방지

- A 의 Need 와 B 의 Capability 가 의미적으로 맞고, 연결경로가 있고, 개인정보·스팸 정책을 만족하면 Potential Opportunity 를 만든다.
- **자동으로 상대에게 발송하지 않는다.** 기본값은 초안이다(`CLAUDE.md` §2.8 과 동일).
- rate limit: 소개 요청 횟수 제한, 반복 거절 대상·조직에 cooldown, relevance threshold, 소개자 reputation.
- 대량 outreach 는 별도 권한과 정책이 필요한 기능으로 취급한다. 대량 액션은 export/tag 수준만 허용한다.

## 13. UI 규칙

`CLAUDE.md` §5 디자인 시스템을 그대로 따르고(하드코딩 색 금지, 토큰만) 추가로:

- 핵심 CTA 는 `검색` · `명함 스캔` · `소개 요청` 세 개로 제한한다.
- 점수를 숫자만 보여주지 않는다. 항상 구성요소 + evidence 를 함께 본다. Evidence Drawer 에서 원천·날짜·confidence·추론여부를 확인할 수 있어야 한다.
- `inferred` 사실은 점선/AI 배지로 확정 사실과 구분한다(`AiLabel` 사용).
- 데이터 타입을 **색만으로** 구분하지 않는다. shape/label 을 병행한다(2D/3D 그래프 포함).
- 3D 는 기본 최대 500 visible nodes. camera auto-fly 는 멀미를 고려해 최소화한다. 3천+ 노드는 서버에서 community aggregation.
- masked 노드는 이름 대신 역할/회사 카테고리만 표시한다.
- 조건 chip 을 사용자가 수정하면 재검색된다(파싱된 intent 는 읽기전용이 아니다).
- 모든 화면에 empty/error/loading 상태가 있어야 한다(아래 DoD).

## 14. 성능 SLO

| 항목 | 목표 |
|---|---|
| Search Top-20 (≤3 hop) | P95 1.2s |
| Graph slice (≤300 nodes) | P95 1.5s |
| 게스트 랜딩 LCP p75 | < 2.5s (`CLAUDE.md` §5) |

- cursor pagination 만 쓴다. 대규모 그래프·검색에서 offset pagination 금지.
- 벤치마크는 1M person / 5M relationship 합성 데이터로, warm/cold cache 를 분리 보고한다.

## 15. Definition of Done

**API 가 응답하는 것만으로 기능은 완료가 아니다.** 아래가 전부 있어야 `docs/TRACEABILITY.md` 에서 구현 상태를 올린다.

1. 마이그레이션 (forward + 롤백 경로)
2. 권한(authorization) 테스트
3. privacy masking 스냅샷 테스트
4. audit 이벤트
5. observability 지표
6. 실패 처리 (재시도·폴백)
7. UI empty / error / loading 상태
8. 문서
9. rollback / projection 재구축 절차

## 16. 인수 게이트 (릴리스 차단 조건)

- **Privacy**: 2촌 masked 대상의 이름·이메일·전화가 API response / graph payload / 로그에 **존재하지 않음**.
- **Tenant**: 다른 소유자의 entity UUID 를 직접 조회해도 정보 노출 0.
- **Search**: 필수 hard filter 가 rank score 보다 우선.
- **Top-K path**: 동일 fixture 에서 최단경로 외 대안 경로 최소 3개 생성.
- **Consent gate**: `can_reveal_identity=false` 대상의 이름이 어떤 API 에도 나타나지 않음.
- **Evidence**: 추천 top reason 100% 가 실재하는 evidenceId/feature 에 연결.
- **LLM**: canonical ID 없는 가상 인물·회사가 추천 payload 에 들어갈 수 없음.
- **Relationship strength**: frequency/recency/reciprocity 변화가 기대 방향으로 점수에 반영.
- **Decay**: 휴면 관계에 time decay 적용 + 설명에 stale 신호 표시.
- **Outbox**: projection worker 재시도 후 canonical state 와 수렴.
- **Delete**: 삭제 후 projection·object 에서 SLA 내 제거.
- **Browser privacy**: masked 노드 raw identity 가 HTML/JSON/network payload 에 없음.

## 17. 법무·라이선스

- 오픈소스 채택표(`references/OPEN_SOURCE_MATRIX.md`)는 **법률의견이 아니다.** 배포 전 실제 artifact 의 LICENSE/NOTICE, SaaS/network-copyleft 조건, transitive dependency, 모델 weights, 외부 데이터 약관을 SBOM 과 함께 검토한다.
- Neo4j Community 는 GPLv3, Twenty/Monica 는 AGPL 계열이다 — 벤치마크 대상이며 코드 차용 대상이 아니다.
- 외부 people intelligence provider 는 **계약된 provider 만** 사용한다(N-304). 공개 데이터 무단 스크래핑으로 gap 을 채우지 않는다.
- 출시국 개인정보법·처리방침·제3자 제공/위탁·국외이전·DPIA 는 법률 검토 대상이다.
