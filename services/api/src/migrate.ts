import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, pool } from "./lib/db";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, "../../../db/migrations");

export async function migrate(dir = MIGRATIONS_DIR): Promise<string[]> {
  const db = pool();
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(join(dir, f), "utf8");
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(727274)");
      const again = await c.query("SELECT 1 FROM schema_migrations WHERE name=$1", [f]);
      if (again.rowCount === 0) {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
        ran.push(f);
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    } finally {
      c.release();
    }
  }
  return ran;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .then((ran) => {
      console.log(ran.length ? `applied: ${ran.join(", ")}` : "database up to date");
      return closePool();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
