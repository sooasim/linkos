// F-039 앱 근접 교환 / F-040 근접 확인 / F-046 웹-웹 페어링 — 순수 규칙 (I/O 없음).
//
// BLE: 네이티브 앱끼리만. BLE 광고에는 서버가 발급한 짧은 수명의 ephemeral ID 만 실린다(PII 없음).
// 광고 페이로드는 128-bit service UUID 하나 — iOS CBPeripheralManager 가 foreground 에서 광고할 수 있는
// 유일한 필드이므로 ephemeral ID 를 UUID 안에 인코딩한다.
// 브라우저 폰↔폰 BLE/NFC P2P 는 사용하지 않는다(웹은 서버 rendezvous).

/** "LKOS" + version nibble prefix: 4c4b4f53-0001-… */
export const PROXIMITY_UUID_PREFIX = "4c4b4f53-0001";
export const EPHEMERAL_ID_BYTES = 8;
/** server-side lifetime of one ephemeral ID; the app rotates every PROXIMITY_ROTATE_MS */
export const PROXIMITY_ID_TTL_MS = 90_000;
export const PROXIMITY_ROTATE_MS = 30_000;
/** pending match must be confirmed by both people within this window */
export const PROXIMITY_MATCH_TTL_MS = 120_000;

export function generateEphemeralId(): string {
  const b = new Uint8Array(EPHEMERAL_ID_BYTES);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function isEphemeralId(s: string): boolean {
  return new RegExp(`^[0-9a-f]{${EPHEMERAL_ID_BYTES * 2}}$`).test(s);
}

/** 16 hex eph id → 4c4b4f53-0001-XXXX-XXXX-XXXXXXXX0000 */
export function ephemeralIdToServiceUuid(eph: string): string {
  if (!isEphemeralId(eph)) throw new Error("invalid ephemeral id");
  return `${PROXIMITY_UUID_PREFIX}-${eph.slice(0, 4)}-${eph.slice(4, 8)}-${eph.slice(8, 16)}0000`;
}

export function serviceUuidToEphemeralId(uuid: string): string | null {
  const u = uuid.toLowerCase();
  const m = /^4c4b4f53-0001-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{8})0000$/.exec(u);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

export interface RssiSample {
  ephemeralId: string;
  rssi: number;
  at: number;
}

export interface ProximityPolicy {
  /** minimum RSSI (dBm) to count as "phones held close"; ~-60 ≈ < 50cm on most phones */
  rssiThreshold: number;
  /** sliding window */
  windowMs: number;
  /** min strong samples inside the window */
  minSamples: number;
  /** the best candidate must beat the runner-up by this margin (dB) to avoid picking the wrong person in a crowd */
  marginDb: number;
}

export const DEFAULT_PROXIMITY_POLICY: ProximityPolicy = { rssiThreshold: -62, windowMs: 3000, minSamples: 3, marginDb: 6 };

export interface ProximityCandidate {
  ephemeralId: string;
  medianRssi: number;
  samples: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * F-040 근접 확인: pick the single nearby device that is consistently close.
 * Returns `ambiguous` when two devices are similarly close — the UI then asks people to move closer
 * instead of guessing (오접속 차단). Mutual on-screen code confirmation is still required afterwards.
 */
export function evaluateProximity(
  samples: RssiSample[],
  now: number,
  policy: ProximityPolicy = DEFAULT_PROXIMITY_POLICY,
): { status: "none" } | { status: "ambiguous"; candidates: ProximityCandidate[] } | { status: "found"; candidate: ProximityCandidate } {
  const byId = new Map<string, number[]>();
  for (const s of samples) {
    if (now - s.at > policy.windowMs || s.at > now + 1000) continue;
    if (!isEphemeralId(s.ephemeralId) || !Number.isFinite(s.rssi) || s.rssi >= 0) continue;
    const arr = byId.get(s.ephemeralId) ?? [];
    arr.push(s.rssi);
    byId.set(s.ephemeralId, arr);
  }
  const cands: ProximityCandidate[] = [];
  for (const [ephemeralId, rs] of byId) {
    const strong = rs.filter((r) => r >= policy.rssiThreshold);
    if (strong.length < policy.minSamples) continue;
    cands.push({ ephemeralId, medianRssi: median(rs), samples: rs.length });
  }
  cands.sort((a, b) => b.medianRssi - a.medianRssi);
  if (!cands.length) return { status: "none" };
  if (cands.length > 1 && cands[0]!.medianRssi - cands[1]!.medianRssi < policy.marginDb) return { status: "ambiguous", candidates: cands.slice(0, 3) };
  if (cands[0]!.medianRssi < policy.rssiThreshold) return { status: "none" };
  return { status: "found", candidate: cands[0]! };
}

function randomDigits(n: number): string {
  const buf = new Uint32Array(n);
  globalThis.crypto.getRandomValues(buf);
  // 2^32 % 10 bias is negligible (< 1e-9) for display codes
  return Array.from(buf, (v) => String(v % 10)).join("");
}

/** 4-digit code both people compare on screen before a proximity exchange happens. */
export function generateVerifyCode(): string {
  return randomDigits(4);
}

// ---------- F-046 웹-웹 페어링 (server rendezvous) ----------
/** Receiver's "받기 모드" lasts this long; the code is only matchable inside the window. */
export const RENDEZVOUS_TTL_MS = 90_000;
/** After a sender enters the code they must confirm within this window. */
export const RENDEZVOUS_CONFIRM_MS = 60_000;
/** Max wrong codes per exchange session (4 digits is low entropy → tight budget). */
export const RENDEZVOUS_MAX_ATTEMPTS = 8;

export function generateRendezvousCode(): string {
  return randomDigits(4);
}

export function normalizeRendezvousCode(input: string): string | null {
  const s = input.replace(/[\s-]/g, "");
  return /^\d{4}$/.test(s) ? s : null;
}

export type RendezvousStatus = "waiting" | "matched" | "confirmed" | "rejected" | "expired";

export function rendezvousStatusAt(r: { status: RendezvousStatus; expiresAt: Date; matchedAt: Date | null }, now = new Date()): RendezvousStatus {
  if (r.status === "confirmed" || r.status === "rejected") return r.status;
  if (r.status === "matched" && r.matchedAt && now.getTime() - r.matchedAt.getTime() > RENDEZVOUS_CONFIRM_MS) return "expired";
  if (r.status === "waiting" && r.expiresAt.getTime() <= now.getTime()) return "expired";
  return r.status;
}
