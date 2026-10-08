// 백서 §20 "Audit log durability — no silent loss (outbox/checksum)": sealer, verifier and authorized purge for the
// audit_logs hash chain (pure chain math in @linkos/domain auditChain.ts; the writer is lib/platform.ts audit()).
import {
  type AuditChainRow,
  type AuditVerifyResult,
  auditChainHash,
  finishAuditVerify,
  initialAuditVerifyState,
  verifyAuditSegment,
} from "@linkos/domain";
import type pg from "pg";
import { type Db, pool, tx } from "../lib/db";
import { AUDIT_CHAIN_LOCK, AUDIT_CREATED_AT_SQL, type AuditDbRow, auditChainHead, auditRowFields, log } from "../lib/platform";

/**
 * Link not-yet-chained rows (written while the chain lock was busy, legacy rows from before the chain existed, or
 * rows inserted directly by SQL) into the chain in id order. `wait=false` (worker) skips the tick when the lock is
 * busy instead of blocking. Returns the number of rows sealed.
 */
export async function sealAuditChain(opts: { limit?: number; wait?: boolean } = {}): Promise<number> {
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 10_000);
  const sealed = await tx(async (c) => {
    if (opts.wait) await c.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_CHAIN_LOCK]);
    else if (!(await c.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [AUDIT_CHAIN_LOCK])).rows[0]?.ok) return null;
    const rows = await c.query<AuditDbRow>(
      `SELECT id::text, organization_id::text, actor_user_id::text, action, entity_type, entity_id::text, metadata, ${AUDIT_CREATED_AT_SQL} AS created_at_iso
       FROM audit_logs a WHERE a.chain_seq IS NULL ORDER BY a.id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (!rows.rows.length) return { n: 0, head: null };
    let head = await auditChainHead(c);
    for (const r of rows.rows) {
      const seq = head.seq + 1;
      const hash = auditChainHash(head.hash, auditRowFields(r, seq));
      await c.query("UPDATE audit_logs SET chain_seq=$2, prev_hash=$3, hash=$4 WHERE id=$1", [r.id, seq, head.hash, hash]);
      head = { seq, hash };
    }
    return { n: rows.rows.length, head };
  });
  if (!sealed) return 0;
  // the head goes to the log sink as an external anchor (detects truncation of the newest rows); ids/hashes only
  if (sealed.head) log("info", "audit.chain.head", { seq: sealed.head.seq, hash: sealed.head.hash });
  return sealed.n;
}

export interface AuditChainReport {
  ok: boolean;
  checked: number;
  tombstones: number;
  head: { seq: number; hash: string };
  /** rows not linked yet (normally only seconds old) */
  unsealed: number;
  break?: AuditVerifyResult["break"];
  anchor?: "ok" | "mismatch" | "missing";
}

/**
 * Walk the whole chain (streamed in batches) and report the first break. With `anchor` (a head previously exported
 * to an external log/WORM store), also proves the chain was not truncated or rewritten past that point.
 */
export async function verifyAuditChain(opts: { batch?: number; seal?: boolean; anchor?: { seq: number; hash: string } } = {}, db: Db = pool()): Promise<AuditChainReport> {
  if (opts.seal !== false) await sealAuditChain({ wait: true, limit: 10_000 });
  const batch = Math.min(Math.max(opts.batch ?? 2000, 1), 20_000);
  const tombRows = await db.query<{ chain_seq: string; hash: string }>("SELECT chain_seq::text, hash FROM audit_log_tombstones");
  const tombstones = new Map(tombRows.rows.map((t) => [Number(t.chain_seq), t.hash]));
  let state = initialAuditVerifyState();
  let anchor: AuditChainReport["anchor"] = opts.anchor ? "missing" : undefined;
  let after = 0;
  for (;;) {
    const rows = await db.query<AuditDbRow & { chain_seq: string; prev_hash: string | null; hash: string | null }>(
      `SELECT id::text, organization_id::text, actor_user_id::text, action, entity_type, entity_id::text, metadata, ${AUDIT_CREATED_AT_SQL} AS created_at_iso,
              chain_seq::text, prev_hash, hash
       FROM audit_logs a WHERE a.chain_seq > $1 ORDER BY a.chain_seq LIMIT $2`,
      [after, batch],
    );
    if (!rows.rows.length) break;
    const seg: AuditChainRow[] = rows.rows.map((r) => ({ ...auditRowFields(r, Number(r.chain_seq)), prevHash: r.prev_hash, hash: r.hash }));
    if (opts.anchor) {
      const hit = seg.find((r) => r.chainSeq === opts.anchor!.seq);
      if (hit) anchor = hit.hash === opts.anchor.hash ? "ok" : "mismatch";
    }
    const res = verifyAuditSegment(state, seg, tombstones);
    state = res.state;
    if (!res.ok) return report(false, state, await unsealedCount(db), res.break, anchor);
    after = seg[seg.length - 1]!.chainSeq;
  }
  let headSeq = state.nextSeq - 1;
  for (const k of tombstones.keys()) if (k > headSeq) headSeq = k;
  const fin = finishAuditVerify(state, headSeq, tombstones);
  if (opts.anchor && anchor === "missing" && tombstones.get(opts.anchor.seq) === opts.anchor.hash) anchor = "ok";
  const ok = fin.ok && (anchor === undefined || anchor === "ok");
  return report(ok, fin.state, await unsealedCount(db), fin.break, anchor);
}

function report(ok: boolean, st: ReturnType<typeof initialAuditVerifyState>, unsealed: number, brk: AuditVerifyResult["break"], anchor: AuditChainReport["anchor"]): AuditChainReport {
  return { ok, checked: st.checked, tombstones: st.tombstones, head: { seq: st.nextSeq - 1, hash: st.prevHash }, unsealed, ...(brk ? { break: brk } : {}), ...(anchor ? { anchor } : {}) };
}

async function unsealedCount(db: Db): Promise<number> {
  const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_logs WHERE chain_seq IS NULL");
  return r.rows[0]?.n ?? 0;
}

/**
 * Authorized purge (F-136 retention): delete audit rows matching `where` and keep a tombstone (chain_seq, hash) for
 * each chained row so the chain still verifies. Unchained rows are simply removed (never part of the chain).
 * `where` is a fixed SQL fragment over audit_logs written by the caller — never request input; values go in `params`.
 */
export async function purgeAuditLogs(c: pg.PoolClient, where: string, params: unknown[], reason: string): Promise<number> {
  await c.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_CHAIN_LOCK]);
  const r = await c.query<{ n: number }>(
    `WITH del AS (DELETE FROM audit_logs WHERE ${where} RETURNING id, chain_seq, hash, organization_id),
     tomb AS (
       INSERT INTO audit_log_tombstones (chain_seq, audit_id, hash, reason, organization_id)
       SELECT chain_seq, id, hash, $${params.length + 1}, organization_id FROM del WHERE chain_seq IS NOT NULL AND hash IS NOT NULL
       ON CONFLICT (chain_seq) DO NOTHING RETURNING 1
     )
     SELECT count(*)::int AS n FROM del`,
    [...params, reason],
  );
  return r.rows[0]?.n ?? 0;
}
