// Test fixture helper: §9 Encounters are append-only (migration 0017 trigger). Tests that need to backdate or drop
// encounters to set up a scenario use the operator maintenance switch, transaction-local, exactly like a backfill would.
import { tx } from "../src/lib/db";

export async function encounterMaintenance(sql: string, params: unknown[] = []): Promise<number> {
  return tx(async (c) => {
    await c.query("SELECT set_config('linkos.encounter_maintenance', 'on', true)");
    return (await c.query(sql, params)).rowCount ?? 0;
  });
}
