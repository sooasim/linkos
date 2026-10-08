// Contract tests (백서 §21 "Contract: OpenAPI, event schema"): the blueprint OpenAPI (04_OPENAPI.yaml) must be served by
// route handlers under apps/web/src/app/api/v1, and every catalog event (06_EVENT_CATALOG.yaml) must exist in
// packages/domain/src/events.ts with the same payload keys. Static checks only — no server, no database.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { EVENT_CONSUMERS } from "@linkos/domain";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = resolve(__dirname, "../../..");
const BLUEPRINT = join(REPO, "dd/LINKOS_Product_Blueprint_v1");
const API_ROOT = join(REPO, "apps/web/src/app/api/v1");
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface Op {
  path: string;
  method: (typeof METHODS)[number];
  operationId: string;
  status: number;
}

const spec = parse(readFileSync(join(BLUEPRINT, "04_OPENAPI.yaml"), "utf8")) as { paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>> };
const ops: Op[] = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({
    path,
    method: m,
    operationId: item[m]!.operationId ?? `${m} ${path}`,
    status: Number(Object.keys(item[m]!.responses ?? {}).find((s) => /^2\d\d$/.test(s)) ?? 200),
  })),
);

/** Resolve "/exchange/sessions/{token}" to a route.ts, accepting any dynamic segment name ([token], [id], …). */
function routeFile(path: string): string | null {
  let dir = API_ROOT;
  for (const seg of path.split("/").filter(Boolean)) {
    if (/^\{.+\}$/.test(seg)) {
      const dyn = existsSync(dir) ? readdirSync(dir).find((d) => /^\[[^.\]]+\]$/.test(d)) : undefined;
      if (!dyn) return null;
      dir = join(dir, dyn);
    } else dir = join(dir, seg);
  }
  const f = join(dir, "route.ts");
  return existsSync(f) ? f : null;
}

function exportsMethod(src: string, method: string): boolean {
  const M = method.toUpperCase();
  return new RegExp(`export\\s+(const|async\\s+function|function)\\s+${M}\\b`).test(src) || new RegExp(`export\\s*\\{[^}]*\\bas\\s+${M}\\b[^}]*\\}`).test(src);
}

/** 2xx statuses one exported method can answer with: route(..., { status }) / NextResponse.json(..., { status }); default 200. */
function declaredStatuses(src: string, method: string): Set<number> {
  const starts = [...src.matchAll(/export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)];
  const i = starts.findIndex((m) => m[1] === method.toUpperCase());
  const block = i < 0 ? src : src.slice(starts[i]!.index, starts[i + 1]?.index ?? src.length);
  const found = new Set([...block.matchAll(/status:\s*(2\d\d)\b/g)].map((m) => Number(m[1])));
  if (!found.size) found.add(200);
  return found;
}

/**
 * Known, documented deviations from the blueprint status codes (not silently accepted: a new deviation fails).
 * - createRecording: 201 + upload URL (the recording row exists synchronously; processing is async afterwards).
 * (Semantic, not status-code, deviation: exportMyData answers 202 but returns the export synchronously in the body
 *  instead of queueing a job — tracked in the report, not asserted here.)
 */
const KNOWN_STATUS_DEVIATIONS: Record<string, number> = { createRecording: 201 };

describe("OpenAPI contract (04_OPENAPI.yaml ↔ apps/web/src/app/api/v1)", () => {
  it("parses the blueprint", () => {
    expect(ops.length).toBeGreaterThanOrEqual(25);
  });

  it.each(ops.map((o) => [`${o.method.toUpperCase()} ${o.path} (${o.operationId})`, o] as const))("%s has a route handler", (_n, o) => {
    const f = routeFile(o.path);
    expect(f, `missing route file for ${o.path}`).not.toBeNull();
    expect(exportsMethod(readFileSync(f!, "utf8"), o.method), `${f} does not export ${o.method.toUpperCase()}`).toBe(true);
  });

  it.each(ops.map((o) => [`${o.operationId} → ${o.status}`, o] as const))("%s success status matches (or is a documented deviation)", (_n, o) => {
    const f = routeFile(o.path);
    if (!f) return; // reported by the previous test
    const statuses = declaredStatuses(readFileSync(f, "utf8"), o.method);
    const deviation = KNOWN_STATUS_DEVIATIONS[o.operationId];
    if (deviation !== undefined) {
      expect(statuses.has(o.status), `${o.operationId} now matches the blueprint — remove it from KNOWN_STATUS_DEVIATIONS`).toBe(false);
      expect(statuses.has(deviation)).toBe(true);
    } else {
      expect(statuses.has(o.status), `${o.operationId}: blueprint says ${o.status}, route declares ${[...statuses].join("/")}`).toBe(true);
    }
  });
});

describe("Event catalog contract (06_EVENT_CATALOG.yaml ↔ packages/domain/src/events.ts)", () => {
  const catalog = (parse(readFileSync(join(BLUEPRINT, "06_EVENT_CATALOG.yaml"), "utf8")) as { events: { name: string; consumers: string[]; payload: string }[] }).events;
  const eventsSrc = readFileSync(join(REPO, "packages/domain/src/events.ts"), "utf8");

  it.each(catalog.map((e) => [e.name, e] as const))("%s exists with the catalog payload keys and consumers", (name, e) => {
    expect(Object.keys(EVENT_CONSUMERS)).toContain(name);
    expect(EVENT_CONSUMERS[name as keyof typeof EVENT_CONSUMERS]).toEqual(e.consumers);
    const line = eventsSrc.split("\n").find((l) => l.includes(`"${name}":`) && l.includes("{"));
    expect(line, `DomainEvents is missing ${name}`).toBeTruthy();
    const keys = [...line!.matchAll(/(\w+)\??:\s/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual(e.payload.split(",").map((s) => s.trim()).sort());
  });

  it("the domain declares no event outside the catalog", () => {
    expect(Object.keys(EVENT_CONSUMERS).sort()).toEqual(catalog.map((e) => e.name).sort());
  });

  it("every catalog event is consumed by the worker (dispatch case or catalog consumer)", () => {
    const worker = readFileSync(join(REPO, "services/api/src/worker.ts"), "utf8");
    const consumers = readFileSync(join(REPO, "services/api/src/modules/consumers.ts"), "utf8");
    const inProcess = new Set([
      "exchange.channel.attempted", // consumers=[analytics]: read from exchange_attempts / outbox directly
      "meeting.transcript.ready", // ai-orchestrator runs right after the emitting transaction (recording.completeTranscripts + retry loop)
    ]);
    for (const e of catalog) {
      if (inProcess.has(e.name)) continue;
      expect(worker.includes(`case "${e.name}"`) || consumers.includes(`case "${e.name}"`), `${e.name} has no consumer`).toBe(true);
    }
  });
});
