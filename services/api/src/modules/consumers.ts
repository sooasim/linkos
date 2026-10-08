// 06_EVENT_CATALOG consumers that were missing from worker dispatch(). Each consumer is idempotent (the outbox relay is
// at-least-once) and runs on the relay transaction client `c`. Existing behaviour is not repeated:
//  - exchange.session.created  → analytics: already tracked in-transaction (product_events 'exchange_created') — no-op.
//  - exchange.receiver.opened  → notification to the sender (once per session; no receiver identity).
//  - card.extraction.completed → relationship-service: duplicate-candidate check for cards that landed on an existing
//                                contact (exchange replies); scans already return duplicates to the user synchronously.
//  - guest.claimed             → relationship-service: strength refresh for both sides; growth: sender notification.
//                                (Referral attribution already happens in the claim transaction — F-064.)
//  - meeting.actions.extracted → meeting/communication-service: draft follow-ups per action item (never sent).
//  - privacy.deletion.requested→ all-data-services: idempotently re-assert the deletion pipeline.
import type pg from "pg";
import { duplicatesFor } from "./relationship";
import { recomputeStrengths } from "./network";
import { notify } from "./push";

export const CONSUMED_EVENTS = ["exchange.session.created", "exchange.receiver.opened", "card.extraction.completed", "guest.claimed", "meeting.actions.extracted", "privacy.deletion.requested"] as const;

/** Returns true when the event type was handled here. */
export async function consumeCatalogEvent(c: pg.PoolClient, type: string, payload: any): Promise<boolean> {
  switch (type) {
    case "exchange.session.created":
      return true; // analytics consumer: tracked in the creating transaction; nothing else to do
    case "exchange.receiver.opened":
      await onReceiverOpened(c, payload);
      return true;
    case "card.extraction.completed":
      await onCardExtracted(c, payload);
      return true;
    case "guest.claimed":
      await onGuestClaimed(c, payload);
      return true;
    case "meeting.actions.extracted":
      await onMeetingActions(c, payload);
      return true;
    case "privacy.deletion.requested":
      await onDeletionRequested(c, payload);
      return true;
    default:
      return false;
  }
}

async function onReceiverOpened(c: pg.PoolClient, p: { session_id: string }) {
  const s = await c.query<{ sender_user_id: string }>("SELECT sender_user_id FROM exchange_sessions WHERE id=$1 AND sender_user_id IS NOT NULL", [p.session_id]);
  if (!s.rows[0]) return;
  await notify(c, s.rows[0].sender_user_id, { kind: "exchange.opened", title: "명함이 열렸어요", body: "상대가 내 명함을 확인했어요. 회신을 기다리는 중입니다.", url: "/app/exchange", dedupeKey: `xopen:${p.session_id}` });
}

async function onCardExtracted(c: pg.PoolClient, p: { card_id: string }) {
  const r = await c.query<{ contact_id: string; owner_user_id: string; full_name: string; email: string | null; phone: string | null; company: string | null }>(
    `SELECT ct.id AS contact_id, ct.owner_user_id, ct.full_name, ct.email, ct.phone, co.name AS company
     FROM business_cards bc JOIN contacts ct ON ct.id = bc.contact_id LEFT JOIN companies co ON co.id = ct.company_id
     WHERE bc.id=$1 AND ct.deleted_at IS NULL AND ct.merged_into_id IS NULL`,
    [p.card_id],
  );
  const ct = r.rows[0];
  if (!ct) return; // scan drafts: duplicates were already shown with the capture result
  const dups = (await duplicatesFor(ct.owner_user_id, { fullName: ct.full_name, email: ct.email, phone: ct.phone, company: ct.company }, ct.contact_id));
  if (!dups.length) return;
  await notify(c, ct.owner_user_id, {
    kind: "contact.duplicate_candidate",
    title: "중복일 수 있는 연락처",
    body: `방금 받은 명함과 비슷한 연락처가 ${dups.length}개 있어요. 확인 후 병합하세요.`,
    url: `/app/people/${ct.contact_id}`,
    dedupeKey: `dup:${ct.contact_id}`,
  });
}

