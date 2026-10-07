"use client";
// F-178 오프라인 캡처(로컬 암호화 큐) / F-052 오프라인 큐 / F-150 오프라인 모드 / F-179 재동기화.
// IndexedDB "linkos-offline": every record is AES-GCM encrypted with a non-extractable device key that is
// itself kept in IndexedDB (CryptoKey objects cannot be exported). Stores:
//   outbox — queued API writes (replayed with their original Idempotency-Key; see @linkos/domain offlineQueue)
//   inbox  — photos waiting for on-device OCR/review (F-012 batch import, offline scans)
// The service worker (public/sw.js) reads the same database for Background Sync replays.
import { type OutboxItem, createOutboxItem, decide, enqueue, readyItems, resolveConflict, summarize } from "@linkos/domain";

const DB_NAME = "linkos-offline";
const DB_VERSION = 1;
export const SYNC_TAG = "linkos-outbox";
export const CHANGE_EVENT = "linkos:offline-change";

type Enc = { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };
interface OutboxRecord {
  id: string;
  createdAt: number;
  enc: Enc;
}
interface InboxRecord {
  id: string;
  createdAt: number;
  enc: Enc;
  blob: Enc | null;
}

// ---------------------------------------------------------------- storage primitives
let dbp: Promise<IDBDatabase | null> | null = null;
const memory = { outbox: new Map<string, OutboxItem>(), inbox: new Map<string, { meta: InboxItem; blob: Blob | null }>() };

function openDb(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle) return resolve(null);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys");
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
      if (!db.objectStoreNames.contains("inbox")) db.createObjectStore("inbox", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbp;
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

let keyP: Promise<CryptoKey> | null = null;
async function deviceKey(db: IDBDatabase): Promise<CryptoKey> {
  if (keyP) return keyP;
  keyP = (async () => {
    const existing = await reqP(db.transaction("keys").objectStore("keys").get("aes")) as CryptoKey | undefined;
    if (existing) return existing;
    const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await reqP(db.transaction("keys", "readwrite").objectStore("keys").put(k, "aes"));
    return k;
  })();
  keyP.catch(() => (keyP = null));
  return keyP;
}

async function encrypt(db: IDBDatabase, bytes: ArrayBuffer): Promise<Enc> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, data: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deviceKey(db), bytes) };
}
async function decrypt(db: IDBDatabase, e: Enc): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: e.iv }, await deviceKey(db), e.data);
}
const encJson = async (db: IDBDatabase, v: unknown) => encrypt(db, new TextEncoder().encode(JSON.stringify(v)).buffer as ArrayBuffer);
const decJson = async <T,>(db: IDBDatabase, e: Enc): Promise<T> => JSON.parse(new TextDecoder().decode(await decrypt(db, e))) as T;

function changed() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  try {
    new BroadcastChannel("linkos-offline").postMessage({ type: "changed" });
  } catch {
    /* not supported */
  }
}

// ---------------------------------------------------------------- outbox
export async function listOutbox(): Promise<OutboxItem[]> {
  const db = await openDb();
  if (!db) return [...memory.outbox.values()];
  const recs = (await reqP(db.transaction("outbox").objectStore("outbox").getAll())) as OutboxRecord[];
  const out: OutboxItem[] = [];
  for (const r of recs) {
    try {
      out.push(await decJson<OutboxItem>(db, r.enc));
    } catch {
      /* key lost (site data partially cleared) — unreadable record */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

async function putOutbox(item: OutboxItem) {
  const db = await openDb();
  if (!db) {
    memory.outbox.set(item.id, item);
    return;
  }
  const rec: OutboxRecord = { id: item.id, createdAt: item.createdAt, enc: await encJson(db, item) };
  await reqP(db.transaction("outbox", "readwrite").objectStore("outbox").put(rec));
}

async function deleteOutbox(id: string) {
  const db = await openDb();
  if (!db) memory.outbox.delete(id);
  else await reqP(db.transaction("outbox", "readwrite").objectStore("outbox").delete(id));
}

async function registerSync() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    await (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } })?.sync?.register(SYNC_TAG);
  } catch {
    /* Background Sync unsupported (Safari/Firefox): we replay on `online` instead */
  }
}

