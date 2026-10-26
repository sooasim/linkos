# PROPLUS TRACEABILITY

> 자동 생성: `pnpm proplus:traceability`. **직접 편집하지 마세요** — 원장(`proplus/docs/01_FEATURE_REGISTRY.yaml`) 또는 코드의 기능 ID 주석을 고치세요.

출처 원장: `proplus/docs/01_FEATURE_REGISTRY.yaml` (v1, 기능 156개) · 번들: `dd/PROPLUS_Technical_Document_Set`

코드·테스트 위치는 손으로 적은 매핑이 아니라 `proplus/` 아래 파일에서 수집한 기능 ID 주석이다 (`// P-0xx: …`).
그래서 코드가 사라지면 이 표에서도 사라진다 — **원장 `status: done` 인데 테스트 참조가 없는 기능은 아래 경고 섹션에 모인다**
(proplus/CLAUDE.md §1 / 전략 §9: 테스트가 없는 기능은 완료로 표시하지 않는다).

## 요약

| 우선순위 | 전체 | ✅ 검증 | ⚠️ 테스트 없음 | 🟡 진행 | ⬜ 계획 |
|---|---|---|---|---|---|
| P0 | 100 | 79 | 0 | 15 | 6 |
| P1 | 50 | 18 | 0 | 18 | 14 |
| P2 | 6 | 0 | 0 | 0 | 6 |
| 합계 | 156 | 97 | 0 | 33 | 26 |

## ⚠️ 검증 안 됨 (원장 `status: done` · 테스트 참조 없음)

없음. `status: done` 인 모든 기능이 기능 ID 를 표기한 테스트에서 참조된다.

## ⚠️ 원장·코드 불일치

- **선언된 테스트에 기능 ID 표기 없음** (1): P-166 → `services/api/test/audit.test.ts` — 테스트 이름에 ID 를 적어야 추적된다.

## M01 · Identity & Access

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-001 | P0 | 이메일 매직링크 로그인 | ✅ 검증 | `apps/web/src/app/api/v1/auth/callback/route.ts`, `apps/web/src/app/api/v1/auth/request-link/route.ts`, `apps/web/src/app/login/LoginForm.tsx`, `apps/web/src/app/login/page.tsx` +3 | `packages/domain/test/token.test.ts`, `services/api/test/identity.test.ts` |  |
| P-002 | P0 | 세션 쿠키 발급과 회전 | ✅ 검증 | `apps/web/src/app/api/v1/auth/callback/route.ts`, `apps/web/src/app/api/v1/me/evidence/[id]/files/route.ts`, `apps/web/src/app/login/verify/page.tsx`, `apps/web/src/lib/server.ts` +4 | `packages/domain/test/token.test.ts`, `services/api/test/identity.test.ts` |  |
| P-003 | P0 | 전체 세션 무효화 | ✅ 검증 | `apps/web/src/app/api/v1/auth/logout/route.ts`, `apps/web/src/app/api/v1/me/sessions/route.ts`, `apps/web/src/components/SignOutButton.tsx`, `packages/domain/src/token.ts` +4 | `services/api/test/admin.test.ts`, `services/api/test/analytics.test.ts`, `services/api/test/booking.test.ts`, `services/api/test/catalog.test.ts` +2 |  |
| P-004 | P0 | 로그인 rate limit | ✅ 검증 | `apps/web/src/app/api/v1/auth/request-link/route.ts`, `packages/domain/src/rateLimit.ts`, `services/api/src/modules/identity.ts`, `services/api/src/modules/linkosSso.ts` | `packages/domain/test/rateLimit.test.ts`, `services/api/test/identity.test.ts`, `services/api/test/org.test.ts` |  |
| P-005 | P0 | 세션 목록과 개별 폐기 | 🟡 진행 | `apps/web/src/app/api/v1/auth/logout/route.ts`, `apps/web/src/app/api/v1/me/sessions/[id]/route.ts`, `apps/web/src/app/api/v1/me/sessions/route.ts`, `apps/web/src/app/app/settings/SettingsClient.tsx` +3 | — |  |
| P-006 | P1 | MFA(TOTP) 옵션 | 🟡 진행 | `packages/domain/src/index.ts`, `packages/domain/src/totp.ts`, `scripts/reconcile-registry.mjs` | `packages/domain/test/totp.test.ts` |  |
| P-007 | P1 | 계정 복구 플로 | ⬜ 계획 | `services/api/src/modules/identity.ts` | — |  |
| P-008 | P0 | 동의 기록 (종류별 분리) | ✅ 검증 | `apps/web/src/app/app/settings/page.tsx`, `packages/domain/src/consent.ts`, `services/api/src/modules/identity.ts` | `packages/domain/test/consent.test.ts`, `services/api/test/identity.test.ts` | N-11 |
| P-009 | P0 | 역할 기반 권한 (개인/조직관리자/검증자/운영자) | ✅ 검증 | `apps/web/src/app/api/v1/me/route.ts`, `packages/domain/src/acl.ts`, `services/api/src/modules/identity.ts` | `packages/domain/test/acl.test.ts`, `services/api/test/identity.test.ts` |  |
| P-010 | P0 | 계정 내보내기 요청 | 🟡 진행 | `apps/web/src/app/api/v1/me/export/route.ts`, `apps/web/src/app/api/v1/me/route.ts`, `apps/web/src/app/app/settings/SettingsClient.tsx`, `apps/web/src/app/app/settings/page.tsx` +1 | — |  |
| P-011 | P0 | 계정 삭제 요청 | ✅ 검증 | `apps/web/src/app/api/v1/me/route.ts`, `apps/web/src/app/app/settings/SettingsClient.tsx`, `apps/web/src/app/app/settings/page.tsx`, `db/seeds/seed.ts` +2 | `services/api/test/identity.test.ts` |  |
| P-012 | P1 | 위험 로그인 탐지 기록 | ⬜ 계획 | — | — |  |

