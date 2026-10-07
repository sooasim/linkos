// security module — 개인정보 export/delete, 감사로그 조회 (Privacy, Security & Compliance)
import { one, pool, q, tx } from "../lib/db";
import { unauthorized } from "../lib/errors";
import { type Ctx, audit, emit } from "../lib/platform";
import { departAllOrgs } from "./org";

export const DELETION_GRACE_DAYS = 7;

/** POST /me/privacy/export — portable JSON of everything the user owns. */
export async function exportMyData(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  const u = ctx.userId;
  const [user, profiles, fields, offers, needs, contacts, encounters, notes, meetings, actions, followups, consents, exchanges] = await Promise.all([
    one("SELECT id, email, display_name, locale, created_at FROM users WHERE id=$1", [u]),
    q("SELECT * FROM profiles WHERE user_id=$1", [u]),
    q("SELECT pf.* FROM profile_fields pf JOIN profiles p ON p.id=pf.profile_id WHERE p.user_id=$1", [u]),
    q("SELECT o.id, o.profile_id, o.text, o.provenance FROM offers o JOIN profiles p ON p.id=o.profile_id WHERE p.user_id=$1", [u]),
    q("SELECT n.id, n.profile_id, n.text, n.provenance FROM needs n JOIN profiles p ON p.id=n.profile_id WHERE p.user_id=$1", [u]),
    q("SELECT c.*, co.name AS company FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE c.owner_user_id=$1", [u]),
    q("SELECT * FROM encounters WHERE owner_user_id=$1", [u]),
    q("SELECT * FROM notes WHERE owner_user_id=$1", [u]),
    q("SELECT * FROM meetings WHERE owner_user_id=$1", [u]),
    q("SELECT * FROM action_items WHERE owner_user_id=$1", [u]),
    q("SELECT * FROM followups WHERE owner_user_id=$1", [u]),
    q("SELECT consent_type, policy_version, granted, created_at FROM consent_records WHERE subject_user_id=$1 ORDER BY created_at", [u]),
    q("SELECT id, state, selected_channel, created_at, expires_at FROM exchange_sessions WHERE sender_user_id=$1", [u]),
  ]);
  await audit(pool(), ctx, "privacy.export", "user", u);
  return { exportedAt: new Date().toISOString(), format: "linkos-portable-v1", user, profiles, profileFields: fields, offers, needs, contacts, encounters, notes, meetings, actionItems: actions, followups, consents, exchangeSessions: exchanges };
}

/** POST /me/privacy/delete — revoke sessions now, deactivate, hard-delete after the grace period (worker). */
export async function requestDeletion(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  const u = ctx.userId;
  const deadline = new Date(Date.now() + DELETION_GRACE_DAYS * 864e5);
  return tx(async (c) => {
    const r = await one<{ id: string }>("INSERT INTO deletion_requests (user_id, deadline) VALUES ($1,$2) RETURNING id", [u, deadline], c);
    await c.query("UPDATE users SET status='pending_deletion', updated_at=now() WHERE id=$1", [u]);
    await c.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [u]);
    await c.query("UPDATE exchange_sessions SET state='REVOKED', revoked_at=now(), short_code=NULL WHERE sender_user_id=$1 AND state NOT IN ('EXCHANGED','CLAIM_PENDING','CLAIMED','SYNCED','REVOKED','EXPIRED','CANCELLED')", [u]);
    await emit(c, "privacy.deletion.requested", "user", u, { subject_id: u, deadline: deadline.toISOString() });
    await audit(c, ctx, "privacy.delete_requested", "user", u, { deadline: deadline.toISOString() });
    return { id: r!.id, status: "scheduled", deadline: deadline.toISOString() };
  });
}

/** Worker: hard delete users whose grace period ended. Cascades remove owned data (ON DELETE CASCADE). */
export async function processDeletions(): Promise<number> {
  const due = await q<{ id: string; user_id: string }>("SELECT id, user_id FROM deletion_requests WHERE status='scheduled' AND deadline <= now() LIMIT 20");
  for (const d of due) {
    await tx(async (c) => {
      // F-132: company-owned leads are reassigned inside each org before the account (and its personal data) is removed
      await departAllOrgs(c, d.user_id);
      await c.query("UPDATE contacts SET linked_user_id=NULL WHERE linked_user_id=$1", [d.user_id]);
      await c.query("DELETE FROM users WHERE id=$1", [d.user_id]);
      await c.query("UPDATE deletion_requests SET status='completed', completed_at=now() WHERE id=$1", [d.id]);
      await audit(c, { userId: null }, "privacy.deleted", "user", d.user_id);
    });
  }
  return due.length;
}

export async function myAuditLog(userId: string) {
  return q<any>("SELECT id, action, entity_type, created_at FROM audit_logs WHERE actor_user_id=$1 ORDER BY created_at DESC LIMIT 100", [userId]);
}
