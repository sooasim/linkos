# PROPLUS 개발 전략

출처: `dd/PROPLUS_Technical_Document_Set/` (통합기획서·기술백서·모듈명세·데이터모델·보안정책·오픈소스검토·로드맵·브랜드가이드)
작성 2026-10-22 | 운영 주소 **https://proplus.linkos.com**

---

## 0. 한 줄 요약

> **PROPLUS 의 차별화는 미니홈페이지가 아니라 Proof Engine 이다.**
> 그래서 이 저장소는 "프로필 빌더 + 검증 붙이기" 순서가 아니라
> **증거·검증·배지·감사로그를 먼저 못 박고, 프로필·상담·상거래를 그 위에 얹는** 순서로 구현한다.

---

## 1. 왜 `proplus/` 를 LINKOS 와 분리하는가

같은 저장소에 두면서도 **코드·DB·기능원장·배포를 완전히 분리**한다.

| | LINKOS | PROPLUS |
|---|---|---|
| 제품 질문 | "방금 만난 사람을 어떻게 놓치지 않을까" | "믿고 거래할 사람을 어떻게 찾을까" |
| 중심 엔터티 | Encounter / Relationship | Evidence / Verification / Badge |
| 비회원 경로 | 교환이 가입보다 먼저 (`/x/[token]`) | 공개 프로필이 가입보다 먼저 (`/p/[slug]`) |
| 기능원장 | `dd/.../03_FEATURE_REGISTRY.yaml` **F-0xx** (197개) | `proplus/docs/01_FEATURE_REGISTRY.yaml` **P-0xx** |
| DB | `linkos` | `proplus` (별도 데이터베이스) |
| 주소 | linkos.ckp.kr | proplus.linkos.com |
| 포트 | 4300 | 4400 |

**분리 근거 3가지**

1. **기능 ID 충돌 금지.** 루트 `CLAUDE.md` §1 은 LINKOS 197개 F-ID 를 삭제·통합·이름변경 금지로 묶는다.
   PROPLUS 기능을 F- 번호로 끼워 넣으면 그 원장이 오염된다. `N-xxx`(인적네트워크 번들)가 이미 쓰는 전례와 같은 이유로 **`P-xxx`** 를 쓴다.
2. **신뢰 모델이 반대 방향이다.** LINKOS 는 "관계 강도를 추정"하고, PROPLUS 는 "추정을 금지"한다
   (자기기재는 배지 불가 — 보안정책 §4.2). 한 도메인 패키지에 두 철학을 섞으면 둘 다 약해진다.
3. **배포 격리.** 검증 콘솔·증거 원본 스토리지는 LINKOS 와 다른 신뢰 경계다. 프로세스·DB·버킷·감사로그를 공유하지 않는다.

**공유하는 것:** pnpm 워크스페이스, TypeScript 설정 베이스, Playwright 러너, CI 러너, 배포 서버(ckp), 검증된 코드 *패턴*.
**공유하지 않는 것:** 데이터베이스, 도메인 패키지, 세션 쿠키, 스토리지 버킷, 감사로그, 기능원장, 환경변수 파일.

---

## 2. 비타협 원칙 (코드에서 강제한다)

문서 세트에서 "지키자"로 적힌 것 중 **코드로 막지 않으면 반드시 깨지는 것**만 뽑았다.
각 항목은 `proplus/packages/domain` 의 순수 함수 + 단위테스트, 또는 DB 제약으로 강제한다.

