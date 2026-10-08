// F-123 Outgoing webhooks (Zapier/Make/custom) — URL 검증, 재시도 정책. 서명(HMAC-SHA256)은 서비스 계층에서 node:crypto 로 계산.
import type { DomainEventName } from "./events";
import { EVENT_CONSUMERS } from "./events";

export const WEBHOOK_EVENTS = Object.keys(EVENT_CONSUMERS) as DomainEventName[];
export const WEBHOOK_MAX_ATTEMPTS = 8;

/** Exponential backoff: 30s, 60s, 120s … capped at 6h. */
export function webhookRetryDelaySec(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1), 6 * 3600);
}

export function isRetryableStatus(status: number | null): boolean {
  if (status == null) return true; // network error / timeout
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isPrivateIpv4(h: string): boolean {
  const p = h.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p as [number, number, number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** IPv4 embedded in an IPv6 literal: IPv4-mapped (::ffff:), IPv4-compatible (::) and NAT64 (64:ff9b::), dotted or hex form. */
function embeddedIpv4(h: string): string | null {
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) return dotted[1]!;
  // WHATWG URL serializes [::ffff:127.0.0.1] as [::ffff:7f00:1]
  const hex = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (!hex) return null;
  const a = parseInt(hex[1]!, 16);
  const b = parseInt(hex[2]!, 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

export function isPrivateAddress(host: string): boolean {
  // a trailing dot is the same DNS name ("localhost." resolves to loopback)
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (isPrivateIpv4(h)) return true;
  if (h.includes(":")) {
    if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
    const v4 = embeddedIpv4(h);
    if (v4) return isPrivateIpv4(v4);
  }
  return false;
}

/** SSRF guard for user-supplied webhook URLs. `allowPrivate` is only for local development/tests. */
export function validateWebhookUrl(raw: string, opts: { allowPrivate?: boolean } = {}): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (u.username || u.password) return { ok: false, reason: "credentials_in_url" };
  if (u.protocol !== "https:" && !(opts.allowPrivate && u.protocol === "http:")) return { ok: false, reason: "https_required" };
  if (!opts.allowPrivate && isPrivateAddress(u.hostname)) return { ok: false, reason: "private_address" };
  if (u.port && !opts.allowPrivate && !["443", "8443"].includes(u.port)) return { ok: false, reason: "port_not_allowed" };
  return { ok: true, url: u };
}

/** Signed string = `${timestamp}.${body}` (Stripe-style; receivers reject stale timestamps to stop replays). */
export function webhookSigningInput(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}