async function onGuestClaimed(c: pg.PoolClient, p: { guest_claim_id: string; user_id: string }) {
  const g = await c.query<{ sender_user_id: string | null; sender_contact_id: string | null }>(
    `SELECT s.sender_user_id, (g.draft_contact->>'senderContactId') AS sender_contact_id
     FROM guest_claims g LEFT JOIN exchange_sessions s ON s.id = g.exchange_session_id WHERE g.id=$1`,
    [p.guest_claim_id],
  );
  // relationship-service: both sides now have a linked, reciprocal relationship → refresh strength + explanation
  await recomputeStrengths(p.user_id, null, c);
  const row = g.rows[0];
  if (row?.sender_user_id) {
    await recomputeStrengths(row.sender_user_id, row.sender_contact_id ? [row.sender_contact_id] : null, c);
    // growth-service: the sender learns the exchange turned into an account (no PII on the lock screen)
    await notify(c, row.sender_user_id, { kind: "guest.claimed", title: "교환한 분이 LINKOS에 합류했어요", body: "이제 서로의 Living Card 업데이트를 받아볼 수 있어요.", url: row.sender_contact_id ? `/app/people/${row.sender_contact_id}` : "/app", dedupeKey: `claimed:${p.guest_claim_id}` });
  }
}

async function onMeetingActions(c: pg.PoolClient, p: { meeting_id: string; action_item_ids: string[] }) {
  // Draft only (백서 §7 Follow-up: 자동 발송은 정책과 사용자 승인 필요). Unconfirmed AI suggestions (status 'suggested',
  // "AI 추론") get no follow-up until the user confirms them on the meeting card.
  await c.query(
    `INSERT INTO followups (owner_user_id, contact_id, kind, title, due_at, source, action_item_id)
     SELECT COALESCE(a.owner_user_id, m.owner_user_id), a.contact_id, 'custom', left(a.description, 200), a.due_at,
            'meeting', a.id
     FROM action_items a JOIN meetings m ON m.id = a.meeting_id
     WHERE a.id = ANY($1::uuid[]) AND a.meeting_id = $2 AND a.status = 'open'
       AND COALESCE(a.owner_user_id, m.owner_user_id) IS NOT NULL
     ON CONFLICT (action_item_id) WHERE action_item_id IS NOT NULL DO NOTHING`,
    [p.action_item_ids ?? [], p.meeting_id],
  );
}

async function onDeletionRequested(c: pg.PoolClient, p: { subject_id: string; deadline: string }) {
  const u = await c.query<{ id: string }>("SELECT id FROM users WHERE id=$1", [p.subject_id]);
  if (!u.rows[0]) return; // already hard-deleted
  // the pipeline row must exist even if the request was replayed/partially applied (worker processDeletions acts on it)
  await c.query(
    `INSERT INTO deletion_requests (user_id, deadline) SELECT $1, $2
     WHERE NOT EXISTS (SELECT 1 FROM deletion_requests WHERE user_id=$1 AND status IN ('scheduled','completed'))`,
    [p.subject_id, p.deadline],
  );
  await c.query("UPDATE users SET status='pending_deletion', updated_at=now() WHERE id=$1 AND status <> 'pending_deletion'", [p.subject_id]);
  await c.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [p.subject_id]);
  // integration-service: stop outbound sync for the subject's data
  await c.query(
    `UPDATE sync_jobs SET status='skipped', last_error='account_deletion', finished_at=now()
     WHERE status IN ('queued','retry') AND integration_account_id IN (SELECT id FROM integration_accounts WHERE user_id=$1)`,
    [p.subject_id],
  );
  // notification: nothing further is delivered to a deleting account
  await c.query("UPDATE push_notifications SET status='skipped' WHERE user_id=$1 AND status='queued'", [p.subject_id]);
}
