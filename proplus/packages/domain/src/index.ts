/**
 * `@proplus/domain` 공개 표면 — P-180 (전략 §3 계층 규칙).
 *
 * 이 패키지는 **I/O 를 하지 않는다.** fetch·fs·pg 를 import 하지 않고, `Date.now()` 대신
 * `now: Date` 를 인자로 받는다. 상태머신·ACL·정책·정규화가 전부 순수 함수라서
 * 비타협 원칙(N-1~N-15)을 단위테스트로 전수 검증할 수 있다 — 그게 이 분리의 목적이다.
 *
 * 배럴을 두는 이유: 상위 계층(`@proplus/api`, `@proplus/web`)이 `src/...` 내부 경로를
 * 직접 집지 않게 한다. 파일을 쪼개거나 합칠 때 호출부가 따라 바뀌지 않아야 한다.
 *
 * 순서는 의존 방향(아래가 위를 쓴다)이 아니라 **주제**다:
 *   타입·증명 → 프로필/공개 DTO → 입력 정규화 → 동의·권한 → 보안 원시함수 → 검색·이벤트
 */

// 기반 타입과 증명(Proof) 엔진 — 이 저장소의 중심이다 (전략 §3 "왜 Proof 가 중앙인가").
export * from "./types";
export * from "./proof";
export * from "./badge";

// 공개 경계 (N-4 allowlist).
export * from "./publicDto";

// 입력 정규화·무해화 (N-10 사용자 JS 금지).
export * from "./slug";
export * from "./sanitize";
export * from "./blockSchema";
export * from "./vcard";
export * from "./mime";

// 동의·지표·권한 (N-11 동의 분리, N-8 지표 공시, N-12 조직은 프로필을 소유하지 않는다).
export * from "./consent";
export * from "./metric";
export * from "./acl";
export * from "./leadStage";
export * from "./plans";
export * from "./completeness";

// 보안 원시함수 (N-13 PII 금지, 보안정책 §2).
export * from "./redact";
export * from "./mask";
export * from "./token";
export * from "./rateLimit";
export * from "./origin";

// 노출 투명성과 이벤트 (N-15, 기술백서 §7).
export * from "./search";
// 직군 간 단순 순위화 금지 (P-071 / 보안정책 §4.9) — search·metric 과 같은 "점수를 만들지 않는다" 계열.
export * from "./ranking";
export * from "./events";

// LINKOS 연동 경계 (ADR-012 / 05_LINKOS_INTEGRATION §1). 오가는 것은 서명된 문자열이고,
// 그 검증은 순수 함수여야 거부 경로를 전수 테스트할 수 있어서 도메인에 있다.
export * from "./ssoAssertion";

// LINKOS 연동의 입력 규칙 (05_LINKOS_INTEGRATION §3 — 이메일 해시 조회).
export * from "./directory";
