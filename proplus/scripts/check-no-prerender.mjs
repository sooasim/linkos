// N-9 불변식 게이트 — **정적 프리렌더된 HTML 페이지가 있으면 실패한다.**
//
//   사용: node proplus/scripts/check-no-prerender.mjs     (pnpm proplus:build 뒤에)
//
// ## 왜 이 검사가 필요한가
//
// N-9 (보안정책 §4.5): 만료·취소된 배지는 **읽기 시점에** 사라져야 한다. 그래서 공개 조회는
// `public_badge_view` 가 `expires_at > now()` 를 평가하도록 설계했고, 모듈도 `toPublicBadges(now)` 를 거친다.
//
// 그런데 페이지가 **정적 프리렌더되면 그 모든 장치가 무의미해진다.** 빌드 시점(또는 마지막
// 재검증 시점)의 HTML 이 그대로 나가므로, 취소된 소속 배지가 재검증 시각까지 계속 공개된다.
// 즉 이 제품에서 정적 프리렌더는 성능 최적화가 아니라 **신뢰 정보의 지연**이고, 그 지연은
// "확인됨" 이라고 적힌 거짓 정보가 떠 있는 시간이다.
//
// 증상이 고약하다: 빌드·타입체크·테스트가 전부 통과하고 화면도 정상으로 보인다. 틀린 것은
// **데이터의 신선도**뿐이라 사람이 배지를 취소해 보고 기다려야 발견된다.
// 새 페이지를 추가하다 `export const dynamic` 을 빼먹는 순간 조용히 재발하므로 기계로 막는다.
//
// (이 검사는 CSP nonce 를 되살릴 때 한 번 더 중요해진다 — nonce 는 요청마다 달라야 하므로
//  구워 둔 HTML 에는 넣을 수 없다. next.config.ts 의 CSP 주석 참조.)

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, "../apps/web/.next/server/app");

/**
 * Next 가 자체 생성하는 오류 화면은 제외한다. 이 페이지들은 **의도적으로** 정적이고
 * (서버가 죽었을 때도 떠야 한다), 사용자 데이터를 그리지 않으며 하이드레이션이 필요 없다.
 */
const ALLOWED = new Set(["_global-error.html", "_not-found.html"]);

function htmlFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) htmlFiles(p, out);
    else if (name.endsWith(".html") && !ALLOWED.has(name)) out.push(p);
  }
  return out;
}

if (!existsSync(APP_DIR)) {
  console.error(`check-no-prerender: 빌드 출력이 없다 (${APP_DIR}). \`pnpm proplus:build\` 를 먼저 실행하라.`);
  process.exit(1);
}

const found = htmlFiles(APP_DIR);

if (found.length > 0) {
  console.error("check-no-prerender: 정적 프리렌더된 페이지가 있다 — CSP nonce 가 적용되지 않아 하이드레이션이 차단된다.\n");
  for (const f of found) {
    const rel = relative(APP_DIR, f).replace(/\\/g, "/");
    const route = `/${rel.replace(/\.html$/, "").replace(/^index$/, "")}`;
    console.error(`  ${route}   (${rel})`);
  }
  console.error("\n고치는 방법: 해당 page.tsx 에 `export const dynamic = \"force-dynamic\";` 를 추가하고 이유를 주석으로 남겨라.");
  console.error("근거: proplus/apps/web/next.config.ts CSP 주석 · app/page.tsx 주석, 전략 §2 N-9.");
  process.exit(1);
}

console.log("check-no-prerender: 정적 프리렌더된 페이지 없음 — 모든 화면이 요청 시점 데이터로 렌더된다 (N-9).");
