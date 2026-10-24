#!/usr/bin/env node
// PROPLUS 추적성 생성기 — proplus/docs/01_FEATURE_REGISTRY.yaml + proplus/ 아래 코드·테스트에서
// 기능 ID 참조를 수집해 proplus/docs/TRACEABILITY.md 를 만든다.
//
// 왜 이 스크립트가 존재하는가:
//   proplus/CLAUDE.md §1 과 전략 §9 는 "테스트가 없는 기능은 done 으로 표시하지 않는다" 고 못 박았다.
//   사람의 기억으로는 지켜지지 않는다. 그래서 원장 status 와 **실제 테스트 참조**를 대조해
//   어긋난 기능을 경고 섹션에 모아 출력하는 것이 이 스크립트의 본업이다. 표 생성은 부수 효과다.
//
// LINKOS 의 scripts/traceability.mjs 와 같은 방식(원장 → 마크다운 표 + --check 게이트)이지만
// 매핑을 손으로 유지하지 않는다. 손 매핑은 코드가 사라져도 표에 남아 거짓 완료를 만든다 —
// 여기서는 파일을 직접 읽어 기능 ID 주석을 모은다 (근거: proplus/docs/CONTRACTS.md §코드 주석 규칙).
//
// 사용:
//   node proplus/scripts/traceability.mjs              문서 생성
//   node proplus/scripts/traceability.mjs --check      문서를 쓰지 않고 게이트만 검사 (CI)
//   node proplus/scripts/traceability.mjs --out <path> 출력 경로 재지정 (검증용)
//
// --check 실패 조건:
//   (1) 원장 status=done 인데 기능 ID 를 참조하는 테스트가 없다  ← 주 게이트
//   (2) 코드에는 있고 원장에는 없는 기능 ID (원장 누락)
//   (3) 원장이 선언한 test 파일이 실제로 없다
//   (4) meta.total 이 실제 기능 수와 다르다 (조용한 ID 누락 탐지)

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, ".."); // proplus/
const REGISTRY_PATH = resolve(ROOT, "docs/01_FEATURE_REGISTRY.yaml");
const SELF = resolve(HERE, "traceability.mjs"); // 자기 참조 방지: 이 파일은 스캔하지 않는다

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const outFlag = argv.indexOf("--out");
const OUT =
  outFlag >= 0 && argv[outFlag + 1] ? resolve(process.cwd(), argv[outFlag + 1]) : resolve(ROOT, "docs/TRACEABILITY.md");

// docs/ 는 스캔하지 않는다 — 원장·전략 문서 자체가 모든 ID 를 언급하므로 포함하면 전부 "참조됨" 이 된다.
const SCAN_DIRS = ["apps", "packages", "services", "db", "infra", "scripts", "tests"];
const SCAN_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|sql|css|sh|ya?ml|json)$/;
const SKIP_DIR = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo", ".vercel", ".git"]);
const FEATURE_ID = /\bP-\d{3}\b/g;
// 테스트 파일 판정: test/ tests/ __tests__/ e2e/ 디렉터리 안이거나 *.test.* / *.spec.* 파일
const TEST_PATH = /(^|\/)(test|tests|__tests__|e2e)\/|\.(test|spec)\.[a-z]+$/;

const MODULE_TITLE = {
  identity: "M01 · Identity & Access",
  profile: "M02 · Profile & Personal Brand",
  minisite: "M03 · Mini Site",
  proof: "M04 · Proof Engine",
  org: "M05 · Organization & Affiliation",
  catalog: "M06 · Catalog & Offer",
  lead: "M07 · Lead & CRM",
  booking: "M08 · Booking",
  analytics: "M09 · Analytics",
  billing: "M10 · Billing & Plans",
  search: "M11 · Search & Discovery",
  admin: "M12 · Admin, Trust & Safety",
  platform: "플랫폼 · 기반",
};

