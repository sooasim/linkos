// 백서 3.1 교환 상태 머신 (F-037~F-052, F-053~F-064)
export const EXCHANGE_STATES = [
  "CREATED",
  "DISCOVERING",
  "CHANNEL_SELECTED",
  "OFFERED",
  "RECEIVER_OPENED",
  "CONSENT_PENDING",
  "EXCHANGED",
  "CLAIM_PENDING",
  "CLAIMED",
  "SYNCED",
  "CHANNEL_FAILED",
  "EXPIRED",
  "REVOKED",
  "CANCELLED",
] as const;
export type ExchangeState = (typeof EXCHANGE_STATES)[number];

const TERMINAL: ReadonlySet<ExchangeState> = new Set(["EXPIRED", "REVOKED", "CANCELLED", "SYNCED"]);

const TRANSITIONS: Record<ExchangeState, readonly ExchangeState[]> = {
  CREATED: ["DISCOVERING", "CHANNEL_SELECTED", "OFFERED", "RECEIVER_OPENED"],
  DISCOVERING: ["CHANNEL_SELECTED", "CHANNEL_FAILED", "RECEIVER_OPENED"],
  CHANNEL_SELECTED: ["OFFERED", "CHANNEL_FAILED", "RECEIVER_OPENED"],
  OFFERED: ["RECEIVER_OPENED", "CHANNEL_FAILED"],
  // NEXT_CHANNEL: a failed channel moves to the next candidate
  CHANNEL_FAILED: ["CHANNEL_SELECTED", "OFFERED", "RECEIVER_OPENED"],
  RECEIVER_OPENED: ["CONSENT_PENDING", "EXCHANGED"],
  CONSENT_PENDING: ["EXCHANGED", "RECEIVER_OPENED"],
  EXCHANGED: ["CLAIM_PENDING", "CLAIMED", "SYNCED"],
  CLAIM_PENDING: ["CLAIMED"],
  CLAIMED: ["SYNCED"],
  SYNCED: [],
  EXPIRED: [],
  REVOKED: [],
  CANCELLED: [],
};

export function canTransition(from: ExchangeState, to: ExchangeState): boolean {
  if (from === to) return true; // idempotent re-entry (e.g. receiver opens link twice)
  if (to === "EXPIRED" || to === "REVOKED" || to === "CANCELLED") return !TERMINAL.has(from) && !isCompleted(from);
  return TRANSITIONS[from].includes(to);
}

export function isCompleted(s: ExchangeState): boolean {
  return s === "EXCHANGED" || s === "CLAIM_PENDING" || s === "CLAIMED" || s === "SYNCED";
}

export function isTerminal(s: ExchangeState): boolean {
  return TERMINAL.has(s);
}

/** Whether a guest may still open / reply on this session. */
export function acceptsReply(s: ExchangeState, expiresAt: Date, now = new Date()): boolean {
  if (expiresAt.getTime() <= now.getTime()) return false;
  return !TERMINAL.has(s) && !isCompleted(s);
}

export class InvalidTransitionError extends Error {
  constructor(from: ExchangeState, to: ExchangeState) {
    super(`invalid exchange transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function transition(from: ExchangeState, to: ExchangeState): ExchangeState {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

// 기본 TTL: 일회성 링크 15분, 그룹 교환 링크 12시간 (F-051)
export const EXCHANGE_TTL_MS = 15 * 60 * 1000;
export const GROUP_EXCHANGE_TTL_MS = 12 * 60 * 60 * 1000;
export const SHORT_CODE_TTL_MS = 10 * 60 * 1000;
export const CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
