#!/usr/bin/env node
// Lightweight SAST for CI (백서 §21 출시 게이트): flags hard-coded secrets, eval/new Function, dangerouslySetInnerHTML
// without a sanitizer, and SQL built by concatenating request input. Zero dependencies; fails (exit 1) on findings.
// Suppress a reviewed line with a trailing comment:  // security-scan: allow <reason>
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const DIRS = ["apps/web/src", "apps/mobile", "services/api/src", "packages/domain/src", "packages/ui", "scripts", "infra"];
const EXT = /\.(m?[jt]sx?|cjs|ya?ml|json|sh|env)$/;
const SKIP_DIR = new Set(["node_modules", ".next", "dist", "build", "coverage", "test", "tests", "__tests__", ".expo"]);
const SKIP_FILE = /(\.test\.|\.spec\.|security-scan\.mjs$|pnpm-lock\.yaml$)/;

/** @type {{ id: string; severity: "high" | "medium"; re: RegExp; why: string; unless?: RegExp }[]} */
const RULES = [
  { id: "secret.private-key", severity: "high", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, why: "private key material in source" },
  { id: "secret.aws-access-key", severity: "high", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, why: "AWS access key id" },
  { id: "secret.vendor-token", severity: "high", re: /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/, why: "vendor API token" },
  {
    id: "secret.assignment",
    severity: "high",
    re: /\b(?:secret|password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|private[_-]?key)\b["']?\s*[:=]\s*["'`][A-Za-z0-9+/_=.-]{20,}["'`]/i,
    unless: /process\.env|example|placeholder|dev-only|ci-only|test-only|changeme|e2e-only|not-for-production/i,
    why: "hard-coded credential literal",
  },
  { id: "code.eval", severity: "high", re: /(?<![\w.])(?:eval\s*\(|new\s+Function\s*\()/, why: "dynamic code execution" },
  {
    id: "xss.dangerouslySetInnerHTML",
    severity: "high",
    re: /dangerouslySetInnerHTML\s*=\s*\{\{?\s*__html\s*:/,
    unless: /__html\s*:\s*(?:escapeHtml|sanitize\w*|DOMPurify\.sanitize|JSON\.stringify|safeJson\w*|serialize\w*)\s*\(/,
    why: "dangerouslySetInnerHTML without a sanitizer/escaper",
  },
  {
    id: "sql.request-concat",
    severity: "high",
    re: /(?:\b(?:q|one|query)\s*(?:<[^>]*>)?\s*\(\s*`[^`]*\$\{\s*(?:req|request|body|params|input|searchParams|sp|query)\b[.[]|\b(?:q|one|query)\s*(?:<[^>]*>)?\s*\(\s*["'][^"']*["']\s*\+\s*(?:req|request|body|params|input|searchParams|sp|query)\b)/,
    why: "SQL text built from request input (use $n parameters)",
  },
];

/** Reviewed exceptions (file + rule) for files where an inline allow comment is not possible/desirable. */
const REVIEWED = [
  { file: "apps/web/src/components/Qr.tsx", rule: "xss.dangerouslySetInnerHTML", reason: "SVG generated locally by the qrcode library from the exchange URL; no user-supplied HTML" },
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.test(name) && !SKIP_FILE.test(p) && st.size < 2_000_000) yield p;
  }
}

/** Scan one file's text; exported shape is used by the self-test (`--self-test`). */
export function scanText(text, file = "<text>") {
  const findings = [];
  text.split("\n").forEach((line, i) => {
    if (/security-scan:\s*allow\b/.test(line)) return;
    for (const r of RULES) {
      if (r.re.test(line) && !(r.unless && r.unless.test(line))) findings.push({ file, line: i + 1, rule: r.id, severity: r.severity, why: r.why });
    }
  });
  return findings;
}

function selfTest() {
  const FAKE_AWS = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""); // assembled so the repo itself contains no key-shaped literal
  const bad = [
    `const k = "${FAKE_AWS}";`,
    'const password = "Sup3rS3cretValueThatIsLong1";',
    "eval(userInput)",
    "<div dangerouslySetInnerHTML={{ __html: html }} />",
    "await q(`SELECT * FROM t WHERE id=${req.query.id}`)",
    'await q("SELECT * FROM t WHERE id=" + params.id)',
  ];
  const good = [
    "const secret = process.env.AUTH_SECRET;",
    "<script dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />",
    "await q(`SELECT * FROM t WHERE id=$1`, [req.query.id])",
    "await q(`SELECT ${cols} FROM t`)",
    `const k = "${FAKE_AWS}"; // security-scan: allow fixture`,
  ];
  const fails = bad.filter((l) => !scanText(l).length).map((l) => `missed: ${l}`).concat(good.filter((l) => scanText(l).length).map((l) => `false positive: ${l}`));
  if (fails.length) {
    console.error(fails.join("\n"));
    process.exit(1);
  }
  console.log(`security-scan self-test ok (${bad.length} positives, ${good.length} negatives)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const findings = [];
    let files = 0;
    for (const d of DIRS) for (const f of walk(join(ROOT, d))) {
      files++;
      const rel = relative(ROOT, f).split("\\").join("/");
      findings.push(...scanText(readFileSync(f, "utf8"), rel).filter((x) => !REVIEWED.some((r) => r.file === x.file && r.rule === x.rule)));
    }
    for (const f of findings) console.log(`${f.severity.toUpperCase()} ${f.rule} ${f.file}:${f.line} — ${f.why}`);
    console.log(`security-scan: ${files} files, ${findings.length} finding(s)`);
    process.exit(findings.some((f) => f.severity === "high") ? 1 : 0);
  }
}
