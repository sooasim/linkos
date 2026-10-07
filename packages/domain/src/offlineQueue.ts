// F-178 오프라인 캡처 / F-150 오프라인 모드 / F-052 오프라인 큐 / F-179 재동기화:
// pure outbox logic shared by the PWA page and the service worker contract.
// Every queued write carries an Idempotency-Key fixed at enqueue time, so a replay after a lost response
// can never create a duplicate. Ordering is preserved per entity; 409 version_conflict parks the item for
// the user to resolve (mine / theirs); other client errors fail permanently and stay visible.

export type OutboxKind = "scan" | "contact" | "contact_update" | "note" | "encounter" | "event_lead" | "profile_update";
export type OutboxMethod = "POST" | "PATCH" | "PUT" | "DELETE";
export type OutboxStatus = "pending" | "conflict" | "failed";

export interface OutboxItem {
  id: string;
  kind: OutboxKind;
  method: OutboxMethod;
  /** API path below /api/v1 */
  path: string;
  body: unknown;
  idempotencyKey: string;
  /** writes to the same entity replay strictly in order */
  entityKey: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: OutboxStatus;
  lastError?: { status: number; code: string; message: string } | null;
  conflict?: { serverVersion: number | null; current: unknown } | null;
}

/** Writes that may be queued offline (everything else must fail fast so the user knows). */
export const QUEUEABLE: { method: OutboxMethod; re: RegExp; kind: OutboxKind; entity: (m: RegExpMatchArray) => string }[] = [
  { method: "POST", re: /^\/capture\/commit$/, kind: "scan", entity: () => "new" },
  { method: "POST", re: /^\/contacts$/, kind: "contact", entity: () => "new" },
  { method: "PATCH", re: /^\/contacts\/([0-9a-f-]{36})$/, kind: "contact_update", entity: (m) => `contact:${m[1]}` },
  { method: "POST", re: /^\/contacts\/([0-9a-f-]{36})\/notes$/, kind: "note", entity: (m) => `note:contact:${m[1]}` },
  { method: "POST", re: /^\/contacts\/([0-9a-f-]{36})\/encounters$/, kind: "encounter", entity: (m) => `encounter:contact:${m[1]}` },
  { method: "POST", re: /^\/events\/([0-9a-f-]{36})\/leads$/, kind: "event_lead", entity: (m) => `event:${m[1]}` },
  { method: "PATCH", re: /^\/profiles\/([0-9a-f-]{36})$/, kind: "profile_update", entity: (m) => `profile:${m[1]}` },
];

export function classifyRequest(method: string, path: string): { kind: OutboxKind; entityKey: string } | null {
  const p = path.split("?")[0]!;
  for (const q of QUEUEABLE) {
    if (q.method !== method.toUpperCase()) continue;
    const m = p.match(q.re);
    if (m) return { kind: q.kind, entityKey: q.entity(m) };
  }
  return null;
}

export function createOutboxItem(input: { id: string; method: string; path: string; body: unknown; idempotencyKey: string; now: number }): OutboxItem | null {
  const c = classifyRequest(input.method, input.path);
  if (!c) return null;
  return {
    id: input.id,
    kind: c.kind,
    method: input.method.toUpperCase() as OutboxMethod,
    path: input.path,
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    entityKey: c.entityKey === "new" ? `new:${input.id}` : c.entityKey,
    createdAt: input.now,
    attempts: 0,
    nextAttemptAt: input.now,
    status: "pending",
    lastError: null,
    conflict: null,
  };
}

/**
 * Enqueue with coalescing: a PATCH to an entity that already has a not-yet-sent PATCH (attempts = 0) is merged
 * into it (later fields win, the original base `version` is kept) so a reconnect sends one consistent update.
 */
export function enqueue(items: OutboxItem[], item: OutboxItem): OutboxItem[] {
  if (item.method === "PATCH") {
    const idx = items.findIndex((x) => x.method === "PATCH" && x.path === item.path && x.status === "pending" && x.attempts === 0);
    if (idx >= 0) {
      const prev = items[idx]!;
      const prevBody = (prev.body ?? {}) as Record<string, unknown>;
      const nextBody = { ...prevBody, ...((item.body ?? {}) as Record<string, unknown>) };
      if ("version" in prevBody) nextBody.version = prevBody.version;
      // The body changed, so this is a different request: it takes the new write's Idempotency-Key. Re-using the old key
      // with a different body is refused by the server (409 idempotency_key_reused) and would drop the merged change
      // when the first attempt was already in flight.
      const merged: OutboxItem = { ...prev, body: nextBody, idempotencyKey: item.idempotencyKey };
      return items.map((x, i) => (i === idx ? merged : x));
    }
  }
  return [...items, item];
}

