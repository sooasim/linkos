// push module — F-110 Web Push (VAPID). 알림은 push_notifications 큐(+ 인앱 알림함 notifications)에 기록되고 워커가 web-push 로 전송한다.
// 구독은 사용자 기기별, 410/404 응답 시 자동 정리. 알림 종류별 설정(후속 할 일 / 일정) 토글.
import { z } from "zod";
import { type Db, one, pool, q } from "../lib/db";
import { badRequest, unauthorized, unavailable } from "../lib/errors";
import { type Ctx, audit, log } from "../lib/platform";

export function vapidConfig(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: process.env.VAPID_SUBJECT || "mailto:support@linkos.app" };
}

export const subscriptionInput = z.object({
  endpoint: z.string().url().max(2000).refine((u) => u.startsWith("https://") || process.env.NODE_ENV !== "production", "https endpoint required"),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});

export const prefsInput = z.object({ pushFollowups: z.boolean().optional(), pushScheduling: z.boolean().optional() });

export async function pushConfig(userId: string) {
  const v = vapidConfig();
  const subs = await q<{ id: string; user_agent: string | null; created_at: Date; last_success_at: Date | null; endpoint: string }>("SELECT id, user_agent, created_at, last_success_at, endpoint FROM push_subscriptions WHERE user_id=$1 ORDER BY created_at DESC", [userId]);
  const prefs = await one<{ push_followups: boolean; push_scheduling: boolean }>("SELECT push_followups, push_scheduling FROM notification_preferences WHERE user_id=$1", [userId]);
  return {
    enabled: Boolean(v),
    publicKey: v?.publicKey ?? null,
    subscriptions: subs.map((s) => ({ id: s.id, userAgent: s.user_agent, createdAt: s.created_at, lastSuccessAt: s.last_success_at, endpointHost: new URL(s.endpoint).host })),
    preferences: { pushFollowups: prefs?.push_followups ?? true, pushScheduling: prefs?.push_scheduling ?? true },
  };
}