// 전략 §2 비타협 원칙. 원장의 nonneg 필드가 이 번호를 가리킨다 — 원칙별로 어느 기능이 지키는지 역색인을 만든다.
const NONNEG_LABEL = {
  "N-1": "자기기재는 verified 가 될 수 없다",
  "N-2": "배지는 결제로 획득할 수 없다",
  "N-3": "단일 신뢰점수 MVP 제외",
  "N-4": "공개 API 는 allowlist 필드만",
  "N-5": "증거 원본과 공개 배지 분리 저장",
  "N-6": "검증 상태 변경은 전부 감사로그",
  "N-7": "감사로그는 append-only",
  "N-8": "지표는 기간·분모 없이 표시 불가",
  "N-9": "만료·취소 시 공개 배지 즉시 갱신",
  "N-10": "미니사이트에 사용자 JS 금지",
  "N-11": "상담 동의와 마케팅 동의 분리",
  "N-12": "조직은 개인 프로필을 소유하지 않는다",
  "N-13": "로그·이벤트에 PII 원문 금지",
  "N-14": "분쟁 중 확정적 비난 표현 금지",
  "N-15": "유료 노출 구분 + 랭킹 근거 공개",
};

const STATUS_MARK = { T: "✅ 검증", U: "⚠️ 테스트 없음", I: "🟡 진행", N: "⬜ 계획" };

/** proplus/ 기준 상대경로를 POSIX 구분자로 돌려준다 (win32 에서도 문서가 같게 생성되도록). */
const rel = (abs) => relative(ROOT, abs).split(sep).join("/");

/**
 * 원장의 test 경로를 proplus/ 기준으로 정규화한다.
 * 왜: 원장이 `packages/domain/test/x.test.ts` 와 `proplus/tests/e2e/x.spec.ts` 두 관례를 섞어 쓴다.
 * 둘 다 같은 파일을 가리키므로 여기서 맞춰 준다 — 표기 차이로 "파일 없음" 오경보를 내지 않는다.
 */
const normalizeDeclared = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^proplus\//, "");

/** 긴 목록을 CI 출력·문서에서 접는다. 수백 건이 한 줄로 쏟아지면 아무도 읽지 않는다. */
function capList(items, max = 12) {
  return items.length > max ? `${items.slice(0, max).join(", ")} … +${items.length - max}` : items.join(", ");
}

/** 디렉터리를 재귀 순회해 스캔 대상 파일의 절대경로 목록을 만든다. */
function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc; // 아직 만들어지지 않은 디렉터리는 조용히 건너뛴다 (단계별로 생기는 구조다)
  }
  for (const entry of entries) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) walk(abs, acc);
      continue;
    }
    if (!entry.isFile() || abs === SELF) continue;
    if (SCAN_EXT.test(entry.name)) acc.push(abs);
  }
  return acc;
}

// ── 1. 코드·테스트에서 기능 ID 참조 수집 ──────────────────────────────────────
const files = [];
for (const d of SCAN_DIRS) walk(resolve(ROOT, d), files);

/** id → { code: Set<string>, test: Set<string> } */
const refs = new Map();
const touch = (id) => {
  let e = refs.get(id);
  if (!e) {
    e = { code: new Set(), test: new Set() };
    refs.set(id, e);
  }
  return e;
};
/** 파일별 참조 ID 집합. 선언된 테스트 파일이 ID 를 실제로 표기했는지 확인하는 데 쓴다. */
const idsByFile = new Map();

for (const abs of files) {
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  const found = text.match(FEATURE_ID);
  if (!found) continue;
  const path = rel(abs);
  const ids = new Set(found);
  idsByFile.set(path, ids);
  const bucket = TEST_PATH.test(path) ? "test" : "code";
  for (const id of ids) touch(id)[bucket].add(path);
}

