// 기능 원장 status 정화 — proplus/CLAUDE.md §1 / 전략 §9
//
//   "테스트가 없는 기능은 done 으로 표시하지 않는다."
//
// 사람이 156개 항목의 status 를 손으로 맞추면 반드시 틀린다. 그래서 추적성 스크립트가
// 수집한 **실제 코드·테스트 참조**를 기준으로 원장을 고친다.
//
//   사용: node proplus/scripts/reconcile-registry.mjs [--dry]
//
// 판정 규칙 (traceability.mjs 와 같은 수집 결과를 쓴다):
//   테스트 참조 있음           → done
//   코드만 있음                → in_progress   (구현됐지만 검증되지 않음 — 정직한 중간 상태)
//   코드·테스트 모두 없음      → planned
//
// 이미 planned 인 항목은 올리지 않는다(아직 손대지 않기로 한 것을 "진행 중"으로 바꾸면 거짓이 된다).
// status 외의 필드는 건드리지 않는다 — 줄 단위로 치환하므로 주석·순서·따옴표가 보존된다.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const PROPLUS = resolve(here, "..");
const REGISTRY = join(PROPLUS, "docs", "01_FEATURE_REGISTRY.yaml");
const DRY = process.argv.slice(2).includes("--dry");

const ID_RE = /\bP-\d{3}\b/g;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".turbo"]);
const EXT = /\.(ts|tsx|mjs|js|sql|yaml|yml|md)$/;

/** proplus/ 아래 모든 소스를 훑어 P-ID → 파일 목록을 만든다. */
function collect(dir, out = new Map()) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      collect(p, out);
      continue;
    }
    if (!EXT.test(name)) continue;
    // 원장 자신과 생성물은 세지 않는다 — 그러면 모든 ID 가 "참조됨"이 된다.
    if (p === REGISTRY) continue;
    if (p.endsWith("TRACEABILITY.md")) continue;
    const text = readFileSync(p, "utf8");
    for (const id of new Set(text.match(ID_RE) ?? [])) {
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(p);
    }
  }
  return out;
}

const refs = collect(PROPLUS);

/** 테스트 파일인가. 경로로만 판단한다(파일 내용에 의존하면 규칙이 흐려진다). */
const isTest = (p) => /[\\/]test[\\/]|[\\/]tests[\\/]|\.test\.|\.spec\./.test(p);

/**
 * **구현** 근거로 셀 수 있는 파일인가.
 *
 * 문서(.md)·원장(.yaml) 의 언급은 구현이 아니다. 전략 문서와 기능 리스트가 모든 ID 를
 * 한 번씩 적고 있으므로, 문서를 근거로 세면 **156개 전부가 "구현됨"** 이 되어 이 스크립트가
 * 아무것도 걸러내지 못한다. (처음 돌렸을 때 실제로 그랬다 — MFA(P-006)처럼 코드가 한 줄도 없는
 * 기능이 in_progress 로 올라갔다.)
 */
const isCode = (p) => /\.(ts|tsx|mjs|js|sql)$/.test(p) && !isTest(p);

const raw = readFileSync(REGISTRY, "utf8");
const doc = parse(raw);

/** 원장에 적힌 모든 항목 (meta 제외). */
const entries = [];
for (const [group, items] of Object.entries(doc)) {
  if (group === "meta" || !Array.isArray(items)) continue;
  for (const it of items) if (it?.id) entries.push(it);
}

const decided = new Map();
for (const it of entries) {
  const files = refs.get(it.id) ?? [];
  const tested = files.some(isTest);
  const coded = files.some(isCode);
  const from = it.status ?? "planned";

  let next;
  if (tested) next = "done";
  else if (coded) next = "in_progress";
  else next = "planned";

  /**
   * **planned 는 자동으로 올리지 않는다.**
   *
   * 이 스크립트의 일은 "완료라고 적힌 것이 정말 완료인가" 를 내리는 것뿐이다. 반대 방향
   * (계획 → 진행 중)은 사람이 판단할 일이다 — TODO 주석 한 줄이나 어댑터 인터페이스만 있어도
   * 코드 참조가 잡히는데, 그걸 "진행 중"으로 바꾸면 전략 §8 이 **의도적으로 비워 둔** 것들
   * (결제 연동·본인인증 사업자·거래 데이터 제공원)이 착수된 것처럼 보인다.
   */
  if (from === "planned") next = "planned";

  decided.set(it.id, { from, to: next, code: files.filter(isCode).length, tests: files.filter(isTest).length });
}

// ── YAML 을 줄 단위로 고친다 ────────────────────────────────────────────────
// 각 항목은 `  - id: P-0xx` 로 시작하고 그 아래 들여쓰기 블록에 `status:` 가 있다.
const lines = raw.split("\n");
let current = null;
let changed = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const idm = /^\s*-\s*id:\s*(P-\d{3})\s*$/.exec(line);
  if (idm) {
    current = idm[1];
    continue;
  }
  if (!current) continue;
  const sm = /^(\s*)status:\s*(\S+)\s*$/.exec(line);
  if (!sm) continue;
  const d = decided.get(current);
  current = null;
  if (!d || sm[2] === d.to) continue;
  lines[i] = `${sm[1]}status: ${d.to}`;
  changed++;
}

const summary = { done: 0, in_progress: 0, planned: 0 };
for (const d of decided.values()) summary[d.to]++;

const moved = [...decided.entries()].filter(([, d]) => d.from !== d.to);

console.log(`원장 ${entries.length}개 → done ${summary.done} · in_progress ${summary.in_progress} · planned ${summary.planned}`);
console.log(`status 변경 ${changed}건`);
for (const [id, d] of moved) console.log(`  ${id}: ${d.from} → ${d.to} (코드 ${d.code} · 테스트 ${d.tests})`);

if (DRY) {
  console.log("--dry: 파일을 쓰지 않았다");
} else if (changed > 0) {
  writeFileSync(REGISTRY, lines.join("\n"));
  console.log(`\n${REGISTRY} 갱신. 이제 \`node proplus/scripts/traceability.mjs\` 를 다시 돌려라.`);
} else {
  console.log("변경 없음 — 원장이 이미 실제 상태와 일치한다");
}
