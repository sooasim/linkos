// API client for native: bearer session token (stored in the OS keychain/keystore via expo-secure-store).
// The server binds bearer tokens to client_kind='native'; they are never accepted as cookies (and vice versa).
import * as SecureStore from "expo-secure-store";
import { API_ORIGIN, APP_USER_AGENT } from "./config";

const TOKEN_KEY = "linkos.session";
/** guest claim token from an in-app guest reply (AsyncStorage) — claimed right after login (F-003) */
export const PENDING_CLAIM_KEY = "linkos.pendingClaim";
const REFRESHED_AT_KEY = "linkos.session.refreshedAt";
const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let memToken: string | null | undefined;
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function getToken(): Promise<string | null> {
  if (memToken !== undefined) return memToken;
  memToken = await SecureStore.getItemAsync(TOKEN_KEY);
  return memToken;
}

export async function setToken(token: string | null): Promise<void> {
  memToken = token;
  if (token) {
    await SecureStore.setItemAsync(TOKEN_KEY, token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
    await SecureStore.setItemAsync(REFRESHED_AT_KEY, String(Date.now()));
  } else {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(REFRESHED_AT_KEY);
  }
}

export interface RequestInit2 {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  auth?: boolean;
  signal?: AbortSignal;
}

export async function api<T = unknown>(path: string, init: RequestInit2 = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { accept: "application/json", "user-agent": APP_USER_AGENT };
  if (method !== "GET" && method !== "DELETE") headers["content-type"] = "application/json";
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  const token = init.auth === false ? null : await getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_ORIGIN}/api/v1${path}`, {
    method,
    headers,
    // the server rejects an empty JSON body; always send an object for mutations
    body: method !== "GET" && method !== "DELETE" ? JSON.stringify(init.body ?? {}) : undefined,
    signal: init.signal,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { code?: string; message?: string; details?: unknown };
    if (res.status === 401 && token) onUnauthorized?.();
    throw new ApiError(res.status, d.code ?? "error", d.message ?? "요청을 처리하지 못했습니다.", d.details);
  }
  return data as T;
}

/** F-007: rotate the native session token periodically (old token stops working immediately on the server). */
export async function maybeRefreshSession(): Promise<void> {
  const token = await getToken();
  if (!token) return;
  const at = Number((await SecureStore.getItemAsync(REFRESHED_AT_KEY)) ?? 0);
  if (Date.now() - at < REFRESH_EVERY_MS) return;
  const r = await api<{ sessionToken: string }>("/auth/token/refresh", { body: {} });
  await setToken(r.sessionToken);
}

export function newIdempotencyKey(): string {
  return (globalThis.crypto as { randomUUID: () => string }).randomUUID();
}