export async function subscribe(ctx: Ctx, input: z.infer<typeof subscriptionInput>) {
  if (!ctx.userId) throw unauthorized();
  if (!vapidConfig()) throw unavailable("push_not_configured", "서버에 Web Push(VAPID)가 설정되지 않았습니다.");
  const r = await one<{ id: string }>(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, user_agent=EXCLUDED.user_agent, failure_count=0
     RETURNING id`,
    [ctx.userId, input.endpoint, input.keys.p256dh, input.keys.auth, ctx.userAgent.slice(0, 200)],
  );
  await audit(pool(), ctx, "push.subscribed", null, null, { host: new URL(input.endpoint).host });
  return { id: r!.id };
}

export async function unsubscribe(ctx: Ctx, endpoint: string) {
  if (!ctx.userId) throw unauthorized();
  await q("DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2", [ctx.userId, endpoint]);
  await audit(pool(), ctx, "push.unsubscribed", null, null);
  return { ok: true };
}

export async function setPreferences(ctx: Ctx, input: z.infer<typeof prefsInput>) {
  if (!ctx.userId) throw unauthorized();
  await q(
    `INSERT INTO notification_preferences (user_id, push_followups, push_scheduling) VALUES ($1, COALESCE($2,true), COALESCE($3,true))
     ON CONFLICT (user_id) DO UPDATE SET push_followups=COALESCE($2, notification_preferences.push_followups), push_scheduling=COALESCE($3, notification_preferences.push_scheduling), updated_at=now()`,
    [ctx.userId, input.pushFollowups ?? null, input.pushScheduling ?? null],
  );
  return pushConfig(ctx.userId);
}

/** Queue an in-app/push notification (call with the transaction client when inside a transaction). */
export async function notify(db: Db, userId: string, n: { kind: string; title: string; body?: string | null; url?: string | null; dedupeKey?: string | null }) {
  await db.query(
    `INSERT INTO push_notifications (user_id, kind, title, body, url, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [userId, n.kind, n.title.slice(0, 120), n.body?.slice(0, 300) ?? null, n.url ?? null, n.dedupeKey ?? null],
  );
  // mirror into the in-app inbox (/app/inbox) so the alert is visible even without a push subscription
  await db.query(
    `INSERT INTO notifications (user_id, kind, title, body, link, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [userId, n.kind, n.title.slice(0, 120), n.body?.slice(0, 300) ?? null, n.url ?? null, n.dedupeKey ? `push:${n.dedupeKey}` : null],
  );
}

function prefAllows(kind: string, prefs: { push_followups: boolean; push_scheduling: boolean } | null): boolean {
  if (!prefs) return true;
  if (kind.startsWith("followup")) return prefs.push_followups;
  if (kind.startsWith("calendar") || kind.startsWith("booking") || kind.startsWith("event.meeting")) return prefs.push_scheduling;
  return true;
}

/** Worker: deliver queued notifications via Web Push. Expired subscriptions (404/410) are removed. */
export async function processPushQueue(limit = 50): Promise<number> {
  await q("UPDATE push_notifications SET status='queued' WHERE status='sending' AND created_at < now() - interval '10 minutes' AND attempts < 3");
  const claimed = await q<{ id: string; user_id: string; kind: string; title: string; body: string | null; url: string | null; attempts: number }>(
    `UPDATE push_notifications SET status='sending', attempts=attempts+1 WHERE id IN (
       SELECT id FROM push_notifications WHERE status='queued' AND channel='push' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
     ) RETURNING id, user_id, kind, title, body, url, attempts`,
    [limit],
  );
  if (!claimed.length) return 0;
  const v = vapidConfig();
  let sent = 0;
  const webpush = v ? (await import("web-push")).default : null;
  for (const n of claimed) {
    const prefs = await one<{ push_followups: boolean; push_scheduling: boolean }>("SELECT push_followups, push_scheduling FROM notification_preferences WHERE user_id=$1", [n.user_id]);
    const subs = await q<{ id: string; endpoint: string; p256dh: string; auth: string }>("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1", [n.user_id]);
    if (!webpush || !v || !subs.length || !prefAllows(n.kind, prefs)) {
      await q("UPDATE push_notifications SET status='skipped', error=$2 WHERE id=$1", [n.id, !v ? "vapid_not_configured" : !subs.length ? "no_subscription" : "preference_off"]);
      continue;
    }
    const payload = JSON.stringify({ title: n.title, body: n.body ?? "", url: n.url ?? "/app", tag: `${n.kind}:${n.id}` });
    let ok = 0;
    let lastErr: string | null = null;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          TTL: 24 * 3600,
          urgency: "normal",
          timeout: 10_000,
          vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey },
        });
        ok++;
        await q("UPDATE push_subscriptions SET last_success_at=now(), failure_count=0 WHERE id=$1", [s.id]);
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        lastErr = `push_${status ?? "error"}`;
        if (status === 404 || status === 410) await q("DELETE FROM push_subscriptions WHERE id=$1", [s.id]);
        else await q("UPDATE push_subscriptions SET failure_count=failure_count+1 WHERE id=$1", [s.id]);
        log("warn", "push.send_failed", { status });
      }
    }
    if (ok > 0) {
      sent++;
      await q("UPDATE push_notifications SET status='sent', sent_at=now(), error=NULL WHERE id=$1", [n.id]);
    } else {
      await q("UPDATE push_notifications SET status=CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END, error=$2 WHERE id=$1", [n.id, lastErr]);
    }
  }
  return sent;
}

export async function sendTestPush(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  if (!vapidConfig()) throw unavailable("push_not_configured", "서버에 Web Push(VAPID)가 설정되지 않았습니다.");
  const has = await one("SELECT 1 FROM push_subscriptions WHERE user_id=$1", [ctx.userId]);
  if (!has) throw badRequest("no_subscription", "이 기기에서 먼저 알림을 켜 주세요.");
  await notify(pool(), ctx.userId, { kind: "test", title: "LINKOS 알림 테스트", body: "알림이 정상적으로 도착했어요.", url: "/app/settings" });
  return { sent: await processPushQueue(10) };
}

export async function listNotifications(userId: string) {
  return q("SELECT id, kind, title, body, url, status, created_at FROM push_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50", [userId]);
}
