// F-180 관찰성 — OpenTelemetry-compatible tracing without an SDK dependency.
// - W3C traceparent propagation (incoming header → server span → response header)
// - spans around route handlers (apps/web/src/lib/server.ts) and DB helpers (q/one/tx)
// - OTLP/HTTP JSON export when OTEL_EXPORTER_OTLP_ENDPOINT is set; a no-op otherwise (one env check per call).
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface SpanContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

export interface Span extends SpanContext {
  parentSpanId: string | null;
  name: string;
  kind: "server" | "internal" | "client";
  startNs: bigint;
  endNs: bigint | null;
  attributes: Record<string, string | number | boolean>;
  error: string | null;
  setAttribute(k: string, v: string | number | boolean): void;
  recordError(e: unknown): void;
}

const als = new AsyncLocalStorage<Span>();
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function tracingEnabled(): boolean {
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) && process.env.OTEL_SDK_DISABLED !== "true";
}

export function parseTraceparent(h: string | null | undefined): SpanContext | null {
  const m = h ? TRACEPARENT.exec(h.trim().toLowerCase()) : null;
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return null;
  return { traceId: m[1]!, spanId: m[2]!, sampled: (parseInt(m[3]!, 16) & 1) === 1 };
}

export function formatTraceparent(s: SpanContext): string {
  return `00-${s.traceId}-${s.spanId}-${s.sampled ? "01" : "00"}`;
}

export function currentSpan(): Span | undefined {
  return als.getStore();
}

/** trace id for log correlation (only when a span is active). */
export function currentTraceId(): string | undefined {
  return als.getStore()?.traceId;
}

const hex = (n: number) => randomBytes(n).toString("hex");
const baseEpochNs = BigInt(Date.now()) * 1_000_000n;
const baseHr = process.hrtime.bigint();
const nowNs = () => baseEpochNs + (process.hrtime.bigint() - baseHr);

function sampleRatio(): number {
  const r = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? 1);
  return Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 1;
}

function makeSpan(name: string, kind: Span["kind"], parent: SpanContext | null, attributes: Span["attributes"]): Span {
  const span: Span = {
    traceId: parent?.traceId ?? hex(16),
    spanId: hex(8),
    sampled: parent ? parent.sampled : Math.random() < sampleRatio(),
    parentSpanId: parent?.spanId ?? null,
    name,
    kind,
    startNs: nowNs(),
    endNs: null,
    attributes: { ...attributes },
    error: null,
    setAttribute(k, v) {
      span.attributes[k] = v;
    },
    recordError(e) {
      span.error = (e as Error)?.message?.slice(0, 300) ?? String(e);
    },
  };
  return span;
}

/**
 * Run fn inside a span. No-op (fn called directly with undefined) when tracing is disabled,
 * or for non-server spans when there is no active parent (avoids orphan DB spans from background code).
 */
export async function withSpan<T>(
  name: string,
  attributes: Span["attributes"],
  fn: (span: Span | undefined) => Promise<T>,
  opts: { kind?: Span["kind"]; traceparent?: string | null } = {},
): Promise<T> {
  if (!tracingEnabled()) return fn(undefined);
  const kind = opts.kind ?? "internal";
  const active = als.getStore();
  const parent: SpanContext | null = active ?? parseTraceparent(opts.traceparent);
  if (!parent && kind !== "server") return fn(undefined);
  const span = makeSpan(name, kind, parent, attributes);
  try {
    return await als.run(span, () => fn(span));
  } catch (e) {
    span.recordError(e);
    throw e;
  } finally {
    span.endNs = nowNs();
    if (span.sampled) enqueue(span);
  }
}

// ---------- OTLP/HTTP JSON exporter ----------
const queue: Span[] = [];
const MAX_QUEUE = 2048;
let timer: NodeJS.Timeout | null = null;

function enqueue(span: Span) {
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(span);
  if (queue.length >= 256) void flushSpans();
  else if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flushSpans();
    }, Number(process.env.OTEL_BSP_SCHEDULE_DELAY ?? 2000));
    timer.unref?.();
  }
}

function endpoint(): string {
  const base = (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").replace(/\/$/, "");
  return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}

function headers(): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  for (const pair of (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[decodeURIComponent(pair.slice(0, i).trim())] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

const KIND = { internal: 1, server: 2, client: 3 } as const;
const attr = (k: string, v: string | number | boolean) =>
  typeof v === "number" ? { key: k, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } } : typeof v === "boolean" ? { key: k, value: { boolValue: v } } : { key: k, value: { stringValue: v } };

export function toOtlp(spans: Span[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", process.env.OTEL_SERVICE_NAME ?? "linkos"), attr("deployment.environment", process.env.NODE_ENV ?? "development")] },
        scopeSpans: [
          {
            scope: { name: "linkos.tracing", version: "1" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: KIND[s.kind],
              startTimeUnixNano: s.startNs.toString(),
              endTimeUnixNano: (s.endNs ?? s.startNs).toString(),
              attributes: Object.entries(s.attributes).map(([k, v]) => attr(k, v)),
              status: s.error ? { code: 2, message: s.error } : { code: 1 },
            })),
          },
        ],
      },
    ],
  };
}

/** Export buffered spans now. Failures are swallowed (telemetry must never break requests). */
export async function flushSpans(): Promise<number> {
  if (!queue.length || !tracingEnabled()) return 0;
  const batch = queue.splice(0, queue.length);
  try {
    const res = await fetch(endpoint(), { method: "POST", headers: headers(), body: JSON.stringify(toOtlp(batch)), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return 0;
    return batch.length;
  } catch {
    return 0;
  }
}