/** Queue a write for later replay. Returns null when the request is not allowed offline. */
export async function queueRequest(input: { method: string; path: string; body: unknown; idempotencyKey: string }): Promise<OutboxItem | null> {
  const item = createOutboxItem({ ...input, id: crypto.randomUUID(), now: Date.now() });
  if (!item) return null;
  const before = await listOutbox();
  const after = enqueue(before, item);
  const merged = after.find((x) => !before.some((b) => b.id === x.id)) ?? after.find((x) => x.path === item.path && x.method === "PATCH");
  if (merged) await putOutbox(merged);
  changed();
  void registerSync();
  return merged ?? item;
}

let flushing: Promise<{ sent: number; remaining: number }> | null = null;

async function send(item: OutboxItem) {
  try {
    const res = await fetch(`/api/v1${item.path}`, {
      method: item.method,
      headers: { "content-type": "application/json", "idempotency-key": item.idempotencyKey, "x-linkos-replay": "1" },
      body: item.body === undefined ? undefined : JSON.stringify(item.body),
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = (res.headers.get("content-type") ?? "").includes("json") ? await res.json().catch(() => null) : null;
    return { status: res.status, body, retryAfterSec: Number(res.headers.get("retry-after")) || null };
  } catch {
    return { networkError: true as const };
  }
}

/** Replay ready items (one flush at a time per tab; Web Locks serialize across tabs when available). */
export function flushOutbox(): Promise<{ sent: number; remaining: number }> {
  if (flushing) return flushing;
  const run = async () => {
    let sent = 0;
    for (let round = 0; round < 20; round++) {
      if (typeof navigator !== "undefined" && navigator.onLine === false) break;
      const items = await listOutbox();
      const ready = readyItems(items, Date.now());
      if (!ready.length) break;
      let offline = false;
      for (const item of ready) {
        const res = await send(item);
        const d = decide(item, res, Date.now(), Math.random());
        if (d.action === "done") {
          await deleteOutbox(item.id);
          sent++;
        } else await putOutbox(d.item);
        if ("networkError" in res) {
          offline = true;
          break;
        }
      }
      changed();
      if (offline) break;
    }
    return { sent, remaining: summarize(await listOutbox()).pending };
  };
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  flushing = (locks ? locks.request(SYNC_TAG, run) : run()).finally(() => {
    flushing = null;
  }) as Promise<{ sent: number; remaining: number }>;
  return flushing;
}

export async function resolveOutboxConflict(id: string, choice: "mine" | "theirs") {
  const item = (await listOutbox()).find((i) => i.id === id);
  if (!item) return;
  const next = resolveConflict(item, choice, Date.now(), crypto.randomUUID());
  if (next) await putOutbox(next);
  else await deleteOutbox(id);
  changed();
  if (next) void flushOutbox();
}

export async function retryOutbox(id: string) {
  const item = (await listOutbox()).find((i) => i.id === id);
  if (!item) return;
  await putOutbox({ ...item, status: "pending", attempts: 0, nextAttemptAt: Date.now(), lastError: null });
  changed();
  void flushOutbox();
}

export async function discardOutbox(id: string) {
  await deleteOutbox(id);
  changed();
}

export async function outboxSummary() {
  return summarize(await listOutbox());
}

// ---------------------------------------------------------------- inbox (photos awaiting OCR / review)
export interface InboxCard {
  idx: number;
  status: "review" | "saved" | "skipped" | "queued_save";
  thumb: string;
  lines: { text: string; confidence: number; bbox?: { x0: number; y0: number; x1: number; y1: number } }[];
  captureId: string | null;
  fields: { key: string; value: string; confidence: number; needsReview?: boolean }[];
  duplicates: { contactId: string; fullName: string; company: string | null; score: number; autoMergeable: boolean }[];
  draft: Record<string, string>;
  contactId?: string | null;
}

export interface InboxItem {
  id: string;
  createdAt: number;
  batchId: string;
  name: string;
  source: "batch" | "offline";
  kind: "card" | "badge";
  split: boolean;
  keepOriginal: boolean;
  langs: string;
  status: "queued" | "processing" | "done" | "error";
  error?: string | null;
  cards: InboxCard[];
}

export async function addToInbox(files: Blob[], opts: { source: InboxItem["source"]; kind?: "card" | "badge"; split?: boolean; keepOriginal?: boolean; langs?: string; names?: string[] }): Promise<string> {
  const db = await openDb();
  const batchId = crypto.randomUUID();
  let t = Date.now();
  for (const [i, f] of files.entries()) {
    const meta: InboxItem = {
      id: crypto.randomUUID(), createdAt: t++, batchId, name: opts.names?.[i] ?? `photo-${i + 1}`, source: opts.source, kind: opts.kind ?? "card",
      split: opts.split ?? false, keepOriginal: opts.keepOriginal ?? false, langs: opts.langs ?? "kor+eng", status: "queued", cards: [],
    };
    if (!db) memory.inbox.set(meta.id, { meta, blob: f });
    else {
      const rec: InboxRecord = { id: meta.id, createdAt: meta.createdAt, enc: await encJson(db, meta), blob: await encrypt(db, await f.arrayBuffer()) };
      await reqP(db.transaction("inbox", "readwrite").objectStore("inbox").put(rec));
    }
  }
  changed();
  return batchId;
}

export async function listInbox(): Promise<InboxItem[]> {
  const db = await openDb();
  if (!db) return [...memory.inbox.values()].map((x) => x.meta).sort((a, b) => a.createdAt - b.createdAt);
  const recs = (await reqP(db.transaction("inbox").objectStore("inbox").getAll())) as InboxRecord[];
  const out: InboxItem[] = [];
  for (const r of recs) {
    try {
      out.push(await decJson<InboxItem>(db, r.enc));
    } catch {
      /* unreadable */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export async function inboxBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return memory.inbox.get(id)?.blob ?? null;
  const rec = (await reqP(db.transaction("inbox").objectStore("inbox").get(id))) as InboxRecord | undefined;
  if (!rec?.blob) return null;
  return new Blob([await decrypt(db, rec.blob)], { type: "image/jpeg" });
}

let inboxChain: Promise<unknown> = Promise.resolve();

/** Read-modify-write of one inbox record; serialized so the processor and the review UI never lose updates. */
export function updateInbox(id: string, patch: Partial<InboxItem> | ((cur: InboxItem) => InboxItem), opts: { dropBlob?: boolean } = {}): Promise<InboxItem | null> {
  const run = inboxChain.then(() => updateInboxNow(id, patch, opts));
  inboxChain = run.catch(() => undefined);
  return run;
}

async function updateInboxNow(id: string, patch: Partial<InboxItem> | ((cur: InboxItem) => InboxItem), opts: { dropBlob?: boolean }): Promise<InboxItem | null> {
  const db = await openDb();
  if (!db) {
    const cur = memory.inbox.get(id);
    if (!cur) return null;
    cur.meta = typeof patch === "function" ? patch(cur.meta) : { ...cur.meta, ...patch };
    if (opts.dropBlob) cur.blob = null;
    changed();
    return cur.meta;
  }
  const store = () => db.transaction("inbox", "readwrite").objectStore("inbox");
  const rec = (await reqP(db.transaction("inbox").objectStore("inbox").get(id))) as InboxRecord | undefined;
  if (!rec) return null;
  const cur = await decJson<InboxItem>(db, rec.enc);
  const next = typeof patch === "function" ? patch(cur) : { ...cur, ...patch };
  await reqP(store().put({ ...rec, enc: await encJson(db, next), blob: opts.dropBlob ? null : rec.blob }));
  changed();
  return next;
}

export async function removeInbox(ids: string[]) {
  const db = await openDb();
  for (const id of ids) {
    if (!db) memory.inbox.delete(id);
    else await reqP(db.transaction("inbox", "readwrite").objectStore("inbox").delete(id));
  }
  changed();
}

/** Remove every offline record (used on sign-out from the sync screen). */
export async function wipeOfflineData() {
  const db = await openDb();
  memory.outbox.clear();
  memory.inbox.clear();
  if (db) {
    await reqP(db.transaction("outbox", "readwrite").objectStore("outbox").clear());
    await reqP(db.transaction("inbox", "readwrite").objectStore("inbox").clear());
  }
  changed();
}

export function onOfflineChange(fn: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(CHANGE_EVENT, fn);
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel("linkos-offline");
    bc.onmessage = () => fn();
  } catch {
    bc = null;
  }
  return () => {
    window.removeEventListener(CHANGE_EVENT, fn);
    bc?.close();
  };
}

export const OFFLINE_QUEUED_MESSAGE = "오프라인 상태라 이 기기에 암호화해 보관했어요. 연결되면 자동으로 전송됩니다.";
