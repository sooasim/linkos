// inbox module — in-app notification center (/app/inbox + bell count). Used by Living Update (F-033), Action Card (F-036),
// booth lead assignment (F-147) and billing dunning (F-194). Notifications never contain contact PII beyond what the recipient already owns.
import { type Db, one, pool, q } from "../lib/db";
import { notFound, unauthorized } from "../lib/errors";
import type { Ctx } from "../lib/platform";

export interface NotificationInput {
  kind: "living_update" | "action_request" | "lead_assigned" | "billing" | "system";
  title: string;
  body?: string | null;
  link?: string | null;
  data?: Record<string, unknown>;
  /** one live notification per key: re-notifying refreshes it and marks it unread again */
  dedupeKey?: string | null;
}

export async function notify(db: Db, userId: string, n: NotificationInput): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO notifications (user_id, kind, title, body, link, data, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
     DO UPDATE SET kind=EXCLUDED.kind, title=EXCLUDED.title, body=EXCLUDED.body, link=EXCLUDED.link, data=EXCLUDED.data, read_at=NULL, created_at=now()
     RETURNING id`,
    [userId, n.kind, n.title.slice(0, 200), n.body?.slice(0, 1000) ?? null, n.link ?? null, JSON.stringify(n.data ?? {}), n.dedupeKey ?? null],
    db,
  );
  return r!.id;
}

export async function listNotifications(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  return q<{ id: string; kind: string; title: string; body: string | null; link: string | null; data: Record<string, unknown>; read_at: Date | null; created_at: Date }>(
    `SELECT id, kind, title, body, link, data, read_at, created_at FROM notifications WHERE user_id=$1 ${opts.unreadOnly ? "AND read_at IS NULL" : ""}
     ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(200, opts.limit ?? 50)],
  );
}

export async function unreadCount(userId: string): Promise<number> {
  return (await one<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [userId]))?.n ?? 0;
}

export async function markRead(ctx: Ctx, id: string | "all") {
  if (!ctx.userId) throw unauthorized();
  if (id === "all") {
    await q("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [ctx.userId]);
    return { unread: 0 };
  }
  const r = await one("UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE id=$1 AND user_id=$2 RETURNING id", [id, ctx.userId], pool());
  if (!r) throw notFound("notification");
  return { unread: await unreadCount(ctx.userId) };
}