## M02 · Profile & Personal Brand

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-020 | P0 | 프로필 생성과 slug 예약 | ✅ 검증 | `apps/web/src/app/api/v1/me/profile/route.ts`, `packages/domain/src/slug.ts`, `services/api/src/modules/profile.ts` | `packages/domain/test/slug.test.ts` |  |
| P-021 | P0 | 기본 프로필 필드 (이름·헤드라인·소개) | 🟡 진행 | `apps/web/src/app/api/v1/me/profile/route.ts`, `apps/web/src/app/app/profile/page.tsx`, `services/api/src/modules/profile.ts` | — |  |
| P-022 | P0 | 전문분야(specialties) 분류 | 🟡 진행 | `services/api/src/modules/profile.ts` | — |  |
| P-023 | P0 | 직무·경력 항목 | 🟡 진행 | `apps/web/src/app/p/[slug]/page.tsx`, `services/api/src/modules/profile.ts` | — | N-1 |
| P-024 | P0 | 언어·지역(선택) | ✅ 검증 | `db/migrations/0001_proplus_core.sql` | `services/api/test/search.test.ts` |  |
| P-025 | P0 | 공개 프로필 페이지 /p/{slug} | ✅ 검증 | `apps/web/src/app/api/v1/public/profiles/[slug]/route.ts`, `apps/web/src/app/p/[slug]/page.tsx`, `apps/web/src/components/TrustSection.tsx`, `services/api/src/modules/profile.ts` | `tests/e2e/publicProfile.spec.ts` | N-4 |
| P-026 | P0 | 공개 DTO allowlist | ✅ 검증 | `apps/web/src/app/api/v1/public/profiles/[slug]/route.ts`, `services/api/src/modules/profile.ts` | `packages/domain/test/publicDto.test.ts`, `tests/e2e/publicProfile.spec.ts` | N-4 |
| P-027 | P0 | 발행/비발행 전환 | ✅ 검증 | `apps/web/src/app/api/v1/me/profile/publish/route.ts`, `apps/web/src/app/api/v1/me/profile/unpublish/route.ts`, `apps/web/src/app/app/page.tsx`, `apps/web/src/app/app/profile/ProfileEditor.tsx` +4 | `tests/e2e/publicProfile.spec.ts` |  |
| P-028 | P0 | 프로필 버전 기록과 복원 | 🟡 진행 | `apps/web/src/app/api/v1/me/profile/versions/route.ts`, `apps/web/src/app/app/profile/ProfileEditor.tsx`, `apps/web/src/app/app/profile/page.tsx`, `services/api/src/modules/profile.ts` | — |  |
| P-029 | P0 | 개인정보 공개 설정 | ✅ 검증 | `apps/web/src/app/api/v1/me/profile/publish/route.ts`, `apps/web/src/app/api/v1/me/profile/route.ts`, `apps/web/src/app/app/profile/ProfileEditor.tsx`, `apps/web/src/app/app/profile/page.tsx` +4 | `packages/domain/test/publicDto.test.ts`, `services/api/test/search.test.ts` | N-4 |
| P-030 | P0 | SEO·OG 메타데이터 | ✅ 검증 | `apps/web/src/app/layout.tsx`, `apps/web/src/app/login/linkos/page.tsx`, `apps/web/src/app/login/page.tsx`, `apps/web/src/app/p/[slug]/not-found.tsx` +2 | `tests/e2e/publicProfile.spec.ts` |  |
| P-031 | P0 | sitemap·robots | ⬜ 계획 | `apps/web/src/app/robots.ts`, `apps/web/src/app/sitemap.ts`, `services/api/src/modules/profile.ts` | — |  |
| P-032 | P1 | 프로필 완성도 안내 | ✅ 검증 | `apps/web/src/app/app/page.tsx`, `apps/web/src/app/app/profile/page.tsx`, `packages/domain/src/completeness.ts`, `services/api/src/modules/profile.ts` | `packages/domain/test/completeness.test.ts` | N-3 |
| P-033 | P0 | SNS·외부 링크 | ✅ 검증 | `apps/web/src/app/p/[slug]/page.tsx`, `apps/web/src/components/OfferCard.tsx`, `packages/domain/src/blockSchema.ts`, `packages/domain/src/sanitize.ts` +1 | `packages/domain/test/blockSchema.test.ts`, `packages/domain/test/sanitize.test.ts`, `packages/domain/test/vcard.test.ts` |  |
| P-034 | P1 | FAQ 블록 | 🟡 진행 | `apps/web/src/app/p/[slug]/page.tsx`, `packages/domain/src/blockSchema.ts` | — |  |
| P-035 | P0 | QR·vCard·공유 링크 | ✅ 검증 | `apps/web/src/app/api/v1/public/profiles/[slug]/vcard/route.ts`, `apps/web/src/app/p/[slug]/page.tsx`, `packages/domain/src/vcard.ts`, `services/api/src/modules/profile.ts` | `packages/domain/test/vcard.test.ts`, `tests/e2e/publicProfile.spec.ts` |  |
| P-036 | P0 | 상담 CTA 구성 | 🟡 진행 | `apps/web/src/app/p/[slug]/contact/page.tsx`, `apps/web/src/app/p/[slug]/page.tsx`, `packages/domain/src/blockSchema.ts`, `services/api/src/modules/profile.ts` | — |  |