| # | 원칙 | 출처 | 강제 수단 |
|---|---|---|---|
| **N-1** | 자기기재(`self_declared`)는 절대 `verified` 가 될 수 없다 | 보안정책 §4.2 | `proof.ts` 전이 함수 + DB `CHECK` 제약 |
| **N-2** | 배지는 결제로 획득할 수 없다 | 보안정책 §4.10 | 배지 발급 경로에 구독 상태 입력 자체를 두지 않음 + 테스트 |
| **N-3** | 단일 신뢰점수를 MVP 에 출시하지 않는다 | ADR-003 / 기획서 §13 | 점수 필드·정렬키 부재. "완성도"는 `profile_completeness`(보조 안내)로만 존재하고 공개 DTO 에서 제외 |
| **N-4** | 공개 API 는 allowlist 필드만 반환한다 | ADR-002 / 데이터모델 §3 | `publicDto.ts` — 화이트리스트 밖 키는 **런타임에 삭제**. 블랙리스트 금지 |
| **N-5** | 증거 원본과 공개 배지 데이터는 분리 저장한다 | ADR-004 | `evidence_files`(암호화·signed URL) ↔ `badges`(공개 라벨) 테이블 분리. 공개 조회 경로에 `evidence_files` 조인 없음 |
| **N-6** | 검증 상태 변경은 전부 감사로그에 남는다 | 모듈명세 M04 | `verifications` AFTER 트리거 → `audit_logs`. 애플리케이션이 깜빡해도 남는다 |
| **N-7** | 감사로그는 append-only | 데이터모델 §1 | `BEFORE UPDATE OR DELETE` 트리거가 예외 발생 |
| **N-8** | 측정 지표는 기간·분모·제외조건 없이 표시 불가 | 보안정책 §4.8 / 브랜드 §5 | `metric_claims` 의 `period_start/period_end/sample_size/basis` 를 `NOT NULL`. 공개 렌더러가 하나라도 없으면 숨김 |
| **N-9** | 만료·취소 시 공개 배지를 즉시 갱신한다 | 보안정책 §4.5 | 공개 조회가 `status='active' AND (expires_at IS NULL OR expires_at > now())` 를 **DB 뷰**로 강제. 배치 지연에 의존하지 않음 |
| **N-10** | 미니사이트에 사용자 JS 금지 | 모듈명세 M03 | 블록 schema allowlist(zod) + HTML sanitizer + CSP. 임의 HTML 문자열 저장 경로 없음 |
| **N-11** | 상담처리 동의와 마케팅 동의는 분리 기록 | 모듈명세 M07 / 보안정책 §3 | `consent_records.purpose` enum 분리 + 리드 생성 시 `service` 동의 필수, `marketing` 은 선택 |
| **N-12** | 조직은 개인 프로필을 소유하지 않는다 | 모듈명세 M05 | `profiles.user_id` 는 개인 고정. 조직은 `memberships` 로만 관여. 퇴사 시 소속 배지만 만료 |
| **N-13** | 로그·이벤트에 PII 원문 금지 | 보안정책 §3 / 기술백서 §7 | `redact()` 경유 + 이벤트 payload 는 식별자만 |
| **N-14** | 분쟁 중에는 확정적 비난 표현 금지 | 보안정책 §4.7 | 상태 `disputed` 의 공개 라벨은 "확인 필요"로 고정. 라벨 문자열이 코드 상수 |
| **N-15** | 광고/유료 노출은 일반 검색결과와 구분하고 랭킹 근거를 공개한다 | 모듈명세 M11 / 브랜드 §3 | 검색 응답에 `placement: 'organic'\|'promoted'` + `rankingBasis[]` 필수 |

> 이 15개는 **리뷰 체크리스트**다. PR 이 이 중 하나를 건드리면 해당 단위테스트가 같이 바뀌어야 한다.

---

## 3. 아키텍처

기술백서 §2 의 권고를 그대로 따른다 — **모듈형 모놀리스 + 비동기 작업 큐**.
LINKOS 에서 이미 운영 중인 배치(Next.js standalone 하나가 화면과 `/api/v1/*` 를 모두 서비스 + 별도 워커)를 재사용한다.
새로 발명하지 않는 이유: 같은 서버·같은 Postgres·같은 배포 스크립트 형태로 운영 부담이 늘지 않는다.

