// 백서 §20 "Audit log durability — no silent loss (outbox/checksum)": tamper-evident hash chain over audit_logs.
// hash_n = SHA-256( prev_hash ‖ "\n" ‖ canonical(row_n) ), genesis prev_hash = 64×"0". Rows are chained in chain_seq
// order (1,2,3,…). A row removed by an authorized purge (retention) leaves a tombstone {chain_seq, hash}, so the chain
// still verifies; any other edit, insertion, reorder or deletion breaks it. Pure logic (no I/O).
import { sha256Bytes, toHex, utf8 } from "./hmac";

export const AUDIT_GENESIS_HASH = "0".repeat(64);

export interface AuditChainRow {
  chainSeq: number;
  id: string; // bigserial as text
  organizationId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  /** ISO-8601 UTC with millisecond precision, e.g. 2026-10-08T04:05:06.789Z */
  createdAt: string;
  prevHash: string | null;
  hash: string | null;
}

/** Deterministic JSON: object keys sorted recursively (jsonb does not preserve key order). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export function auditCanonical(r: Omit<AuditChainRow, "prevHash" | "hash">): string {
  return stableStringify([r.chainSeq, String(r.id), r.organizationId, r.actorUserId, r.action, r.entityType, r.entityId, r.metadata ?? {}, r.createdAt]);
}

export function auditChainHash(prevHash: string, r: Omit<AuditChainRow, "prevHash" | "hash">): string {
  return toHex(sha256Bytes(utf8(`${prevHash}\n${auditCanonical(r)}`)));
}

export interface AuditTombstone {
  chainSeq: number;
  hash: string;
}

export interface AuditVerifyState {
  /** next expected chain_seq */
  nextSeq: number;
  prevHash: string;
  checked: number;
  tombstones: number;
}

export type AuditBreakReason = "missing_row" | "seq_out_of_order" | "prev_hash_mismatch" | "hash_mismatch";

export interface AuditVerifyResult {
  ok: boolean;
  state: AuditVerifyState;
  break?: { chainSeq: number; id: string | null; reason: AuditBreakReason };
}

export function initialAuditVerifyState(): AuditVerifyState {
  return { nextSeq: 1, prevHash: AUDIT_GENESIS_HASH, checked: 0, tombstones: 0 };
}

/**
 * Verify one segment (rows sorted by chainSeq) continuing from `state`. Gaps must be covered by tombstones whose
 * hash the next row links to. Call repeatedly with the returned state to stream a large table.
 */
export function verifyAuditSegment(state: AuditVerifyState, rows: AuditChainRow[], tombstones: Map<number, string>): AuditVerifyResult {
  const st = { ...state };
  for (const r of rows) {
    while (st.nextSeq < r.chainSeq) {
      const t = tombstones.get(st.nextSeq);
      if (!t) return { ok: false, state: st, break: { chainSeq: st.nextSeq, id: null, reason: "missing_row" } };
      st.prevHash = t;
      st.nextSeq++;
      st.tombstones++;
    }
    if (r.chainSeq !== st.nextSeq) return { ok: false, state: st, break: { chainSeq: r.chainSeq, id: r.id, reason: "seq_out_of_order" } };
    if (r.prevHash !== st.prevHash) return { ok: false, state: st, break: { chainSeq: r.chainSeq, id: r.id, reason: "prev_hash_mismatch" } };
    if (r.hash !== auditChainHash(st.prevHash, r)) return { ok: false, state: st, break: { chainSeq: r.chainSeq, id: r.id, reason: "hash_mismatch" } };
    st.prevHash = r.hash;
    st.nextSeq++;
    st.checked++;
  }
  return { ok: true, state: st };
}

/**
 * Close the walk: chain_seq values after the last row must all be tombstoned (a purge of the newest rows); the head
 * hash must match the last tombstone/row. `headSeq` is max(chain_seq) over rows ∪ tombstones.
 */
export function finishAuditVerify(state: AuditVerifyState, headSeq: number, tombstones: Map<number, string>): AuditVerifyResult {
  const st = { ...state };
  while (st.nextSeq <= headSeq) {
    const t = tombstones.get(st.nextSeq);
    if (!t) return { ok: false, state: st, break: { chainSeq: st.nextSeq, id: null, reason: "missing_row" } };
    st.prevHash = t;
    st.nextSeq++;
    st.tombstones++;
  }
  return { ok: true, state: st };
}
