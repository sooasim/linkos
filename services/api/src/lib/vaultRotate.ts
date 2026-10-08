// F-163/F-165 key rotation: re-seal every vault-encrypted column under the active key (CREDENTIALS_KEYS[0]).
// Online and idempotent: rows already sealed with the active key are skipped; each row is updated with an optimistic
// `WHERE col = <old ciphertext>` guard so a concurrent write is never overwritten. Run: `pnpm vault:rotate [--dry-run]`.
import { type Db, pool } from "./db";
import { WRAP_AAD } from "./storage";
import { activeKeyId, needsReseal, reseal } from "./vault";

type Encoding = "bytea" | "base64" | "jsonb_sealed";

export interface SealedColumn {
  table: string;
  column: string;
  pk: string[];
  encoding: Encoding;
  aad?: Buffer;
}

/** Every column written through lib/vault seal()/sealBytes(). Keep in sync when adding sealed data (grep "seal("). */
export const SEALED_COLUMNS: SealedColumn[] = [
  { table: "integration_accounts", column: "encrypted_credentials", pk: ["id"], encoding: "bytea" },
  { table: "sso_configs", column: "encrypted_client_secret", pk: ["organization_id"], encoding: "bytea" },
  { table: "booking_pages", column: "token_sealed", pk: ["id"], encoding: "bytea" },
  { table: "webhook_endpoints", column: "secret_sealed", pk: ["id"], encoding: "bytea" },
  { table: "apple_pending_profiles", column: "encrypted_profile", pk: ["subject_hash"], encoding: "bytea" },
  { table: "exchange_rendezvous", column: "token_enc", pk: ["id"], encoding: "base64" },
  { table: "device_exchange_keys", column: "secret_enc", pk: ["id"], encoding: "base64" },
  { table: "stored_objects", column: "wrapped_key", pk: ["id"], encoding: "bytea", aad: WRAP_AAD },
  { table: "idempotency_keys", column: "response", pk: ["scope", "key"], encoding: "jsonb_sealed" },
];

export interface RotationStat {
  table: string;
  column: string;
  scanned: number;
  resealed: number;
  skipped: number;
  failed: number;
}

function decode(enc: Encoding, v: unknown): Buffer | null {
  if (v == null) return null;
  if (enc === "bytea") return v as Buffer;
  if (enc === "base64") return Buffer.from(String(v), "base64");
  const sealed = (v as { sealed?: unknown })?.sealed;
  return typeof sealed === "string" ? Buffer.from(sealed, "base64") : null; // plaintext legacy idempotency rows: not sealed
}

function encode(enc: Encoding, b: Buffer): unknown {
  if (enc === "bytea") return b;
  if (enc === "base64") return b.toString("base64");
  return JSON.stringify({ sealed: b.toString("base64") });
}

export async function rotateSealedColumns(opts: { dryRun?: boolean; batch?: number; columns?: SealedColumn[] } = {}, db: Db = pool()): Promise<{ activeKeyId: string; stats: RotationStat[] }> {
  const batch = Math.min(Math.max(opts.batch ?? 500, 1), 5000);
  const stats: RotationStat[] = [];
  for (const col of opts.columns ?? SEALED_COLUMNS) {
    const st: RotationStat = { table: col.table, column: col.column, scanned: 0, resealed: 0, skipped: 0, failed: 0 };
    stats.push(st);
    const pkList = col.pk.join(", ");
    const pkSel = col.pk.map((k, i) => `${k}::text AS pk${i}`).join(", ");
    // keyset over the text form of the primary key keeps this generic across uuid/text/composite keys
    const cursorExpr = `(${pkList})::text`;
    let last: string | null = null;
    for (;;) {
      const rows: { rows: Record<string, unknown>[] } = await db.query<Record<string, unknown>>(
        `SELECT ${pkSel}, ${col.column} AS v, ${cursorExpr} AS cursor FROM ${col.table}
         WHERE ${col.column} IS NOT NULL ${last !== null ? `AND ${cursorExpr} > $2` : ""}
         ORDER BY ${cursorExpr} LIMIT $1`,
        last !== null ? [batch, last] : [batch],
      );
      if (!rows.rows.length) break;
      for (const r of rows.rows) {
        st.scanned++;
        const buf = decode(col.encoding, r.v);
        if (!buf || !needsReseal(buf)) {
          st.skipped++;
          continue;
        }
        let next: Buffer;
        try {
          next = reseal(buf, col.aad);
        } catch {
          st.failed++; // sealed with a key that is no longer configured — left untouched, reported
          continue;
        }
        if (opts.dryRun) {
          st.resealed++;
          continue;
        }
        const where = col.pk.map((k, i) => `${k}::text = $${i + 3}`).join(" AND ");
        const guard = col.encoding === "jsonb_sealed" ? `${col.column}->>'sealed' = $2` : `${col.column} = $2`;
        const oldVal = col.encoding === "jsonb_sealed" ? buf.toString("base64") : encode(col.encoding, buf);
        const u = await db.query(`UPDATE ${col.table} SET ${col.column} = $1 WHERE ${guard} AND ${where}`, [encode(col.encoding, next), oldVal, ...col.pk.map((_, i) => r[`pk${i}`])]);
        if (u.rowCount) st.resealed++;
        else st.skipped++; // changed concurrently (already re-sealed by a fresh write)
      }
      last = String(rows.rows[rows.rows.length - 1]!.cursor);
      if (rows.rows.length < batch) break;
    }
  }
  return { activeKeyId: activeKeyId(), stats };
}