```
proplus/
  apps/web/              @proplus/web      Next.js 16 — 공개 프로필 / 워크스페이스 / 관리자 콘솔 / api/v1
  packages/domain/       @proplus/domain   순수 도메인 (I/O 금지, 단위테스트 필수)
  services/api/          @proplus/api      모듈 계층 + db/storage/mail + migrate + worker
  db/migrations/         SQL (proplus 데이터베이스 전용)
  docs/                  전략 · 기능원장 · ADR · 배포 런북 · 추적성
  infra/                 nginx vhost · systemd unit · 배포 스크립트
```

### 계층 규칙

| 계층 | 위치 | 할 수 있는 것 | 금지 |
|---|---|---|---|
| 라우트 | `apps/web/src/app/api/v1/**` | 입력 검증, 인증, 모듈 호출 | 비즈니스 분기, SQL |
| 모듈 | `services/api/src/modules/*.ts` | SQL, 트랜잭션, outbox 기록 | HTTP 객체 의존 |
| 도메인 | `packages/domain/src/*.ts` | 상태머신·ACL·정책·정규화 | **모든 I/O** (fetch·fs·pg·Date.now 주입받기) |
| UI | `apps/web/src/app/**` | 렌더링 | 권한 판단 (서버가 이미 걸러준 것만 그린다) |

### 모듈 경계 (기술백서 §2 그림과 1:1)

```
identity   인증·세션·MFA·동의기록        (M01)
profile    프로필·미니사이트·버전        (M02, M03)
proof      증거·검증·배지·이의제기·만료  (M04)   ← 핵심
org        조직·도메인검증·소속          (M05)
catalog    상품/서비스 카드              (M06)
lead       상담요청·CRM 파이프라인       (M07)
booking    예약                          (M08)
analytics  조회·CTA·전환 집계            (M09)
billing    요금제·구독                   (M10)
search     전문가 검색                   (M11)
admin      검증큐·신고·감사·정책         (M12)
```

### 왜 Proof 가 중앙인가

`proof` 외의 모든 모듈은 `proof` 의 **읽기 전용 소비자**다. 반대 방향 의존(proof 가 billing 을 읽는 것)은
N-2(배지 유료 구매 금지)를 구조적으로 깨뜨리므로 import 방향을 고정한다.

```
identity ─┐
profile  ─┤
org      ─┼─→ proof (읽기)        proof ─→ identity (actor 확인) 만 허용
catalog  ─┤
search   ─┘
```

---

## 4. 데이터 전략

### 4.1 공개/비공개 경계가 **스키마 수준**에 있다

데이터모델 §3 의 공개/비공개 목록을 주석이 아니라 **테이블 분리**로 표현한다.

| 성격 | 테이블 | 접근 |
|---|---|---|
| 공개 가능 | `profiles`, `profile_blocks`, `badges`, `offers`, `metric_claims` | 공개 조회 경로가 직접 읽음 (DTO allowlist 통과) |
| 내부 검증 | `evidence`, `verifications`, `verification_notes` | 본인 + 권한 있는 검증자만 |
| 증거 원본 | `evidence_files` | signed URL(단기), 다운로드마다 감사로그 |
| 고객 PII | `leads`, `lead_contacts`(암호화), `consent_records` | 담당자 + 승인된 관리자만 |
| 불변 기록 | `audit_logs` | append-only, 앱 롤에 UPDATE/DELETE 권한 없음 |

공개 프로필 조회는 **단 하나의 뷰** `public_profile_view` 를 거친다. 뷰에 없는 컬럼은 공개될 길이 없다.

### 4.2 검증 상태 머신 (M04)

```
                    ┌──────────────── needs_more_info ──┐
                    ↓                                   │
submitted → under_review → verified → expired           │
                    │          │                        │
                    │          └→ revoked               │
                    └→ rejected                         │
                                                        │
verified/rejected ──→ disputed ──→ (재심) ──→ verified|rejected
```