// ── 2. 기능 원장 읽기 ────────────────────────────────────────────────────────
if (!existsSync(REGISTRY_PATH)) {
  console.error(`traceability: 기능 원장을 찾을 수 없다 — ${rel(REGISTRY_PATH)}`);
  process.exit(1);
}
let registry;
try {
  registry = YAML.parse(readFileSync(REGISTRY_PATH, "utf8")) ?? {};
} catch (err) {
  // 원장 YAML 이 깨지면 스택 트레이스가 아니라 고쳐야 할 줄을 알려 준다.
  // 흔한 원인 두 가지: 따옴표 없는 값 안의 "키: 값" 꼴(예: 'javascript: 스킴'),
  // 그리고 예약문자로 시작하는 값(예: '@proplus/web').
  const at = Array.isArray(err?.linePos) && err.linePos[0] ? ` (line ${err.linePos[0].line}, col ${err.linePos[0].col})` : "";
  console.error(`traceability: 기능 원장 YAML 파싱 실패 — ${rel(REGISTRY_PATH)}${at}`);
  console.error(`  ${err?.message ?? err}`);
  console.error("  값에 ': ' 가 들어가거나 @ · % · * · & 로 시작하면 따옴표로 감싸야 한다.");
  process.exit(1);
}
const meta = registry.meta ?? {};

// 원장은 모듈 키별 배열이다 (meta 를 제외한 모든 top-level 키). 원장에 적힌 순서를 그대로 쓴다.
const groups = Object.entries(registry)
  .filter(([key, value]) => key !== "meta" && Array.isArray(value))
  .map(([key, value]) => ({ key, features: value.filter((f) => f && typeof f === "object" && f.id) }));

const features = groups.flatMap((g) => g.features);
const registryIds = new Set(features.map((f) => f.id));

// ── 3. 기능별 상태 판정 ──────────────────────────────────────────────────────
const unverified = []; // status=done 인데 테스트 참조 없음 (주 게이트)
const declaredMissing = []; // 원장이 선언한 test 파일이 없음
const declaredUntagged = []; // 선언한 test 파일은 있는데 그 안에 기능 ID 표기가 없음
const unknownStatus = [];

const rows = new Map(); // id → 표에 쓸 값
for (const f of features) {
  const ref = refs.get(f.id) ?? { code: new Set(), test: new Set() };
  const codePaths = [...ref.code].sort();
  const testPaths = [...ref.test].sort();
  const declared = typeof f.test === "string" && f.test.trim() ? normalizeDeclared(f.test.trim()) : null;

  if (declared) {
    if (!existsSync(resolve(ROOT, declared))) declaredMissing.push({ id: f.id, path: declared });
    else if (!(idsByFile.get(declared)?.has(f.id) ?? false)) declaredUntagged.push({ id: f.id, path: declared });
  }

  let mark;
  if (f.status === "done") mark = testPaths.length ? "T" : "U";
  else if (f.status === "in_progress") mark = "I";
  else if (f.status === "planned") mark = "N";
  else {
    mark = "N";
    unknownStatus.push({ id: f.id, status: String(f.status) });
  }
  if (mark === "U") unverified.push({ id: f.id, name: f.name ?? "", priority: f.priority ?? "", code: codePaths });

  rows.set(f.id, { feature: f, mark, codePaths, testPaths, declared });
}

const orphans = [...refs.keys()].filter((id) => !registryIds.has(id)).sort();
const totalMismatch = typeof meta.total === "number" && meta.total !== features.length ? meta.total : null;

// ── 4. 게이트 (--check) ──────────────────────────────────────────────────────
if (CHECK) {
  const problems = [];
  if (unverified.length)
    problems.push(`status=done 인데 테스트 참조 없음 ${unverified.length}건: ${capList(unverified.map((u) => u.id))}`);
  if (orphans.length) problems.push(`원장에 없는 기능 ID ${orphans.length}건: ${capList(orphans)}`);
  if (declaredMissing.length)
    problems.push(
      `원장이 선언한 테스트 파일 없음 ${declaredMissing.length}건: ${capList(declaredMissing.map((d) => `${d.id}→${d.path}`))}`,
    );
  if (totalMismatch !== null) problems.push(`meta.total=${totalMismatch} 이지만 실제 기능 수는 ${features.length}`);
  if (problems.length) {
    for (const p of problems) console.error(`traceability: ${p}`);
    process.exit(1);
  }
  console.log(`traceability: 기능 ${features.length}개 모두 검증됨 (테스트 참조 확인)`);
  process.exit(0);
}

