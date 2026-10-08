// F-188 first-party product analytics + F-187 cost metering. Low-level so libs (llm, mail) and modules can use them.
// Product events carry no PII: the subject is a user id or a hashed anonymous id, properties go through sanitizeProps().
import { type ProductEventName, estimateCostMicros, sanitizeProps } from "@linkos/domain";
import { type Db, pool } from "./db";
import { log, sha256 } from "./platform";

export interface Subject {
  userId?: string | null;
  /** anonymous browser id (cookie) or a synthetic key such as an exchange session id */
  anonId?: string | null;
}

/** Stable, non-reversible subject key shared by analytics and experiments. */
export function subjectKey(s: Subject): string | null {
  if (s.userId) return `u:${s.userId}`;
  if (s.anonId) return `a:${sha256(`anon:${s.anonId}`).slice(0, 24)}`;
  return null;
}

/**
 * Record a product event. Pass the transaction client to make it part of the domain write;
 * without one it is fire-and-forget on the pool and never throws.
 */
export async function track(db: Db | null, name: ProductEventName, subject: Subject, props?: Record<string, unknown>): Promise<void> {
  if (process.env.PRODUCT_ANALYTICS_DISABLED === "1") return;
  const key = subjectKey(subject);
  if (!key) return;
  const sql = "INSERT INTO product_events (name, subject_key, user_id, properties) VALUES ($1,$2,$3,$4)";
  const params = [name, key, subject.userId ?? null, JSON.stringify(sanitizeProps(props))];
  if (db) {
    await db.query(sql, params);
    return;
  }
  await pool()
    .query(sql, params)
    .catch((e) => log("warn", "analytics.track_failed", { name, error: (e as Error).message }));
}

let rateOverrides: Record<string, number> | null = null;
function overrides(): Record<string, number> {
  if (rateOverrides) return rateOverrides;
  try {
    rateOverrides = JSON.parse(process.env.COST_RATES_JSON ?? "{}") as Record<string, number>;
  } catch {
    rateOverrides = {};
  }
  return rateOverrides;
}

export interface CostEntry {
  userId?: string | null;
  organizationId?: string | null;
  jobType: "llm" | "ocr" | "stt" | "email" | "storage";
  jobId?: string | null;
  provider: string;
  rateKey: string;
  units: number;
}

/** F-187: append an estimated cost line (micro-USD). Never throws when no client is passed. */
export async function recordCost(db: Db | null, e: CostEntry): Promise<number> {
  const micros = estimateCostMicros(e.rateKey, e.units, overrides());
  const sql = "INSERT INTO cost_ledger (user_id, organization_id, job_type, job_id, provider, rate_key, units, cost_micros) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)";
  const params = [e.userId ?? null, e.organizationId ?? null, e.jobType, e.jobId ?? null, e.provider, e.rateKey, e.units, micros];
  if (db) await db.query(sql, params);
  else await pool().query(sql, params).catch((err) => log("warn", "cost.record_failed", { error: (err as Error).message }));
  return micros;
}