- 모든 전이는 `canTransition(from, to, by)` 를 통과해야 한다 — 역할(`owner`/`reviewer`/`system`)별 허용 전이가 다르다.
- `verified` 진입 조건에 **검증 강도** 게이트가 있다: `method !== 'self_declared'`.
- `expired` 는 시간 기반이므로 **워커가 아니라 읽기 시점**에 결정된다(N-9). 워커는 알림만 보낸다.

### 4.3 검증 강도 4단계 (보안정책 §4.1)

| 강도 | 의미 | 배지 발급 | 공개 표기 |
|---|---|---|---|
| `self_declared` | 사용자 기재 | **불가** | "자기기재" |
| `document_reviewed` | 운영자가 서류 확인 | 가능 | "서류 확인" |
| `issuer_confirmed` | 발급기관 확인 | 가능 | "발급기관 확인" |
| `system_integrated` | 시스템 연동 데이터 | 가능 | "시스템 연동" |

공개 배지는 `(라벨, 강도, 범위, 검증일, 만료일, 발급기관)` 6개를 **항상 함께** 내보낸다. 하나라도 비면 배지를 숨긴다.

### 4.4 이벤트

기술백서 §7 의 이벤트를 `packages/domain/src/events.ts` 에 그대로 둔다.
`profile.published` · `evidence.submitted` · `verification.completed` · `verification.expired` ·
`lead.created` · `appointment.booked` · `product.updated` · `transaction.verified` · `membership.revoked`

모든 이벤트에 `event_id, occurred_at, tenant_id, actor_id, aggregate_id, schema_version, correlation_id`.
외부 연동을 유발하는 쓰기는 **같은 트랜잭션에서** `outbox_events` 에 기록하고 워커가 idempotent 하게 처리한다.

---

## 5. 구현 순서 (로드맵 §1 을 코드 단위로 번역)

문서의 Phase 0(인터뷰·법률검토)은 코드가 아니므로 제외하고, **Phase 1~5 를 저장소에서 수행 가능한 단위**로 쪼갰다.

### Stage A — Foundation (P0)

워크스페이스·DB·인증·공개 프로필. 이것이 끝나면 `/p/{slug}` 가 실제로 뜬다.

- `P-180` 워크스페이스 스캐폴드 · `P-181` 마이그레이션 러너 · `P-182` 헬스체크
- `P-001`~`P-012` Identity (세션·MFA옵션·동의기록·세션 전체 무효화)
- `P-020`~`P-032` Profile + `public_profile_view` + DTO allowlist
- `P-190` 배포 파이프라인 (nginx vhost · systemd · 배포 스크립트)

**게이트:** 공개 프로필 응답에 allowlist 밖 필드가 하나도 없음을 테스트가 증명한다.

### Stage B — Proof MVP (P0, 핵심)

- `P-050`~`P-069` 증거 제출 → 검토 큐 → 배지 발급/만료/취소 → 이의제기
- `P-160`~`P-174` 관리자 검증 콘솔 · 감사로그 · 신고
- `P-070`~`P-082` 조직·도메인 검증·소속 (소속 배지는 조직 승인 기반)

**게이트:** 상태 전이 표 전수 테스트 통과 + N-1·N-5·N-6·N-7·N-9 테스트 통과.

### Stage C — Lead & Conversion (P0)

- `P-100`~`P-114` 상담 폼 → 리드 inbox → 단계·메모·알림
- `P-130`~`P-139` 조회·CTA·전환 집계 + UTM
- `P-035` QR / vCard / 공유 링크

**게이트:** 동의 분리(N-11) + 리드 조회 권한(IDOR) 테스트 통과.

### Stage D — Commercialization (P1)

- `P-040`~`P-049` 템플릿·블록 편집 (sanitizer·CSP·schema allowlist)
- `P-090`~`P-099` 카탈로그 · `P-120`~`P-129` 예약 · `P-140`~`P-149` 요금제

### Stage E — Scale (P2)