// ── 5. 문서 생성 ─────────────────────────────────────────────────────────────
const esc = (x) => String(x ?? "").replace(/\|/g, "\\|");
const code = (x) => `\`${String(x)}\``;
/** 경로 목록을 표 셀로. 너무 길어지면 앞 4개만 보이고 나머지는 개수로 접는다. */
function cell(paths) {
  if (!paths.length) return "—";
  const head = paths.slice(0, 4).map(code).join(", ");
  return paths.length > 4 ? `${head} +${paths.length - 4}` : head;
}

const L = [];
L.push("# PROPLUS TRACEABILITY", "");
L.push(
  "> 자동 생성: `pnpm proplus:traceability`. **직접 편집하지 마세요** — 원장(`proplus/docs/01_FEATURE_REGISTRY.yaml`) 또는 코드의 기능 ID 주석을 고치세요.",
  "",
);
L.push(
  `출처 원장: \`proplus/docs/01_FEATURE_REGISTRY.yaml\` (v${meta.version ?? "?"}, 기능 ${features.length}개) · 번들: \`${meta.source_bundle ?? "dd/PROPLUS_Technical_Document_Set"}\``,
  "",
);
L.push(
  "코드·테스트 위치는 손으로 적은 매핑이 아니라 `proplus/` 아래 파일에서 수집한 기능 ID 주석이다 (`// P-0xx: …`).",
  "그래서 코드가 사라지면 이 표에서도 사라진다 — **원장 `status: done` 인데 테스트 참조가 없는 기능은 아래 경고 섹션에 모인다**",
  "(proplus/CLAUDE.md §1 / 전략 §9: 테스트가 없는 기능은 완료로 표시하지 않는다).",
  "",
);

// 요약
const byPriority = ["P0", "P1", "P2", "P3"].filter((p) => features.some((f) => f.priority === p));
L.push("## 요약", "", `| 우선순위 | 전체 | ${STATUS_MARK.T} | ${STATUS_MARK.U} | ${STATUS_MARK.I} | ${STATUS_MARK.N} |`, "|---|---|---|---|---|---|");
const countMark = (list, m) => list.filter((f) => rows.get(f.id)?.mark === m).length;
for (const p of byPriority) {
  const fs = features.filter((f) => f.priority === p);
  L.push(`| ${p} | ${fs.length} | ${countMark(fs, "T")} | ${countMark(fs, "U")} | ${countMark(fs, "I")} | ${countMark(fs, "N")} |`);
}
L.push(
  `| 합계 | ${features.length} | ${countMark(features, "T")} | ${countMark(features, "U")} | ${countMark(features, "I")} | ${countMark(features, "N")} |`,
  "",
);

// 경고 — 이 스크립트의 본업
L.push("## ⚠️ 검증 안 됨 (원장 `status: done` · 테스트 참조 없음)", "");
if (!unverified.length) {
  L.push("없음. `status: done` 인 모든 기능이 기능 ID 를 표기한 테스트에서 참조된다.", "");
} else {
  L.push(
    `**${unverified.length}건.** 전략 §9 기준으로 이 기능들은 "완료"가 아니다 — 테스트를 추가하거나 원장 status 를 내려야 한다.`,
    "",
    "| ID | P | 기능 | 코드 위치 |",
    "|---|---|---|---|",
  );
  for (const u of unverified) L.push(`| ${u.id} | ${u.priority} | ${esc(u.name)} | ${cell(u.code)} |`);
  L.push("");
}

