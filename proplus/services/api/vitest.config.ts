import { defineConfig } from "vitest/config";

// 통합테스트는 실제 proplus Postgres 를 공유한다 — 파일을 병렬로 돌리면 트리거·배타제약 테스트가 서로를 깬다.
// 그래서 LINKOS services/api 와 같은 설정을 쓴다 (전략 §9 테스트 피라미드).
export default defineConfig({
  test: { fileParallelism: false, testTimeout: 20000, hookTimeout: 30000 },
});