- `P-150`~`P-159` 검색 (어댑터 인터페이스만 두고 Meilisearch 는 선택 설치)
- 발급기관 API · 거래 이벤트 연동 · 다국어 · 사용자 도메인

> **이번 커밋이 다루는 범위:** Stage A 전체 + Stage B 전체 + Stage C 핵심.
> Stage D·E 는 스키마와 어댑터 인터페이스만 두고 구현은 비워 둔다 (아래 §8).

---

## 6. 기술 선택과 그 근거

기술백서 §4 의 권장표에서 **하나를 골라 고정**한다 (문서가 "하나만 선택"을 요구한 항목들).

| 영역 | 선택 | 근거 |
|---|---|---|
| Web + API | **Next.js 16 server layer 단일** | 백서 §4 "하나를 기준으로 선택, 중복 서버 방지". NestJS 를 추가하면 프로세스가 둘이 되고 LINKOS 배포 스크립트를 재사용할 수 없다 |
| ORM | **없음 — `pg` + 직접 SQL** | Prisma/Drizzle 중 하나를 고르라는 요구는 "둘을 섞지 말라"는 뜻. LINKOS 가 19개 마이그레이션을 직접 SQL 로 운영 중이고, 공개/비공개 경계를 **뷰와 트리거**로 강제하는 설계는 ORM 추상화보다 생SQL 이 명확하다 |
| UI | **Tailwind v4 + 중앙 토큰** | 백서 §4. 토큰은 `proplus/apps/web/src/app/globals.css` 한 곳 |
| 검증 | **zod** | 라우트 입력 스키마 |
| Queue | **Postgres `outbox_events` + 워커 폴링** | Redis 를 추가하지 않는다. 백서 §7 이 요구하는 것은 "같은 트랜잭션 기록 + idempotent 소비"이고 그건 DB 테이블로 충분하다. 병목이 확인되면 그때 BullMQ |
| Files | **로컬 드라이버 / S3 호환 교체 가능** | `storage.ts` 어댑터. 증거 원본은 암호화 + 단기 signed URL |
| Search | **어댑터 인터페이스 + Postgres 폴백** | Meilisearch 라이선스 실사 전에는 설치하지 않는다 (오픈소스검토 §4 체크리스트 미완) |
| Auth | **자체 세션(httpOnly·회전) + OIDC 훅** | MFA·세션 회수·rate limit 요구를 직접 만족시킨다 |
| Commerce | **제한형 자체 카탈로그** | Medusa 는 "실제 주문까지 필요한 경우에만 POC"(오픈소스검토 §3). 지금은 결제·정산 요건 미확정(미결정 §2) |
| Builder | **블록 schema allowlist 자체 구현** | GrapesJS 는 임의 HTML/JS 를 전제로 하므로 N-10 과 충돌. 블록 모델만 차용 |

### 오픈소스: 지금 설치하지 않는 것과 그 이유

오픈소스검토 §4 의 체크리스트(현재 LICENSE·SPDX·커밋 해시 고정·CVE·의존성 스캔·SBOM·법률검토 기록)가
**하나도 완료되지 않았으므로** 이번 구현은 외부 프로젝트를 코드에 넣지 않는다.
대신 **교체 지점을 어댑터로 비워 둔다** — 실사가 끝나면 어댑터 구현만 추가하면 된다.

| 후보 | 어댑터 위치 | 실사 전 폴백 |
|---|---|---|
| Meilisearch | `services/api/src/lib/searchIndex.ts` | Postgres `tsvector` + trigram |
| Umami | `services/api/src/modules/analytics.ts` | 자체 `analytics_events` 집계 |
| Cal.com | `services/api/src/modules/booking.ts` | 자체 슬롯 테이블 |
| Chatwoot | `outbox_events` 소비자 | 리드 inbox |
| walt.id / EAS | `packages/domain/src/credential.ts` | 내부 발급 배지만 |
| Medusa | `services/api/src/modules/catalog.ts` | 외부 링크형 상품 카드 |

