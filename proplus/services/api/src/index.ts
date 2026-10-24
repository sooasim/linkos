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
