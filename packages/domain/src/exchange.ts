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

// ---------- 백서 §3.1 server-side paths through the machine ----------
export interface StateStep {
  from: ExchangeState;
  to: ExchangeState;
}

/**
 * Walk `path` from `from`, validating every hop with canTransition. No-op hops (already in that state) are skipped.
 * Returns the hops actually taken (for the session's state_history). Throws InvalidTransitionError on an illegal hop.
 */
export function walkTransitions(from: ExchangeState, path: readonly ExchangeState[]): StateStep[] {
  const steps: StateStep[] = [];
  let cur = from;
  for (const to of path) {
    if (to === cur) continue;
    transition(cur, to);
    steps.push({ from: cur, to });
    cur = to;
  }
  return steps;
}

/**
 * Session creation (§3.1): CREATED (128-bit token, TTL, policy) → DISCOVERING (capability vector received, policy
 * evaluated) → CHANNEL_SELECTED (attempt log, best-channel UI). The capability vector arrives with the create request, so
 * when the channel plan is decided synchronously the session passes DISCOVERING inside the creating transaction and is
 * stored as CHANNEL_SELECTED; without a plan it stays DISCOVERING until the client reports one.
 */
export function creationPath(planDecided: boolean): ExchangeState[] {
  return planDecided ? ["CREATED", "DISCOVERING", "CHANNEL_SELECTED"] : ["CREATED", "DISCOVERING"];
}

/**
 * Guest review step (§3.1 CONSENT_PENDING: "보낼 필드 미리보기"): the receiver is looking at the fields they are about
 * to send. Entered from any open pre-exchange state (implicitly passing RECEIVER_OPENED). Null when the session is
 * already completed or terminal.
 */
export function reviewPath(from: ExchangeState): ExchangeState[] | null {
  if (isCompleted(from) || isTerminal(from)) return null;
  if (from === "CONSENT_PENDING") return [];
  return from === "RECEIVER_OPENED" ? ["CONSENT_PENDING"] : ["RECEIVER_OPENED", "CONSENT_PENDING"];
}

/**
 * A reply carries the receiver's explicit consent: RECEIVER_OPENED → CONSENT_PENDING → EXCHANGED (→ CLAIM_PENDING for
 * a guest who gets a claim token). A group session that is not yet full returns to RECEIVER_OPENED for the next guest.
 */
export function replyPath(from: ExchangeState, opts: { completes: boolean; claimIssued: boolean }): ExchangeState[] {
  const path: ExchangeState[] = [];
  if (from !== "RECEIVER_OPENED" && from !== "CONSENT_PENDING") path.push("RECEIVER_OPENED");
  path.push("CONSENT_PENDING");
  if (!opts.completes) path.push("RECEIVER_OPENED");
  else {
    path.push("EXCHANGED");
    if (opts.claimIssued) path.push("CLAIM_PENDING");
  }
  return path;
}

/**
 * §3.1 SYNCED ("외부 주소록/CRM 비동기 완료"): after a contact produced by the exchange was synced successfully.
 * EXCHANGED / CLAIMED → "SYNCED"; CLAIM_PENDING cannot skip CLAIMED, so the sync is remembered ("defer") and applied
 * right after the claim; anything else → null (not exchanged yet, or already terminal).
 */
export function syncOutcome(s: ExchangeState): "SYNCED" | "defer" | null {
  if (s === "EXCHANGED" || s === "CLAIMED") return "SYNCED";
  if (s === "CLAIM_PENDING") return "defer";
  return null;
}