## M03 · Mini Site

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-040 | P1 | 블록 schema allowlist | ✅ 검증 | `apps/web/next.config.ts`, `apps/web/src/app/api/v1/me/profile/blocks/route.ts`, `packages/domain/src/blockSchema.ts`, `services/api/src/modules/profile.ts` | `packages/domain/test/blockSchema.test.ts` | N-10 |
| P-041 | P1 | 텍스트 sanitizer | ✅ 검증 | `apps/web/next.config.ts`, `packages/domain/src/sanitize.ts` | `packages/domain/test/sanitize.test.ts` | N-10 |
| P-042 | P0 | CSP 헤더 | 🟡 진행 | `apps/web/next.config.ts`, `apps/web/src/app/admin/page.tsx`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/p/[slug]/contact/LeadForm.tsx` +3 | — | N-10 |
| P-043 | P1 | 블록 순서 변경 | 🟡 진행 | `apps/web/src/app/api/v1/me/profile/blocks/route.ts`, `services/api/src/modules/profile.ts` | — |  |
| P-044 | P1 | 승인된 템플릿 선택 | 🟡 진행 | `services/api/src/modules/profile.ts` | — |  |
| P-045 | P1 | 색상·폰트 토큰 선택 | ⬜ 계획 | `services/api/src/modules/profile.ts` | — |  |
| P-046 | P1 | 저장 전 미리보기 | ⬜ 계획 | — | — |  |
| P-047 | P1 | 이미지 업로드와 리사이즈 | ⬜ 계획 | `packages/domain/src/blockSchema.ts` | — |  |
| P-048 | P1 | 사용자 도메인 연결 | ⬜ 계획 | `services/api/src/modules/profile.ts` | — |  |
| P-049 | P1 | AI 콘텐츠·FAQ 생성 보조 | ⬜ 계획 | — | — |  |

## M04 · Proof Engine

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-050 | P0 | 증거 유형 참조 테이블 | 🟡 진행 | `apps/web/src/app/api/v1/evidence-types/route.ts`, `apps/web/src/app/app/evidence/new/page.tsx`, `apps/web/src/app/app/page.tsx`, `apps/web/src/lib/client.ts` +3 | — |  |
| P-051 | P0 | 증거 제출 (메타데이터) | ✅ 검증 | `apps/web/src/app/api/v1/me/evidence/[id]/route.ts`, `apps/web/src/app/api/v1/me/evidence/route.ts`, `apps/web/src/app/app/evidence/EvidenceList.tsx`, `apps/web/src/app/app/evidence/[id]/page.tsx` +5 | `services/api/test/proof.test.ts` |  |
| P-052 | P0 | 증거 파일 업로드 세션 | ✅ 검증 | `apps/web/src/app/api/v1/files/route.ts`, `apps/web/src/app/api/v1/me/evidence/[id]/files/route.ts`, `apps/web/src/app/app/evidence/[id]/AppealForm.tsx`, `apps/web/src/app/app/evidence/new/EvidenceForm.tsx` +3 | `packages/domain/test/mime.test.ts` | N-5 |
| P-053 | P0 | 검증 상태 머신 | ✅ 검증 | `apps/web/src/app/api/v1/me/evidence/[id]/transition/route.ts`, `apps/web/src/app/app/evidence/[id]/AppealForm.tsx`, `apps/web/src/app/app/evidence/[id]/page.tsx`, `apps/web/src/components/StatusChip.tsx` +1 | `packages/domain/test/proof.test.ts` |  |
| P-054 | P0 | 자기기재 배지 차단 | ✅ 검증 | — | `packages/domain/test/proof.test.ts`, `services/api/test/proof.test.ts` | N-1 |
| P-055 | P0 | 검증 강도 4단계 | ✅ 검증 | — | `packages/domain/test/proof.test.ts`, `packages/domain/test/types.test.ts` |  |
| P-056 | P0 | 검증 범위·기준일·만료일 | ✅ 검증 | — | `packages/domain/test/proof.test.ts`, `services/api/test/proof.test.ts` |  |
| P-057 | P0 | 배지 발급 | ✅ 검증 | `services/api/src/modules/proof.ts` | `services/api/test/proof.test.ts` | N-5 |
| P-058 | P0 | 공개 배지 6필드 보장 | ✅ 검증 | `apps/web/src/app/api/v1/ext/badges/lookup/route.ts`, `apps/web/src/app/globals.css`, `apps/web/src/components/Badge.tsx`, `apps/web/src/components/TrustSection.tsx` +5 | `packages/domain/test/badge.test.ts`, `tests/e2e/publicProfile.spec.ts` |  |
| P-059 | P0 | 만료 즉시 반영 | ✅ 검증 | — | `packages/domain/test/badge.test.ts`, `packages/domain/test/proof.test.ts`, `services/api/test/proof.test.ts` | N-9 |
| P-060 | P0 | 만료 예정 알림 | ✅ 검증 | `db/migrations/0002_affiliation_badge_follows_membership.sql`, `packages/domain/src/proof.ts`, `services/api/src/lib/mail.ts`, `services/api/src/modules/integration.ts` +2 | `packages/domain/test/proof.test.ts` |  |
| P-061 | P0 | 배지 취소(revoke) | ✅ 검증 | `apps/web/src/app/api/v1/admin/badges/[id]/revoke/route.ts`, `apps/web/src/app/api/v1/me/evidence/[id]/transition/route.ts`, `apps/web/src/app/app/evidence/[id]/AppealForm.tsx`, `apps/web/src/app/app/page.tsx` +3 | `packages/domain/test/proof.test.ts`, `services/api/test/proof.test.ts` |  |
| P-062 | P0 | 재검증 요청 | ✅ 검증 | `apps/web/src/app/api/v1/admin/verifications/[id]/approve/route.ts`, `packages/domain/src/proof.ts`, `services/api/src/modules/proof.ts` | `packages/domain/test/proof.test.ts`, `services/api/test/proof.test.ts` |  |
| P-063 | P0 | 이의제기(appeal) | ✅ 검증 | `apps/web/src/app/api/v1/me/evidence/[id]/transition/route.ts`, `apps/web/src/app/api/v1/me/verifications/[id]/appeal/route.ts`, `apps/web/src/app/app/evidence/[id]/AppealForm.tsx`, `apps/web/src/app/app/evidence/[id]/page.tsx` +2 | `services/api/test/proof.test.ts` |  |
| P-064 | P0 | 분쟁 중 중립 표기 | ✅ 검증 | — | `packages/domain/test/badge.test.ts` | N-14 |
| P-065 | P0 | 검증 상태 변경 감사로그 | ⬜ 계획 | — | `services/api/test/audit.test.ts` | N-6 |
| P-066 | P0 | 측정 지표 등록 (metric_claims) | ✅ 검증 | `apps/web/src/app/api/v1/me/metrics/route.ts`, `apps/web/src/components/MetricClaim.tsx`, `packages/domain/src/metric.ts`, `services/api/src/modules/proof.ts` | `packages/domain/test/metric.test.ts`, `services/api/test/proof.test.ts` | N-8 |
| P-067 | P0 | 거래 수치는 연동 증거만 | ✅ 검증 | `apps/web/src/app/api/v1/me/metrics/route.ts`, `apps/web/src/app/app/evidence/new/EvidenceForm.tsx`, `apps/web/src/app/app/evidence/new/page.tsx`, `db/migrations/0001_proplus_core.sql` +3 | `packages/domain/test/metric.test.ts`, `services/api/test/proof.test.ts` |  |
| P-068 | P1 | 응답시간 지표 표기 | 🟡 진행 | `apps/web/src/components/MetricClaim.tsx`, `packages/domain/src/metric.ts` | — |  |
| P-069 | P0 | 배지 설명 패널 | ✅ 검증 | `apps/web/src/app/api/v1/evidence-types/route.ts`, `apps/web/src/app/globals.css`, `apps/web/src/components/Disclosure.tsx`, `apps/web/src/components/TrustSection.tsx` +1 | `tests/e2e/publicProfile.spec.ts` |  |
| P-070 | P0 | 배지 유료 구매 차단 | ✅ 검증 | — | `packages/domain/test/badge.test.ts`, `services/api/test/proof.test.ts` | N-2 |
| P-071 | P0 | 직군 간 단순 순위화 금지 | ✅ 검증 | `packages/domain/src/index.ts`, `packages/domain/src/ranking.ts` | `packages/domain/test/ranking.test.ts` |  |
| P-072 | P1 | 발급기관 등록·신뢰 확인 | ✅ 검증 | `db/migrations/0001_proplus_core.sql`, `db/seeds/seed.ts`, `packages/domain/src/proof.ts` | `packages/domain/test/proof.test.ts`, `services/api/test/org.test.ts` |  |
| P-073 | P0 | 증거 원본 다운로드 감사 | ✅ 검증 | `apps/web/src/app/admin/evidence/[id]/PurposeGate.tsx`, `apps/web/src/app/api/v1/files/[id]/route.ts`, `apps/web/src/app/api/v1/files/route.ts`, `services/api/src/modules/admin.ts` +1 | `services/api/test/audit.test.ts` |  |
| P-074 | P1 | 증거 보존기간·삭제 | ⬜ 계획 | `services/api/src/modules/proof.ts` | — |  |

## M05 · Organization & Affiliation

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-080 | P0 | 조직 생성 | 🟡 진행 | `apps/web/src/app/api/v1/organizations/route.ts`, `services/api/src/modules/org.ts` | — |  |
| P-081 | P0 | 도메인 소유 검증 (DNS TXT) | ✅ 검증 | `apps/web/src/app/api/v1/organizations/[id]/domain/confirm/route.ts`, `apps/web/src/app/api/v1/organizations/[id]/domain/route.ts`, `db/migrations/0001_proplus_core.sql`, `packages/domain/src/token.ts` +2 | `packages/domain/test/token.test.ts`, `services/api/test/org.test.ts` |  |
| P-082 | P0 | 직원 초대 | ✅ 검증 | `apps/web/src/app/api/v1/invites/accept/route.ts`, `apps/web/src/app/api/v1/organizations/[id]/invites/route.ts`, `apps/web/src/app/api/v1/organizations/[id]/members/route.ts`, `services/api/src/modules/org.ts` | `services/api/test/org.test.ts` |  |
| P-083 | P0 | 소속 승인 | ✅ 검증 | `apps/web/src/app/api/v1/organizations/[id]/members/[userId]/verify/route.ts`, `apps/web/src/app/api/v1/organizations/[id]/members/route.ts`, `packages/domain/src/acl.ts`, `services/api/src/modules/org.ts` +1 | `packages/domain/test/acl.test.ts`, `services/api/test/org.test.ts` | N-12 |
| P-084 | P0 | 소속 취소·퇴사 처리 | ✅ 검증 | `apps/web/src/app/api/v1/organizations/[id]/members/[userId]/revoke/route.ts`, `packages/domain/src/acl.ts`, `services/api/src/modules/identity.ts`, `services/api/src/modules/lead.ts` +2 | `packages/domain/test/acl.test.ts`, `services/api/test/org.test.ts` | N-12 |
| P-085 | P0 | 소속 만료 자동 처리 | ✅ 검증 | `db/migrations/0002_affiliation_badge_follows_membership.sql`, `services/api/src/modules/lead.ts`, `services/api/src/modules/org.ts` | `services/api/test/org.test.ts` |  |
| P-086 | P0 | 조직 멤버 목록 | ✅ 검증 | `apps/web/src/app/api/v1/organizations/[id]/members/route.ts`, `apps/web/src/app/api/v1/organizations/[id]/route.ts`, `services/api/src/modules/org.ts` | `services/api/test/org.test.ts` |  |
| P-087 | P1 | 대량 초대 | ⬜ 계획 | — | — |  |
| P-088 | P1 | 팀 페이지 | ⬜ 계획 | — | — |  |
| P-089 | P1 | 회사 공용 카탈로그 배포 | ⬜ 계획 | `apps/web/src/app/api/v1/me/offers/route.ts`, `services/api/src/modules/catalog.ts` | — |  |

## M06 · Catalog & Offer

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-090 | P1 | 상품/서비스 카드 | ✅ 검증 | `apps/web/src/app/api/v1/me/offers/[id]/route.ts`, `apps/web/src/app/api/v1/me/offers/route.ts`, `apps/web/src/app/app/offers/OfferManager.tsx`, `apps/web/src/app/app/offers/page.tsx` +2 | `services/api/test/catalog.test.ts` |  |
| P-091 | P1 | 가격 표시 정책 | ✅ 검증 | `apps/web/src/app/api/v1/me/offers/route.ts`, `apps/web/src/app/app/offers/OfferManager.tsx`, `apps/web/src/app/app/offers/page.tsx`, `db/migrations/0001_proplus_core.sql` +1 | `services/api/test/catalog.test.ts` |  |
| P-092 | P1 | 품절·만료 상품 비공개 | ✅ 검증 | `apps/web/src/app/api/v1/me/offers/[id]/route.ts`, `apps/web/src/app/api/v1/public/profiles/[slug]/offers/route.ts`, `apps/web/src/app/app/offers/OfferManager.tsx`, `apps/web/src/app/app/offers/page.tsx` +3 | `services/api/test/catalog.test.ts` |  |
| P-093 | P1 | 외부 링크형 상품 | 🟡 진행 | `apps/web/src/app/api/v1/public/profiles/[slug]/offers/route.ts`, `apps/web/src/app/app/offers/OfferManager.tsx`, `apps/web/src/app/app/offers/page.tsx`, `apps/web/src/components/OfferCard.tsx` +1 | — |  |
| P-094 | P1 | 상품 CTA → 리드 연결 | 🟡 진행 | `apps/web/src/app/api/v1/public/profiles/[slug]/appointments/route.ts`, `services/api/src/modules/booking.ts`, `services/api/src/modules/catalog.ts` | — |  |
| P-095 | P1 | 판매 권한 표시 | ⬜ 계획 | `services/api/src/modules/catalog.ts` | — |  |
| P-096 | P2 | 결제·주문 연계 | ⬜ 계획 | `services/api/src/modules/catalog.ts` | — |  |

## M07 · Lead & CRM

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-100 | P0 | 공개 상담 요청 폼 | ✅ 검증 | `apps/web/src/app/api/v1/public/profiles/[slug]/leads/route.ts`, `apps/web/src/app/p/[slug]/contact/LeadForm.tsx`, `apps/web/src/app/p/[slug]/contact/page.tsx`, `packages/domain/src/rateLimit.ts` +1 | `tests/e2e/lead.spec.ts` |  |
| P-101 | P0 | 동의 분리 기록 | ✅ 검증 | `apps/web/src/app/api/v1/public/profiles/[slug]/leads/route.ts`, `apps/web/src/app/p/[slug]/contact/LeadForm.tsx`, `apps/web/src/app/p/[slug]/contact/page.tsx`, `packages/domain/src/consent.ts` +1 | `packages/domain/test/consent.test.ts`, `services/api/test/lead.test.ts`, `tests/e2e/lead.spec.ts` | N-11 |
| P-102 | P0 | 연락처 암호화 저장 | ✅ 검증 | `apps/web/src/app/api/v1/me/leads/route.ts`, `apps/web/src/app/api/v1/public/profiles/[slug]/leads/route.ts`, `apps/web/src/app/app/leads/[id]/page.tsx`, `apps/web/src/app/app/leads/page.tsx` +7 | `packages/domain/test/mask.test.ts`, `services/api/test/lead.test.ts`, `tests/e2e/lead.spec.ts` |  |
| P-103 | P0 | 리드 inbox | ✅ 검증 | `apps/web/src/app/api/v1/me/leads/[id]/route.ts`, `apps/web/src/app/api/v1/me/leads/route.ts`, `apps/web/src/app/app/leads/LeadTable.tsx`, `apps/web/src/app/app/leads/[id]/page.tsx` +4 | `packages/domain/test/acl.test.ts`, `services/api/test/lead.test.ts` |  |
| P-104 | P0 | 리드 단계(stage) 변경 | ✅ 검증 | `apps/web/src/app/api/v1/me/leads/[id]/route.ts`, `apps/web/src/app/app/leads/LeadTable.tsx`, `apps/web/src/app/app/leads/[id]/LeadDetail.tsx`, `apps/web/src/components/StatusChip.tsx` +4 | `packages/domain/test/leadStage.test.ts`, `packages/domain/test/mask.test.ts`, `services/api/test/lead.test.ts` |  |
| P-105 | P0 | 담당자 배정 | ✅ 검증 | `apps/web/src/app/api/v1/me/leads/[id]/route.ts`, `packages/domain/src/acl.ts`, `services/api/src/modules/lead.ts` | `packages/domain/test/acl.test.ts` |  |
| P-106 | P0 | 리드 메모 | ✅ 검증 | `apps/web/src/app/api/v1/me/leads/[id]/notes/route.ts`, `apps/web/src/app/app/leads/[id]/LeadDetail.tsx`, `apps/web/src/app/app/leads/[id]/page.tsx`, `db/migrations/0001_proplus_core.sql` +1 | `services/api/test/lead.test.ts` |  |
| P-107 | P0 | 새 리드 알림 | ✅ 검증 | `services/api/src/lib/mail.ts`, `services/api/src/modules/lead.ts` | `services/api/test/outbox.test.ts` |  |
| P-108 | P1 | 후속 태스크 | ⬜ 계획 | — | — |  |
| P-109 | P1 | 리드 내보내기 | ✅ 검증 | `apps/web/src/app/api/v1/me/leads/export/route.ts`, `apps/web/src/app/app/leads/LeadTable.tsx`, `services/api/src/modules/lead.ts` | `services/api/test/audit.test.ts` |  |
| P-110 | P0 | 보존기간 만료 삭제 | ✅ 검증 | `services/api/src/modules/integration.ts`, `services/api/src/modules/lead.ts`, `services/api/src/worker.ts` | `services/api/test/lead.test.ts` |  |
| P-111 | P1 | 응답시간 측정 | ✅ 검증 | `packages/domain/src/leadStage.ts`, `services/api/src/modules/lead.ts` | `packages/domain/test/leadStage.test.ts`, `services/api/test/lead.test.ts` | N-8 |
| P-112 | P0 | 스팸·악성 발신 차단 | ✅ 검증 | `apps/web/src/app/api/v1/public/profiles/[slug]/leads/route.ts`, `apps/web/src/app/p/[slug]/contact/LeadForm.tsx`, `services/api/src/modules/lead.ts` | `packages/domain/test/rateLimit.test.ts`, `services/api/test/lead.test.ts`, `tests/e2e/lead.spec.ts` |  |

## M08 · Booking

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-120 | P1 | 가용 시간 슬롯 정의 | 🟡 진행 | `apps/web/src/app/api/v1/me/availability/route.ts`, `apps/web/src/app/api/v1/public/profiles/[slug]/slots/route.ts`, `services/api/src/modules/booking.ts` | — |  |
| P-121 | P1 | 예약 요청 | 🟡 진행 | `apps/web/src/app/api/v1/public/profiles/[slug]/appointments/route.ts`, `apps/web/src/app/api/v1/public/profiles/[slug]/slots/route.ts`, `services/api/src/modules/booking.ts` | — |  |
| P-122 | P1 | 이중 예약 방지 | ✅ 검증 | `apps/web/src/app/api/v1/me/appointments/[id]/route.ts`, `apps/web/src/app/api/v1/public/profiles/[slug]/appointments/route.ts`, `db/migrations/0001_proplus_core.sql`, `services/api/src/modules/booking.ts` | `services/api/test/booking.test.ts`, `services/api/test/migrate.test.ts` |  |
| P-123 | P1 | 예약 확인·취소 | ✅ 검증 | `apps/web/src/app/api/v1/me/appointments/[id]/cancel/route.ts`, `apps/web/src/app/api/v1/me/appointments/[id]/route.ts`, `apps/web/src/app/api/v1/public/profiles/[slug]/slots/route.ts`, `services/api/src/modules/booking.ts` | `services/api/test/booking.test.ts` |  |
| P-124 | P1 | 예약 알림 | 🟡 진행 | `services/api/src/modules/booking.ts` | — |  |
| P-125 | P1 | ICS 내보내기 | ⬜ 계획 | `apps/web/src/app/api/v1/me/appointments/[id]/cancel/route.ts`, `services/api/src/modules/booking.ts` | — |  |
| P-126 | P2 | 외부 캘린더 연동 | ⬜ 계획 | `services/api/src/modules/booking.ts` | — |  |

## M09 · Analytics

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-130 | P0 | 페이지 조회 기록 | ✅ 검증 | `apps/web/src/app/api/v1/events/route.ts`, `apps/web/src/lib/server.ts`, `packages/domain/src/redact.ts`, `services/api/src/modules/analytics.ts` | `packages/domain/test/redact.test.ts`, `services/api/test/analytics.test.ts` | N-13 |
| P-131 | P0 | CTA 클릭 기록 | 🟡 진행 | `apps/web/src/app/api/v1/events/route.ts`, `services/api/src/modules/analytics.ts` | — |  |
| P-132 | P0 | 상담 제출 전환 | ✅ 검증 | `apps/web/src/app/api/v1/me/analytics/summary/route.ts`, `apps/web/src/app/app/analytics/page.tsx`, `services/api/src/modules/analytics.ts` | `services/api/test/analytics.test.ts` |  |
| P-133 | P1 | 예약 완료 전환 | ✅ 검증 | `apps/web/src/app/api/v1/me/analytics/summary/route.ts`, `apps/web/src/app/app/analytics/page.tsx`, `services/api/src/modules/analytics.ts` | `services/api/test/analytics.test.ts` |  |
| P-134 | P0 | UTM 캠페인 귀속 | ✅ 검증 | `apps/web/src/app/api/v1/events/route.ts`, `apps/web/src/app/api/v1/me/leads/export/route.ts`, `apps/web/src/app/api/v1/public/profiles/[slug]/leads/route.ts`, `services/api/src/modules/analytics.ts` +1 | `services/api/test/analytics.test.ts` |  |
| P-135 | P0 | 기간별 요약 API | ✅ 검증 | `apps/web/src/app/api/v1/events/route.ts`, `apps/web/src/app/api/v1/me/analytics/summary/route.ts`, `apps/web/src/app/app/analytics/page.tsx`, `services/api/src/modules/analytics.ts` | `services/api/test/analytics.test.ts` |  |
| P-136 | P1 | 배지 조회 기록 | 🟡 진행 | `apps/web/src/app/api/v1/events/route.ts`, `services/api/src/modules/analytics.ts` | — |  |

## M10 · Billing & Plans

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-140 | P1 | 요금제 정의 (Free/Pro/Business) | ✅ 검증 | `apps/web/src/app/api/v1/plans/route.ts`, `db/migrations/0001_proplus_core.sql`, `packages/domain/src/plans.ts`, `services/api/src/modules/billing.ts` +1 | `packages/domain/test/plans.test.ts`, `services/api/test/catalog.test.ts` |  |
| P-141 | P1 | 요금제 한도 적용 | ✅ 검증 | `apps/web/src/app/api/v1/me/analytics/summary/route.ts`, `apps/web/src/app/api/v1/me/availability/route.ts`, `apps/web/src/app/api/v1/me/offers/route.ts`, `apps/web/src/app/api/v1/me/subscription/route.ts` +7 | `packages/domain/test/plans.test.ts`, `services/api/test/analytics.test.ts`, `services/api/test/catalog.test.ts` | N-2 |
| P-142 | P1 | 구독 상태 기록 | 🟡 진행 | `apps/web/src/app/api/v1/me/subscription/route.ts`, `services/api/src/modules/billing.ts` | — |  |
| P-143 | P1 | 해지 후 데이터 접근 정책 | 🟡 진행 | `apps/web/src/app/api/v1/me/subscription/route.ts`, `services/api/src/modules/billing.ts` | — |  |
| P-144 | P2 | 결제 연동 | ⬜ 계획 | `apps/web/src/app/api/v1/me/subscription/route.ts`, `services/api/src/modules/billing.ts` | — |  |

## M11 · Search & Discovery

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-150 | P1 | 전문가 검색 (직무·지역·전문분야) | ✅ 검증 | `apps/web/src/app/api/v1/search/route.ts`, `apps/web/src/app/search/page.tsx`, `db/migrations/0001_proplus_core.sql`, `packages/domain/src/search.ts` +1 | `packages/domain/test/search.test.ts`, `services/api/test/migrate.test.ts`, `services/api/test/search.test.ts` |  |
| P-151 | P1 | 검증 상태 필터 | 🟡 진행 | `apps/web/src/app/api/v1/search/route.ts`, `apps/web/src/app/search/page.tsx`, `services/api/src/modules/search.ts` | — | N-3 |
| P-152 | P1 | 광고/유료 노출 구분 | ✅ 검증 | `apps/web/src/app/api/v1/search/route.ts`, `apps/web/src/app/search/page.tsx`, `packages/domain/src/search.ts`, `services/api/src/modules/search.ts` | `packages/domain/test/search.test.ts`, `services/api/test/search.test.ts` | N-15 |
| P-153 | P1 | 랭킹 근거 공개 | ✅ 검증 | `apps/web/src/app/api/v1/search/route.ts`, `apps/web/src/app/search/page.tsx`, `packages/domain/src/search.ts`, `services/api/src/modules/search.ts` | `packages/domain/test/search.test.ts`, `services/api/test/search.test.ts` | N-15 |
| P-154 | P1 | 검색 인덱스 어댑터 | 🟡 진행 | `services/api/src/modules/search.ts` | — |  |
| P-155 | P1 | 삭제·비공개 동기화 | ✅ 검증 | `services/api/src/modules/search.ts` | `services/api/test/search.test.ts` |  |
| P-156 | P1 | zero-result 기록 | 🟡 진행 | `services/api/src/modules/analytics.ts`, `services/api/src/modules/search.ts` | — |  |
| P-157 | P2 | typo tolerance | ⬜ 계획 | `services/api/src/modules/search.ts` | — |  |
| P-158 | P2 | 추천 | ⬜ 계획 | `services/api/src/modules/search.ts` | — |  |

## M12 · Admin, Trust & Safety

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-160 | P0 | 검증 검토 큐 | ✅ 검증 | `apps/web/src/app/admin/layout.tsx`, `apps/web/src/app/admin/queue/QueueList.tsx`, `apps/web/src/app/admin/queue/page.tsx`, `apps/web/src/app/api/v1/admin/queue/route.ts` +3 | `services/api/test/admin.test.ts` |  |
| P-161 | P0 | 증거 승인 | ✅ 검증 | `apps/web/src/app/admin/evidence/[id]/ReviewPanel.tsx`, `apps/web/src/app/admin/evidence/[id]/page.tsx`, `apps/web/src/app/api/v1/admin/evidence/[id]/route.ts`, `apps/web/src/app/api/v1/admin/verifications/[id]/approve/route.ts` +2 | `services/api/test/admin.test.ts` |  |
| P-162 | P0 | 증거 반려 | ✅ 검증 | `apps/web/src/app/admin/evidence/[id]/ReviewPanel.tsx`, `apps/web/src/app/api/v1/admin/verifications/[id]/reject/route.ts`, `apps/web/src/app/app/evidence/EvidenceList.tsx`, `apps/web/src/components/ReasonCodeSelect.tsx` +1 | `services/api/test/proof.test.ts` |  |
| P-163 | P0 | 추가 정보 요청 | ✅ 검증 | `apps/web/src/app/admin/evidence/[id]/ReviewPanel.tsx`, `apps/web/src/app/api/v1/admin/verifications/[id]/request-info/route.ts`, `services/api/src/modules/proof.ts` | `packages/domain/test/proof.test.ts` |  |
| P-164 | P0 | 검증자 내부 메모 | ✅ 검증 | `apps/web/src/app/admin/evidence/[id]/PurposeGate.tsx`, `apps/web/src/app/admin/evidence/[id]/ReviewPanel.tsx`, `apps/web/src/app/api/v1/admin/verifications/[id]/notes/route.ts`, `apps/web/src/app/api/v1/me/evidence/[id]/route.ts` +4 | `services/api/test/admin.test.ts`, `services/api/test/proof.test.ts` |  |
| P-165 | P0 | 운영자 접근 사유 기록 | ✅ 검증 | `apps/web/src/app/admin/evidence/[id]/PurposeGate.tsx`, `apps/web/src/app/admin/evidence/[id]/page.tsx`, `apps/web/src/app/admin/layout.tsx`, `apps/web/src/app/admin/queue/page.tsx` +18 | `packages/domain/test/acl.test.ts`, `services/api/test/admin.test.ts`, `services/api/test/audit.test.ts`, `services/api/test/identity.test.ts` |  |
| P-166 | P0 | 감사로그 조회 | ✅ 검증 | `apps/web/src/app/admin/audit/page.tsx`, `apps/web/src/app/admin/layout.tsx`, `apps/web/src/app/api/v1/admin/appeals/route.ts`, `services/api/src/modules/admin.ts` | `services/api/test/admin.test.ts` (원장 선언: `services/api/test/audit.test.ts`) | N-7 |
| P-167 | P0 | 신고 큐 | ✅ 검증 | `apps/web/src/app/admin/layout.tsx`, `apps/web/src/app/admin/reports/ReportList.tsx`, `apps/web/src/app/admin/reports/page.tsx`, `apps/web/src/app/api/v1/admin/reports/route.ts` +4 | `packages/domain/test/rateLimit.test.ts` |  |
| P-168 | P0 | 이의제기 처리 | 🟡 진행 | `apps/web/src/app/admin/appeals/AppealList.tsx`, `apps/web/src/app/admin/appeals/page.tsx`, `apps/web/src/app/admin/layout.tsx`, `apps/web/src/app/admin/queue/QueueList.tsx` +3 | — |  |
| P-169 | P0 | 정책 버전 관리 | ✅ 검증 | `apps/web/src/app/p/[slug]/contact/LeadForm.tsx`, `apps/web/src/app/p/[slug]/contact/page.tsx`, `db/migrations/0001_proplus_core.sql`, `packages/domain/src/consent.ts` +3 | `packages/domain/test/consent.test.ts`, `services/api/test/identity.test.ts`, `services/api/test/lead.test.ts`, `services/api/test/org.test.ts` +1 |  |
| P-170 | P0 | 위반 처리 (비공개·정지) | 🟡 진행 | `apps/web/src/app/admin/reports/ReportList.tsx`, `apps/web/src/app/admin/reports/page.tsx`, `apps/web/src/app/api/v1/admin/reports/[id]/route.ts`, `apps/web/src/app/api/v1/admin/reports/route.ts` +1 | — |  |
| P-171 | P0 | 관리자 권한 변경 감사 | ✅ 검증 | `apps/web/src/app/admin/layout.tsx`, `apps/web/src/app/api/v1/admin/audit/route.ts`, `services/api/src/modules/admin.ts` | `services/api/test/admin.test.ts`, `services/api/test/audit.test.ts` |  |
| P-172 | P1 | 운영 KPI 대시보드 | 🟡 진행 | `apps/web/src/app/admin/layout.tsx`, `apps/web/src/app/admin/page.tsx`, `apps/web/src/app/api/v1/admin/users/[id]/role/route.ts`, `services/api/src/modules/admin.ts` | — |  |
| P-173 | P2 | 검증자 간 일치율 측정 | ⬜ 계획 | `services/api/src/modules/admin.ts` | — |  |

## 플랫폼 · 기반

| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |
|---|---|---|---|---|---|---|
| P-180 | P0 | 모노레포 워크스페이스 | 🟡 진행 | `apps/web/next.config.ts`, `apps/web/src/app/app/layout.tsx`, `apps/web/src/app/app/page.tsx`, `apps/web/src/app/layout.tsx` +4 | — |  |
| P-181 | P0 | 마이그레이션 러너 | ✅ 검증 | `infra/scripts/deploy-proplus.sh`, `services/api/src/lib/db.ts`, `services/api/src/migrate.ts` | `services/api/test/identity.test.ts`, `services/api/test/lead.test.ts`, `services/api/test/migrate.test.ts` |  |
| P-182 | P0 | 헬스체크 | ✅ 검증 | `apps/web/src/app/api/v1/health/route.ts`, `infra/scripts/deploy-proplus.sh`, `services/api/src/lib/build.ts`, `services/api/src/migrate.ts` | `services/api/test/migrate.test.ts` |  |
| P-183 | P0 | outbox 이벤트 | ✅ 검증 | `apps/web/src/app/api/v1/me/offers/[id]/route.ts`, `apps/web/src/app/api/v1/me/profile/unpublish/route.ts`, `db/migrations/0001_proplus_core.sql`, `packages/domain/src/events.ts` +11 | `packages/domain/test/events.test.ts`, `services/api/test/identity.test.ts`, `services/api/test/org.test.ts`, `services/api/test/outbox.test.ts` |  |
| P-184 | P0 | idempotent 워커 | ✅ 검증 | `db/migrations/0003_linkos_integration.sql`, `packages/domain/src/events.ts`, `services/api/src/lib/linkosClient.ts`, `services/api/src/lib/outbox.ts` +4 | `packages/domain/test/events.test.ts`, `services/api/test/outbox.test.ts` |  |
| P-185 | P0 | Idempotency-Key 지원 | ✅ 검증 | `db/migrations/0001_proplus_core.sql`, `services/api/src/lib/crypto.ts`, `services/api/src/lib/idempotency.ts` | `services/api/test/idempotency.test.ts` |  |
| P-186 | P0 | 구조화 로그 + trace ID | ✅ 검증 | `packages/domain/src/redact.ts`, `services/api/src/lib/log.ts` | `packages/domain/test/redact.test.ts` | N-13 |
| P-187 | P0 | 에러 응답 규격 | ✅ 검증 | `apps/web/src/app/api/v1/health/route.ts`, `apps/web/src/app/api/v1/me/leads/[id]/route.ts`, `apps/web/src/app/app/evidence/[id]/AppealForm.tsx`, `apps/web/src/app/app/evidence/page.tsx` +12 | `packages/domain/test/redact.test.ts`, `services/api/test/identity.test.ts`, `services/api/test/lead.test.ts`, `services/api/test/org.test.ts` |  |
| P-188 | P0 | CSRF·origin 검사 | ✅ 검증 | `packages/domain/src/origin.ts` | `packages/domain/test/origin.test.ts` |  |
| P-189 | P0 | rate limit 공통 미들웨어 | ✅ 검증 | `apps/web/src/app/api/v1/events/route.ts`, `apps/web/src/app/api/v1/public/profiles/[slug]/route.ts`, `apps/web/src/app/api/v1/public/profiles/[slug]/slots/route.ts`, `apps/web/src/app/api/v1/public/profiles/[slug]/vcard/route.ts` +11 | `packages/domain/test/rateLimit.test.ts`, `services/api/test/lead.test.ts` |  |
| P-190 | P0 | proplus.linkos.com 배포 | ⬜ 계획 | `infra/scripts/deploy-proplus.sh` | — |  |
| P-191 | P0 | 환경 분리 (dev/staging/prod) | ⬜ 계획 | — | — |  |
| P-192 | P0 | 기능 추적성 생성 | ⬜ 계획 | — | — |  |
| P-193 | P0 | 접근성 (WCAG 2.2 AA 목표) | ✅ 검증 | `apps/web/src/app/admin/layout.tsx`, `apps/web/src/app/admin/queue/QueueList.tsx`, `apps/web/src/app/app/layout.tsx`, `apps/web/src/app/login/LoginForm.tsx` +2 | `tests/e2e/publicProfile.spec.ts` |  |
| P-194 | P0 | 공개 프로필 성능 | 🟡 진행 | `apps/web/src/app/api/v1/events/route.ts`, `apps/web/src/app/api/v1/public/profiles/[slug]/route.ts`, `apps/web/src/app/p/[slug]/page.tsx`, `apps/web/src/app/sitemap.ts` +5 | — |  |
| P-195 | P0 | UTC 저장·시간대 표시 | ✅ 검증 | `db/migrations/0001_proplus_core.sql`, `services/api/src/modules/booking.ts` | `services/api/test/booking.test.ts` |  |
| P-196 | P0 | 파일 업로드 보안 | ✅ 검증 | `apps/web/src/app/api/v1/me/evidence/[id]/files/route.ts`, `packages/domain/src/mime.ts`, `services/api/src/lib/storage.ts`, `services/api/src/modules/proof.ts` | `packages/domain/test/mime.test.ts` |  |
| P-197 | P0 | 검색 인덱스 PII 차단 | ✅ 검증 | `services/api/src/modules/search.ts` | `services/api/test/architecture.test.ts`, `services/api/test/search.test.ts` |  |
| P-198 | P0 | 의존성·시크릿 스캔 | ⬜ 계획 | — | — |  |
| P-199 | P1 | 데이터 보존 정책 테이블 | 🟡 진행 | `apps/web/src/app/api/v1/me/route.ts`, `db/migrations/0001_proplus_core.sql`, `services/api/src/modules/billing.ts`, `services/api/src/modules/identity.ts` +1 | — |  |

## 비타협 원칙 커버리지 (전략 §2)

원칙을 건드리는 변경은 해당 기능의 테스트를 함께 바꿔야 한다. 원장 `nonneg` 필드 기준.

| 원칙 | 내용 | 기능 | 테스트 있음 |
|---|---|---|---|
| N-1 | 자기기재는 verified 가 될 수 없다 | P-023, P-054 | 1/2 |
| N-2 | 배지는 결제로 획득할 수 없다 | P-070, P-141 | 2/2 |
| N-3 | 단일 신뢰점수 MVP 제외 | P-032, P-151 | 1/2 |
| N-4 | 공개 API 는 allowlist 필드만 | P-025, P-026, P-029 | 3/3 |
| N-5 | 증거 원본과 공개 배지 분리 저장 | P-052, P-057 | 2/2 |
| N-6 | 검증 상태 변경은 전부 감사로그 | P-065 | 1/1 |
| N-7 | 감사로그는 append-only | P-166 | 1/1 |
| N-8 | 지표는 기간·분모 없이 표시 불가 | P-066, P-111 | 2/2 |
| N-9 | 만료·취소 시 공개 배지 즉시 갱신 | P-059 | 1/1 |
| N-10 | 미니사이트에 사용자 JS 금지 | P-040, P-041, P-042 | 2/3 |
| N-11 | 상담 동의와 마케팅 동의 분리 | P-008, P-101 | 2/2 |
| N-12 | 조직은 개인 프로필을 소유하지 않는다 | P-083, P-084 | 2/2 |
| N-13 | 로그·이벤트에 PII 원문 금지 | P-130, P-186 | 2/2 |
| N-14 | 분쟁 중 확정적 비난 표현 금지 | P-064 | 1/1 |
| N-15 | 유료 노출 구분 + 랭킹 근거 공개 | P-152, P-153 | 2/2 |
