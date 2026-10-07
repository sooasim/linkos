// F-052 오프라인 큐 — 네트워크가 없을 때 앱↔앱 교환:
//   1) 보내는 사람: 기기 키로 서명한 Offline Pass 를 화면에 띄운다(교환 사다리의 local_receipt 단계).
//   2) 받는 사람: 앱으로 Pass 를 스캔 → 자기 기기 키로 서명한 Receipt 를 AsyncStorage 큐에 보관.
//   3) 재연결: 큐를 서버로 업로드 → 서버가 두 서명·시간창을 검증하고 (key, receipt id) 기준으로 멱등하게 관계를 만든다.
// Device secrets live only in the OS secure store; receipts in AsyncStorage contain no secret.
import {
  type OfflinePassClaims,
  checkReceiptWindow,
  parseOfflinePass,
  signOfflinePass,
  signOfflineReceipt,
} from "@linkos/domain";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { api } from "./api";

const DEVICE_KEY = "linkos.deviceKey";
const IDENTITY = "linkos.identity";
const QUEUE = "linkos.offlineQueue";
const PASS_TTL_MS = 12 * 60 * 60 * 1000;

interface DeviceKey {
  keyId: string;
  secret: string;
}
export interface CachedIdentity {
  userId: string;
  profileId: string;
  name: string;
}
export interface QueuedReceipt {
  payload: string;
  signature: string;
  receiptId: string;
  senderName: string;
  queuedAt: number;
  lastError?: string;
}

async function readKey(): Promise<DeviceKey | null> {
  const raw = await SecureStore.getItemAsync(DEVICE_KEY);
  return raw ? (JSON.parse(raw) as DeviceKey) : null;
}

/** Register a per-device HMAC key while online (once per install). */
export async function ensureDeviceKey(): Promise<DeviceKey | null> {
  const existing = await readKey();
  if (existing) return existing;
  try {
    const k = await api<DeviceKey>("/devices/exchange-keys", { body: { platform: Platform.OS === "ios" ? "ios" : "android", label: `${Platform.OS} app` } });
    await SecureStore.setItemAsync(DEVICE_KEY, JSON.stringify(k), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
    return k;
  } catch {
    return null;
  }
}

export async function forgetDeviceKey(): Promise<void> {
  const k = await readKey();
  if (k) await api(`/devices/exchange-keys/${encodeURIComponent(k.keyId)}`, { method: "DELETE" }).catch(() => undefined);
  await SecureStore.deleteItemAsync(DEVICE_KEY);
  await AsyncStorage.removeItem(IDENTITY);
}

/** Remember who I am so a pass can be signed while offline. */
export async function cacheIdentity(id: CachedIdentity): Promise<void> {
  await AsyncStorage.setItem(IDENTITY, JSON.stringify(id));
}

async function identity(): Promise<CachedIdentity | null> {
  const raw = await AsyncStorage.getItem(IDENTITY);
  return raw ? (JSON.parse(raw) as CachedIdentity) : null;
}

export async function offlineReady(): Promise<boolean> {
  return Boolean((await readKey()) && (await identity()));
}

function nonce(): string {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Sender: a signed pass to show on screen (works without network). */
export async function issueOfflinePass(): Promise<string> {
  const key = await readKey();
  const me = await identity();
  if (!key || !me) throw new Error("offline_not_ready");
  const now = Date.now();
  const claims: OfflinePassClaims = { v: 1, k: key.keyId, u: me.userId, p: me.profileId, n: me.name.slice(0, 60), iat: now, exp: now + PASS_TTL_MS, r: nonce() };
  return signOfflinePass(claims, key.secret);
}

/** Receiver: scan a pass, sign a receipt with this device's key and queue it for sync. */
export async function receivePass(pass: string, opts: { reciprocate: boolean; placeLabel?: string }): Promise<QueuedReceipt> {
  const parsed = parseOfflinePass(pass.trim());
  if (!parsed) throw new Error("LINKOS 오프라인 패스가 아니에요.");
  const key = await readKey();
  const me = await identity();
  if (!key || !me) throw new Error("오프라인 교환을 쓰려면 한 번 온라인에서 로그인해야 해요.");
  const receiptId = (globalThis.crypto as { randomUUID: () => string }).randomUUID();
  const at = Date.now();
  const claims = { v: 1 as const, id: receiptId, k: key.keyId, pass: pass.trim(), at, rc: opts.reciprocate, ...(opts.placeLabel ? { pl: opts.placeLabel.slice(0, 120) } : {}) };
  const problem = checkReceiptWindow(claims, parsed.claims, me.userId, at);
  if (problem === "self_exchange") throw new Error("내 패스예요. 상대 화면의 패스를 스캔하세요.");
  if (problem) throw new Error("만료된 패스예요. 상대에게 새 패스를 띄워 달라고 하세요.");
  const signed = signOfflineReceipt(claims, key.secret);
  const item: QueuedReceipt = { ...signed, receiptId, senderName: parsed.claims.n, queuedAt: at };
  const q = await pendingReceipts();
  q.push(item);
  await AsyncStorage.setItem(QUEUE, JSON.stringify(q));
  return item;
}

export async function pendingReceipts(): Promise<QueuedReceipt[]> {
  const raw = await AsyncStorage.getItem(QUEUE);
  return raw ? (JSON.parse(raw) as QueuedReceipt[]) : [];
}

type SyncResult = { receiptId: string | null; status: "created" | "duplicate" | "rejected"; reason?: string };

let syncing: Promise<{ synced: number; rejected: number }> | null = null;

/** Upload the queue (idempotent on the server). Rejected receipts are dropped with their reason surfaced once. */
export function syncQueue(): Promise<{ synced: number; rejected: number }> {
  if (syncing) return syncing;
  syncing = (async () => {
    let synced = 0;
    let rejected = 0;
    try {
      const q = await pendingReceipts();
      for (let i = 0; i < q.length; i += 50) {
        const batch = q.slice(i, i + 50);
        const r = await api<{ results: SyncResult[] }>("/exchange/offline-receipts", { body: { receipts: batch.map(({ payload, signature }) => ({ payload, signature })) } });
        const done = new Set<string>();
        r.results.forEach((res, idx) => {
          const item = batch[idx];
          if (!item) return;
          done.add(item.receiptId);
          if (res.status === "rejected") rejected++;
          else synced++;
        });
        const remaining = (await pendingReceipts()).filter((x) => !done.has(x.receiptId));
        await AsyncStorage.setItem(QUEUE, JSON.stringify(remaining));
      }
    } catch {
      /* still offline or server error: keep the queue, retry on the next connectivity change */
    } finally {
      syncing = null;
    }
    return { synced, rejected };
  })();
  return syncing;
}

/** Sync whenever connectivity comes back. Returns an unsubscribe function. */
export function startAutoSync(onSynced?: (r: { synced: number; rejected: number }) => void): () => void {
  return NetInfo.addEventListener((state) => {
    if (state.isConnected && state.isInternetReachable !== false) {
      void syncQueue().then((r) => {
        if (r.synced || r.rejected) onSynced?.(r);
      });
    }
  });
}

export async function isOnline(): Promise<boolean> {
  const s = await NetInfo.fetch();
  return Boolean(s.isConnected && s.isInternetReachable !== false);
}
