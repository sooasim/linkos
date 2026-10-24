// @proplus/api 배럴. 라우트 핸들러(`apps/web/src/app/api/v1/**`)는 여기서만 가져온다 —
// 모듈 내부 파일을 직접 import 하면 계층 규칙(전략 §3)이 조용히 무너진다.
//
// 모듈 이름은 기술백서 §2 의 모듈 경계와 1:1 이다. 11개를 전부 적어 두는 이유:
// 새 모듈을 "임의 이름"으로 추가하는 경로를 막고, 누가 어느 파일을 담당하는지 이 목록이 말해 준다.

export * from "./lib/db";
export * from "./lib/errors";
export * from "./lib/log";
export * from "./lib/ctx";
export * from "./lib/audit";
export * from "./lib/outbox";
export * from "./lib/idempotency";
export * from "./lib/limits";
export * from "./lib/storage";
export * from "./lib/mail";
export * from "./lib/crypto";
export * from "./lib/build";
// 서버 간 API 키 (05_LINKOS_INTEGRATION §3). 인증 수단이므로 모듈이 아니라 lib 이다.
export * from "./lib/apiKeys";
export { MIGRATIONS_DIR, MIGRATION_LOCK, appliedMigrationCount, migrate } from "./migrate";

// 모듈은 네임스페이스로 내보낸다: `identity.login(...)` 처럼 호출부에서 어느 경계를 넘는지 보이게 하려는 것이다.
export * as identity from "./modules/identity";
export * as profile from "./modules/profile";
export * as proof from "./modules/proof";
export * as org from "./modules/org";
export * as lead from "./modules/lead";
export * as catalog from "./modules/catalog";
export * as booking from "./modules/booking";
export * as analytics from "./modules/analytics";
export * as admin from "./modules/admin";
export * as billing from "./modules/billing";
export * as search from "./modules/search";

// 연동 경계 모듈. 기술백서 §2 의 11개 모듈과 달리 **제품 경계를 넘는** 쪽이라 이름에 상대 제품을 적는다
// (ADR-012 / 05_LINKOS_INTEGRATION). HTTP 계약만 다루고 LINKOS DB·패키지는 건드리지 않는다.
export * as linkosSso from "./modules/linkosSso";
// LINKOS 연동 (05_LINKOS_INTEGRATION §3 — 이메일 해시로 공개 배지 조회).
export * as directory from "./modules/directory";
// LINKOS 연동 (05_LINKOS_INTEGRATION §2 — 리드 전달 + opt-in 설정).
export * as integration from "./modules/integration";