> 오픈소스검토 §5 의 권고를 그대로 지킨다: **"검증 배지의 신뢰 정책을 외부 프로젝트에 맡기지 않는다."**

---

## 7. 보안 구현 매핑 (보안정책 §2 위협 → 코드)

| 위협 | 통제 위치 |
|---|---|
| 계정 탈취 | `modules/identity.ts` — rate limit, 세션 전체 무효화, 로그인 이력 |
| 가짜 자격/재직 | `domain/proof.ts` 강도 게이트 + `modules/org.ts` 도메인 검증(DNS TXT) |
| 관리자 오남용 | `modules/admin.ts` — 최소권한 역할, 모든 조회/승인 감사로그, 접근 사유 필수 |
| 증빙 파일 유출 | `lib/storage.ts` — 저장 암호화, 60초 signed URL, 다운로드마다 `audit_logs` |
| 프로필 XSS | `domain/blockSchema.ts` allowlist + `sanitizeText()` + `next.config.ts` CSP |
| IDOR / 테넌트 침범 | 모든 조회에 `tenantScope()` 강제 + 자동화 테스트 |
| 가짜 거래 수치 | `metric_claims` 는 `system_integrated` 증거 없이 생성 불가 |
| 스팸 리드 | 공개 폼 rate limit + 동의 필수 + 보존기간 |
| 검색 인덱스 PII | 인덱싱 입력이 `public_profile_view` 뿐 |
| 공급망 | lockfile 고정 + `pnpm audit` CI + SBOM |

### 로그 정책

구조화 로그 + trace ID. **전화·이메일·주소·증거 파일 내용은 로그에 들어가지 않는다** — `redact()` 경유.
`correlation_id` 로 요청을 추적하고 내부 stack trace 는 응답에 노출하지 않는다.

---

## 8. 이번 구현에서 **의도적으로 비워 둔 것**

문서가 "미결정"이라고 명시한 것을 임의로 결정하지 않는다. 각 항목은 스키마·인터페이스만 두고 TODO 주석으로 근거를 남긴다.

| 비워 둔 것 | 근거 문서 | 코드 상태 |
|---|---|---|
| 실제 결제·정산·환불 | 미결정 §2, 기획서 §13 | `plans`/`subscriptions` 테이블 + 요금제 한도 체크만. PG 연동 없음 |
| 본인인증·자격검증 사업자 연동 | 미결정 §2 | `verification.method='issuer_confirmed'` 경로는 있고, 외부 호출 자리는 어댑터 |
| 거래 실적 데이터 제공원 | 미결정 §2 | `metric_claims` + `transaction.verified` 이벤트 소비자 자리만 |
| 복수 프로필 허용 여부 | 데이터모델 §7-1 | 스키마는 1:N, **UNIQUE 제약으로 1개로 제한**. 제약만 풀면 열린다 |
| 증거 원본 보관 범위 | 데이터모델 §7-2 | 보존기간 컬럼 + 삭제 작업 틀. 기본값은 "검증 완료 후 원본 삭제, 검증 이력 보존" |
| 데이터 보유기간·국외이전 | 미결정 §2 | `retention_policies` 테이블. 값은 법률검토 후 주입 |
| SLA·RPO/RTO | 미결정 §2 | 모듈명세 §비기능의 제안치를 목표로만 기록 |
| W3C VC / EAS | 기획서 §6 P2 | `credential.ts` 인터페이스만 |

---

## 9. 검증 전략

### 테스트 피라미드

| 층 | 대상 | 러너 | 통과 조건 |
|---|---|---|---|
| 단위 | `packages/domain` 순수 함수 | vitest | 상태 전이 전수, ACL 조합, 배지 정책 |
| 통합 | `services/api` 모듈 + 실제 Postgres | vitest | 트리거·뷰·제약이 실제로 막는지 |
| E2E | 공개 프로필·검증 플로·리드 | Playwright | 사용자 여정(기획서 §8) |
| 보안 | IDOR·XSS·권한상승·signed URL | vitest + Playwright | 로드맵 §2 보안 항목 |

