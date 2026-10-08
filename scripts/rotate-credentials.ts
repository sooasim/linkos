// F-163/F-165 credential key rotation — re-seal every vault-encrypted column under the active key.
//
//   1. Add the new key in front:   CREDENTIALS_KEYS="v2:<new base64 32B>,v1:<old base64 32B>"   (deploy; new writes use v2)
//   2. Re-seal existing rows:       pnpm vault:rotate --dry-run   then   pnpm vault:rotate
//   3. When the report shows failed=0 and a second run resealed=0, drop the old key from CREDENTIALS_KEYS.
//
// See docs/RUNBOOK.md "자격증명 키 로테이션". Prints counts only (never key material or plaintext).
import { closePool } from "../services/api/src/lib/db";
import { rotateSealedColumns } from "../services/api/src/lib/vaultRotate";

const dryRun = process.argv.includes("--dry-run");
const batchArg = process.argv.find((a) => a.startsWith("--batch="));

rotateSealedColumns({ dryRun, batch: batchArg ? Number(batchArg.slice(8)) : undefined })
  .then(async (r) => {
    console.log(JSON.stringify({ dryRun, activeKeyId: r.activeKeyId, stats: r.stats }, null, 2));
    const failed = r.stats.reduce((a, s) => a + s.failed, 0);
    await closePool();
    process.exit(failed ? 2 : 0);
  })
  .catch(async (e) => {
    console.error(`rotate-credentials failed: ${(e as Error).message}`);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
