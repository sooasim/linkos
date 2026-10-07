"use client";

export class ClientError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

/**
 * JSON API call. Every write carries an Idempotency-Key (generated when the caller gives none) so that when the
 * network is down, whitelisted writes (contacts, notes, encounters, scans, event leads, profile edits) are put in
 * the encrypted offline outbox with the SAME key and replayed on reconnect (F-178/F-179). Such calls reject with
 * ClientError code "queued_offline" so the UI can say "saved on this device".
 */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string; offline?: boolean } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const mutating = method !== "GET" && method !== "HEAD";
  const idempotencyKey = init.idempotencyKey ?? (mutating && init.body !== undefined ? uid() : undefined);
  const queue = async () => {
    if (!mutating || init.offline === false) return false;
    try {
      // the outbox module is lazy-loaded; offline, its chunk may not be cached — then we simply cannot queue
      // (found by the 100-environment matrix: a guest reply sent offline surfaced "Failed to load chunk …")
      const { queueRequest } = await import("./offline");
      return Boolean(await queueRequest({ method, path, body: init.body, idempotencyKey: idempotencyKey ?? uid() }));
    } catch {
      return false;
    }
  };
  let res: Response;
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false && (await queue())) throw new ClientError(0, "queued_offline", OFFLINE_MESSAGE);
    res = await fetch(`/api/v1${path}`, {
      method,
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (e) {
    if (e instanceof ClientError) throw e;
    if (await queue()) throw new ClientError(0, "queued_offline", OFFLINE_MESSAGE);
    throw new ClientError(0, "network_error", "네트워크에 연결할 수 없습니다. 연결 상태를 확인하세요.");
  }
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const d = data as { code?: string; message?: string; details?: unknown };
    throw new ClientError(res.status, d?.code ?? "error", d?.message ?? "요청을 처리하지 못했습니다.", d?.details);
  }
  return data as T;
}

export const OFFLINE_MESSAGE = "오프라인 상태라 이 기기에 암호화해 보관했어요. 연결되면 자동으로 전송됩니다.";

export const isQueuedOffline = (e: unknown) => e instanceof ClientError && e.code === "queued_offline";

/** Raw binary upload (image/audio/PDF) — never queued offline. */
export async function upload<T = any>(path: string, blob: Blob, opts: { method?: "PUT" | "POST"; filename?: string; idempotencyKey?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: opts.method ?? "POST",
      headers: {
        "content-type": blob.type || "application/octet-stream",
        ...(opts.filename ? { "x-file-name": encodeURIComponent(opts.filename) } : {}),
        ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: blob,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ClientError(0, "network_error", "네트워크에 연결할 수 없습니다.");
  }
  const data = (res.headers.get("content-type") ?? "").includes("application/json") ? await res.json() : null;
  if (!res.ok) throw new ClientError(res.status, data?.code ?? "error", data?.message ?? "업로드하지 못했습니다.", data?.details);
  return data as T;
}

export function uid() {
  return crypto.randomUUID();
}

export function fmtDate(d: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  if (!d) return "";
  return new Intl.DateTimeFormat("ko-KR", opts).format(new Date(d));
}

export function relTime(d: string | Date | null | undefined) {
  if (!d) return "";
  const diff = (new Date(d).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return fmtDate(d, { year: "numeric", month: "short", day: "numeric" });
}
