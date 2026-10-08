#!/usr/bin/env node
// Dependency vulnerability gate for CI: `pnpm audit --prod --json`, fail on any high/critical advisory that is not in
// .github/audit-allowlist.json (each entry needs a reason and an expiry date — expired entries fail again).
// Usage: node scripts/audit-gate.mjs [--json-file audit.json]   (the file form lets CI/tests run it offline)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const BLOCKING = new Set(["high", "critical"]);

function loadAudit() {
  const i = process.argv.indexOf("--json-file");
  if (i > 0) return JSON.parse(readFileSync(process.argv[i + 1], "utf8"));
  let out;
  try {
    out = execFileSync("pnpm", ["audit", "--prod", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
  } catch (e) {
    out = e.stdout; // pnpm audit exits non-zero when it finds anything; the JSON is still on stdout
  }
  if (!out) throw new Error("pnpm audit produced no output (registry unreachable?)");
  return JSON.parse(out);
}

const allow = JSON.parse(readFileSync(resolve(ROOT, ".github/audit-allowlist.json"), "utf8")).advisories ?? [];
const today = new Date().toISOString().slice(0, 10);
const audit = loadAudit();
const blocking = [];
const accepted = [];
for (const a of Object.values(audit.advisories ?? {})) {
  if (!BLOCKING.has(a.severity)) continue;
  const id = a.github_advisory_id ?? String(a.id);
  const entry = allow.find((x) => x.id === id);
  const line = `${a.severity.toUpperCase()} ${a.module_name}@${a.vulnerable_versions} → ${a.patched_versions} ${id} ${a.url ?? ""}`;
  if (entry && entry.expires >= today) accepted.push(`${line}\n    accepted until ${entry.expires}: ${entry.reason}`);
  else blocking.push(`${line}${entry ? `\n    allowlist entry EXPIRED on ${entry.expires}` : ""}`);
}
if (accepted.length) console.log(`Accepted (time-boxed) advisories:\n${accepted.join("\n")}`);
if (blocking.length) {
  console.error(`\nBlocking high/critical advisories:\n${blocking.join("\n")}\n\nUpgrade, or add a reviewed, time-boxed entry to .github/audit-allowlist.json.`);
  process.exit(1);
}
console.log(`audit-gate: no unaccepted high/critical advisories (${Object.keys(audit.advisories ?? {}).length} advisories total).`);