if (orphans.length || declaredMissing.length || declaredUntagged.length || unknownStatus.length || totalMismatch !== null) {
  L.push("## ⚠️ 원장·코드 불일치", "");
  if (orphans.length)
    L.push(
      `- **원장에 없는 기능 ID** (${orphans.length}): ${capList(orphans.map(code))} — 코드에만 있다. 원장에 추가하거나 주석을 고쳐야 한다.`,
    );
  if (declaredMissing.length)
    L.push(
      `- **선언된 테스트 파일 없음** (${declaredMissing.length}): ${capList(declaredMissing.map((d) => `${d.id} → ${code(d.path)}`))}`,
    );
  if (declaredUntagged.length)
    L.push(
      `- **선언된 테스트에 기능 ID 표기 없음** (${declaredUntagged.length}): ${capList(declaredUntagged.map((d) => `${d.id} → ${code(d.path)}`))} — 테스트 이름에 ID 를 적어야 추적된다.`,
    );
  if (unknownStatus.length)
    L.push(`- **알 수 없는 status** (${unknownStatus.length}): ${unknownStatus.map((u) => `${u.id}=${u.status}`).join(", ")}`);
  if (totalMismatch !== null)
    L.push(`- **meta.total 불일치**: 원장 메타는 ${totalMismatch}, 실제 기능 수는 ${features.length}`);
  L.push("");
}

// 모듈별 표
for (const g of groups) {
  if (!g.features.length) continue;
  L.push(`## ${MODULE_TITLE[g.key] ?? g.key}`, "", "| ID | P | 기능 | 상태 | 코드 위치 | 테스트 위치 | 원칙 |", "|---|---|---|---|---|---|---|");
  for (const f of g.features) {
    const r = rows.get(f.id);
    if (!r) continue;
    const nonneg = (Array.isArray(f.nonneg) ? f.nonneg : f.nonneg ? [f.nonneg] : []).join(", ");
    let test = cell(r.testPaths);
    if (r.declared && !r.testPaths.includes(r.declared)) test += ` (원장 선언: ${code(r.declared)})`;
    L.push(
      `| ${f.id} | ${f.priority ?? ""} | ${esc(f.name)} | ${STATUS_MARK[r.mark]} | ${cell(r.codePaths)} | ${test} | ${esc(nonneg)} |`,
    );
  }
  L.push("");
}

// 비타협 원칙 역색인 — 원칙을 건드리는 PR 이 어느 테스트를 함께 바꿔야 하는지 보여준다 (전략 §2).
const nonnegIndex = new Map();
for (const f of features) {
  for (const n of Array.isArray(f.nonneg) ? f.nonneg : f.nonneg ? [f.nonneg] : []) {
    if (!nonnegIndex.has(n)) nonnegIndex.set(n, []);
    nonnegIndex.get(n).push(f);
  }
}
L.push("## 비타협 원칙 커버리지 (전략 §2)", "");
L.push("원칙을 건드리는 변경은 해당 기능의 테스트를 함께 바꿔야 한다. 원장 `nonneg` 필드 기준.", "");
L.push("| 원칙 | 내용 | 기능 | 테스트 있음 |", "|---|---|---|---|");
for (const n of Object.keys(NONNEG_LABEL)) {
  const fs = nonnegIndex.get(n) ?? [];
  const tested = fs.filter((f) => rows.get(f.id)?.testPaths.length).length;
  const ids = fs.length ? fs.map((f) => f.id).join(", ") : "—";
  L.push(`| ${n} | ${esc(NONNEG_LABEL[n])} | ${ids} | ${fs.length ? `${tested}/${fs.length}` : "—"} |`);
}
L.push("");

writeFileSync(OUT, L.join("\n"));
console.log(
  `${rel(OUT)} written — 기능 ${features.length}개 · ✅ ${countMark(features, "T")} · ⚠️ 미검증 ${unverified.length} · 스캔 파일 ${files.length}`,
);
if (unverified.length || orphans.length) console.log("traceability: --check 를 실행하면 위 경고가 게이트로 작동한다");