### 기능 ID 추적

새 기능은 코드 상단과 테스트 이름에 `P-0xx` 를 적는다.
`pnpm proplus:traceability` 가 `proplus/docs/TRACEABILITY.md` 를 재생성한다.
**테스트가 없는 기능은 "완료"로 표시하지 않는다.**

### 출시 게이트 (로드맵 §4)

코드로 확인 가능한 것만 CI 게이트로 만든다.

- [x] 공개 DTO allowlist 테스트 (N-4)
- [x] 관리자 권한·감사로그 테스트 (N-6, N-7)
- [x] 상태 전이 전수 테스트 (§4.2)
- [x] 자기기재 배지 차단 테스트 (N-1)
- [x] 만료 배지 즉시 회수 테스트 (N-9)
- [ ] 개인정보 보유기간 승인 — **법률검토 필요, 코드 외부**
- [ ] 라이선스 목록·SBOM 검토 — 외부 OSS 도입 시점에
- [ ] 백업 복구 시험 — 운영 절차

---

## 10. 배포 전략 — proplus.linkos.com

LINKOS 와 **같은 서버, 다른 모든 것**.

| 항목 | 값 |
|---|---|
| 주소 | https://proplus.linkos.com |
| 소스 | `/var/www/proplus` |
| 웹/API | `proplus-web.service` → `127.0.0.1:4400` (루프백 전용) |
| 워커 | `proplus-worker.service` |
| DB | PostgreSQL `proplus` DB / `proplus` 롤 |
| 설정 | `/etc/proplus/proplus.env` (root:proplus 640) |
| 업로드 | `/var/lib/proplus/storage` |
| vhost | `/etc/nginx/sites-available/proplus` + `/etc/nginx/conf.d/proplus.conf` |

### ⚠️ 선행 조건 (코드로 해결 불가)

1. **`linkos.com` 도메인 소유** — 미결정사항 §2 에 "PROPLUS 상표 및 도메인 확보 여부"가 미정으로 적혀 있다.
2. **TLS 인증서** — 기존 `/etc/ssl/ckp/pt.pem` 은 `*.ckp.kr` 와일드카드라 `proplus.linkos.com` 을 **덮지 않는다.**
   `*.linkos.com` Cloudflare Origin 인증서 발급 또는 Let's Encrypt 가 필요하다.
   vhost 는 `/etc/ssl/proplus/proplus.pem` 을 참조하도록 써 두었다.
3. **DNS** — `proplus.linkos.com` A/CNAME → `1.234.5.14` (Cloudflare 프록시 권장).

선행 조건이 미해결인 동안의 확인 경로: `proplus.ckp.kr` 로 같은 vhost 를 임시 운영 (`server_name` 두 줄).
자세한 절차는 `proplus/docs/03_DEPLOY.md`.

---

## 11. 이 전략이 틀릴 수 있는 지점

정직하게 기록한다 — 문서 세트가 "가설"이라고 명시한 것들이다.

1. **첫 파일럿 직군이 미정**이라 증거 유형 enum 이 바뀔 수 있다. 그래서 `evidence_type` 을 코드 enum 이 아닌
   **참조 테이블**로 두어 마이그레이션 없이 추가 가능하게 했다.
2. **검증 운영 비용**이 검증되지 않았다. 수동 검토 큐가 병목이면 `issuer_confirmed` 자동화가 P1 로 올라와야 한다.
3. **단일 점수 금지**는 제품 차별화의 핵심이지만 사용자가 비교 가능한 지표를 원할 수 있다.
   그때도 점수가 아니라 "같은 직군 내 지표 분포"를 보여주는 쪽으로 가야 한다 (보안정책 §4.9).
4. **모듈형 모놀리스**는 검증 워크로드가 커지면 `proof` 를 먼저 분리해야 한다. import 방향을 §3 에서 고정한 이유.