/** Items to send now, oldest first; an entity waits while an earlier write for it is unresolved. */
export function readyItems(items: OutboxItem[], now: number): OutboxItem[] {
  const sorted = [...items].sort((a, b) => a.createdAt - b.createdAt);
  const blocked = new Set<string>();
  const out: OutboxItem[] = [];
  for (const it of sorted) {
    if (blocked.has(it.entityKey)) continue;
    if (it.status === "pending" && it.nextAttemptAt <= now) out.push(it);
    // anything not finished blocks later writes to the same entity (incl. a pending one we just picked)
    blocked.add(it.entityKey);
  }
  return out;
}

export const MAX_ATTEMPTS = 12;

/** Exponential backoff 2s → 5min with ±20% jitter (`rand` in [0,1) for determinism in tests). */
export function backoffMs(attempts: number, rand = 0.5): number {
  const base = Math.min(5 * 60_000, 2000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.8 + 0.4 * rand));
}

export type ReplayResponse = { networkError: true } | { status: number; body?: unknown; retryAfterSec?: number | null };

export type ReplayDecision =
  | { action: "done" }
  | { action: "retry"; item: OutboxItem }
  | { action: "conflict"; item: OutboxItem }
  | { action: "failed"; item: OutboxItem };

/** Decide what to do with an item after one replay attempt. */
export function decide(item: OutboxItem, res: ReplayResponse, now: number, rand = 0.5): ReplayDecision {
  const attempts = item.attempts + 1;
  const retry = (status: number, code: string, message: string, delay?: number): ReplayDecision => {
    if (attempts >= MAX_ATTEMPTS) return { action: "failed", item: { ...item, attempts, status: "failed", lastError: { status, code, message } } };
    return { action: "retry", item: { ...item, attempts, nextAttemptAt: now + (delay ?? backoffMs(attempts, rand)), lastError: { status, code, message } } };
  };
  if ("networkError" in res) return retry(0, "network", "network unavailable");
  const body = (res.body ?? {}) as { code?: string; message?: string; details?: { serverVersion?: number; current?: unknown } };
  const code = body.code ?? `http_${res.status}`;
  const message = body.message ?? "";
  if (res.status >= 200 && res.status < 300) return { action: "done" };
  if (res.status === 409 && code === "version_conflict") {
    return {
      action: "conflict",
      item: { ...item, attempts, status: "conflict", lastError: { status: 409, code, message }, conflict: { serverVersion: body.details?.serverVersion ?? null, current: body.details?.current ?? null } },
    };
  }
  if (res.status === 429) return retry(429, code, message, res.retryAfterSec ? res.retryAfterSec * 1000 : undefined);
  if (res.status >= 500 || res.status === 408) return retry(res.status, code, message);
  // signed out: keep the item (it is retried once the user signs in again), but do not burn attempts quickly
  if (res.status === 401) return retry(401, code, message, 60_000);
  return { action: "failed", item: { ...item, attempts, status: "failed", lastError: { status: res.status, code, message } } };
}

export type SettleAction = { action: "delete" } | { action: "put"; item: OutboxItem } | { action: "keep" };

/**
 * Apply a replay decision to the outbox record as it is stored *now*. When the record changed while its request was in
 * flight (a later PATCH was coalesced into it, which gives it a new Idempotency-Key) or was discarded meanwhile, the
 * stored record wins: it is still pending and is sent on the next round, so the coalesced change is never lost.
 */
export function settle(stored: OutboxItem | null | undefined, sent: OutboxItem, d: ReplayDecision): SettleAction {
  if (!stored || stored.idempotencyKey !== sent.idempotencyKey) return { action: "keep" };
  return d.action === "done" ? { action: "delete" } : { action: "put", item: d.item };
}

/**
 * Resolve a parked version conflict. "mine" re-sends the local change on top of the server version
 * (new idempotency key: it is a new request); "theirs" drops the local change.
 */
export function resolveConflict(item: OutboxItem, choice: "mine" | "theirs", now: number, newIdempotencyKey: string): OutboxItem | null {
  if (choice === "theirs") return null;
  const body = { ...((item.body ?? {}) as Record<string, unknown>) };
  if (item.conflict?.serverVersion != null) body.version = item.conflict.serverVersion;
  return { ...item, body, status: "pending", attempts: 0, nextAttemptAt: now, idempotencyKey: newIdempotencyKey, conflict: null, lastError: null };
}

/** Fields whose local value differs from the server's current record (for the conflict screen). */
export function conflictFields(mine: Record<string, unknown>, server: Record<string, unknown> | null | undefined): { field: string; mine: unknown; server: unknown }[] {
  if (!server) return [];
  return Object.keys(mine)
    .filter((k) => k !== "version" && k !== "provenance")
    .filter((k) => (mine[k] ?? null) !== (server[k] ?? null))
    .map((k) => ({ field: k, mine: mine[k] ?? null, server: server[k] ?? null }));
}

export function summarize(items: OutboxItem[]): { pending: number; conflicts: number; failed: number } {
  return {
    pending: items.filter((i) => i.status === "pending").length,
    conflicts: items.filter((i) => i.status === "conflict").length,
    failed: items.filter((i) => i.status === "failed").length,
  };
}
