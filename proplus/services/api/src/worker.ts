// P-184 워커: outbox 발행 + 만료 예정 알림(P-060) + 보존기간 만료 삭제(P-110).
// 실행: `pnpm proplus:worker` (운영에서는 `proplus-worker.service` 별도 프로세스 — 전략 §10).
//
// 이 파일의 두 가지 원칙:
//  1) **모든 핸들러는 중복 소비에 안전하다.** outbox 는 at-least-once 다(커밋 후 발행이므로 재시도가 있다).
//     그래서 알림·메일 같은 부작용은 "이미 있으면 넣지 않는다"로 쓴다 (P-184 수용기준).
//  2) **워커는 만료를 판정하지 않는다.** 만료·취소는 공개 조회 뷰가 읽기 시점에 판정한다(N-9).
//     워커가 상태를 바꾸면 배치가 늦는 동안 만료된 배지가 공개되는 창이 생긴다 — 여기서는 알림만 보낸다.
//
// 모듈 계층(services/api/src/modules/*)을 import 하지 않는다: 워커가 모듈 전체를 끌고 오면
// 한 모듈의 import 오류로 outbox 발행이 멈춘다. 여기서 필요한 것은 SQL 몇 개뿐이다.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { closePool, q, tx } from "./lib/db";
import { log } from "./lib/log";
import { purgeOldLimitWindows } from "./lib/limits";
import { sendMail } from "./lib/mail";
import { linkosConfigured } from "./lib/linkosClient";
import { systemCtx } from "./lib/ctx";
import * as integration from "./modules/integration";

/** 만료 며칠 전에 알릴지. 소속·자격 재검증에는 서류 준비 시간이 필요하므로 한 달 전에 알린다 (보안정책 §4.5). */
export const EXPIRY_NOTICE_DAYS = Number(process.env.PROPLUS_EXPIRY_NOTICE_DAYS ?? 30);

interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
}

/**
 * 같은 알림을 두 번 넣지 않는다. dedupe 키는 `(user_id, kind, link)` 다 —
 * `notifications` 에 유니크 제약을 걸지 않은 이유는 같은 종류의 알림이 **다른 대상**으로는 여러 번 와야 하기 때문이고,
 * 그 구분은 link 가 담고 있다 (예: `/app/evidence?badge=<id>`).
 */
async function notifyOnce(
  c: PoolClient,
  userId: string,
  n: { kind: string; title: string; body?: string | null; link: string },
): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO notifications (user_id, kind, title, body, link)
     SELECT $1,$2,$3,$4,$5
     WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id=$1 AND kind=$2 AND link=$5)`,
    [userId, n.kind, n.title, n.body ?? null, n.link],
  );
  return (r.rowCount ?? 0) > 0;
}

/** 검증·배지·리드 집계체에서 "알려야 할 사람"을 찾는다. payload 키 모양에 의존하지 않으려고 aggregate_id 로 역추적한다. */
async function ownerOf(c: PoolClient, kind: "badge" | "verification" | "lead" | "profile", id: string): Promise<string | null> {
  const sql = {
    badge: "SELECT p.user_id::text AS user_id FROM badges b JOIN profiles p ON p.id=b.profile_id WHERE b.id=$1",
    verification:
      `SELECT p.user_id::text AS user_id FROM verifications v
         JOIN evidence e ON e.id = v.evidence_id AND e.subject_type='profile'
         JOIN profiles p ON p.id = e.subject_id
       WHERE v.id=$1`,
    lead: "SELECT p.user_id::text AS user_id FROM leads l JOIN profiles p ON p.id=l.profile_id WHERE l.id=$1",
    profile: "SELECT user_id::text AS user_id FROM profiles WHERE id=$1",
  }[kind];
  const r = await c.query<{ user_id: string }>(sql, [id]);
  return r.rows[0]?.user_id ?? null;
}

/**
 * 이벤트 소비자. **여기 있는 모든 분기는 두 번 실행돼도 결과가 같아야 한다.**
 * 소비자가 없는 이벤트는 오류가 아니다 — 카탈로그(기술백서 §7)에는 아직 소비자가 없는 이벤트도 있다.
 */
async function dispatch(c: PoolClient, ev: OutboxRow): Promise<void> {
  switch (ev.event_type) {
    case "badge.issued": {
      if (!ev.aggregate_id) return;
      const owner = await ownerOf(c, "badge", ev.aggregate_id);
      if (owner) await notifyOnce(c, owner, { kind: "badge.issued", title: "배지가 발급되었습니다", body: "공개 프로필에서 확인하세요.", link: `/app/evidence?badge=${ev.aggregate_id}` });
      return;
    }
    case "verification.completed":
    case "verification.expired":
    case "verification.revoked": {
      if (!ev.aggregate_id) return;
      const owner = await ownerOf(c, "verification", ev.aggregate_id);
      // N-14: 분쟁·취소 상황에서도 확정적 비난 표현을 쓰지 않는다. 제목은 상태 변경 사실만 말한다.
      const title = ev.event_type === "verification.completed" ? "검증이 완료되었습니다" : ev.event_type === "verification.expired" ? "검증 유효기간이 지났습니다" : "검증이 해제되었습니다";
      if (owner) await notifyOnce(c, owner, { kind: ev.event_type, title, body: "검증 내역에서 확인하세요.", link: `/app/evidence?verification=${ev.aggregate_id}` });
      return;
    }
    case "lead.created": {
      if (!ev.aggregate_id) return;
      const owner = await ownerOf(c, "lead", ev.aggregate_id);
      // 알림에 고객 이름·연락처를 쓰지 않는다. 내용은 워크스페이스에서 권한을 확인한 뒤 보여 준다 (N-13 / 보안정책 §3).
      if (owner) await notifyOnce(c, owner, { kind: "lead.created", title: "새 상담 요청", body: "상담함에서 확인하세요.", link: `/app/leads/${ev.aggregate_id}` });
      // 연동 ②(ADR-012 / 05 §2)의 LINKOS 전달은 **여기서 하지 않는다.**
      // dispatch 는 outbox 트랜잭션 안에서 돌고(아래 relayOutbox), 외부 HTTP 호출을 그 안에 넣으면
      // 느린 응답 하나가 트랜잭션을 붙잡아 큐 전체를 막는다. 전달은 `forwardPendingLeads()` 가
      // 별도 패스로 처리한다 — 거기서는 이미 보낸 것을 쿼리로 걸러내므로 재시도도 공짜다.
      return;
    }
    case "appeal.submitted":
    case "report.created": {
      if (!ev.aggregate_id) return;
      // 검증 콘솔 담당자(플랫폼 역할)에게만 알린다. 최소권한 원칙에 따라 일반 사용자는 이 큐를 보지 못한다 (모듈명세 M12).
      const staff = await c.query<{ id: string }>("SELECT id::text AS id FROM users WHERE platform_role IN ('reviewer','admin') AND status='active'");
      const link = ev.event_type === "appeal.submitted" ? `/admin/appeals/${ev.aggregate_id}` : `/admin/reports/${ev.aggregate_id}`;
      for (const s of staff.rows) {
        await notifyOnce(c, s.id, { kind: ev.event_type, title: ev.event_type === "appeal.submitted" ? "새 이의제기" : "새 신고", body: "검증 콘솔에서 확인하세요.", link });
      }
      return;
    }
    default:
      // 소비자 미구현(예: product.updated, transaction.verified — 전략 §8 에서 외부 연동을 비워 둔 항목).
      // 그래도 processed 로 표시한다: 소비자가 없는 이벤트를 큐에 쌓아 두면 백오프 재시도가 영원히 돈다.
      log("info", "worker.outbox_no_consumer", { eventType: ev.event_type, aggregateType: ev.aggregate_type });
      return;
  }
}

/**
 * P-183 발행. `FOR UPDATE SKIP LOCKED` 로 워커를 여러 개 띄워도 같은 행을 두 번 집지 않는다.
 * 실패한 행은 지수 백오프(30초 → 최대 1시간)로 미루고 나머지 배치는 계속 처리한다 —
 * 한 이벤트의 실패가 큐 전체를 막는 head-of-line blocking 을 만들지 않는다.
 */
export async function relayOutbox(batch = 50): Promise<number> {
  return tx(async (c) => {
    const rows = await c.query<OutboxRow>(
      `SELECT id::text AS id, event_type, aggregate_type, aggregate_id::text AS aggregate_id, payload
         FROM outbox_events
        WHERE processed_at IS NULL AND next_attempt_at <= now()
        ORDER BY occurred_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    let done = 0;
    for (const ev of rows.rows) {
      try {
        // SAVEPOINT: 한 이벤트의 실패가 배치 트랜잭션 전체를 롤백시키지 않게 격리한다.
        await c.query("SAVEPOINT ev");
        await dispatch(c, ev);
        await c.query("RELEASE SAVEPOINT ev");
        await c.query("UPDATE outbox_events SET processed_at=now() WHERE id=$1", [ev.id]);
        done += 1;
      } catch (e) {
        await c.query("ROLLBACK TO SAVEPOINT ev");
        await c.query(
          `UPDATE outbox_events
              SET attempts = attempts + 1,
                  last_error = $2,
                  -- least(attempts, 7) 로 지수를 먼저 가둔다: 재시도가 많이 쌓인 행에서 power() 가 오버플로하지 않게.
                  next_attempt_at = now() + make_interval(secs => least(30 * power(2, least(attempts, 7)), 3600)::int)
            WHERE id = $1`,
          [ev.id, (e as Error).message.slice(0, 300)],
        );
        log("warn", "worker.outbox_failed", { eventType: ev.event_type, error: (e as Error).message });
      }
    }
    return done;
  });
}

/**
 * P-060 만료 예정 알림. 상태를 바꾸지 않는다 (N-9: 만료는 읽기 시점 판정).
 * 메일은 best-effort 다 — 실패해도 알림 레코드는 남고, 다음 tick 이 메일만 다시 시도하지는 않는다
 * (중복 메일보다 "앱에서 볼 수 있다"가 낫다).
 */
export async function notifyExpiringBadges(withinDays = EXPIRY_NOTICE_DAYS): Promise<number> {
  const due = await q<{ badge_id: string; user_id: string; email: string | null; label: string; expires_on: string }>(
    `SELECT b.id::text AS badge_id, u.id::text AS user_id, u.email, b.public_label AS label,
            to_char(b.expires_at, 'YYYY-MM-DD') AS expires_on
       FROM badges b
       JOIN profiles p ON p.id = b.profile_id
       JOIN users u ON u.id = p.user_id AND u.status='active' AND u.deleted_at IS NULL
      WHERE b.status='active'
        AND b.revoked_at IS NULL
        AND b.expires_at IS NOT NULL
        AND b.expires_at > now()
        AND b.expires_at <= now() + make_interval(days => $1::int)
      ORDER BY b.expires_at
      LIMIT 500`,
    [withinDays],
  );
  let sent = 0;
  for (const row of due) {
    const inserted = await tx((c) =>
      notifyOnce(c, row.user_id, {
        kind: "badge.expiring",
        title: "배지 만료 예정",
        body: `${row.label} · ${row.expires_on} 만료 예정입니다. 재검증을 요청하세요.`,
        link: `/app/evidence?expiring=${row.badge_id}`,
      }),
    );
    if (!inserted) continue; // 이미 알렸다 (P-184)
    sent += 1;
    if (row.email) {
      await sendMail(
        row.email,
        "[PROPLUS] 배지 만료 예정",
        `${row.label} 배지가 ${row.expires_on} 에 만료될 예정입니다.\n\n워크스페이스에서 재검증을 요청하세요.`,
        { messageId: `<badge-expiring-${row.badge_id}@proplus.linkos.com>` },
      ).catch((e) => (log("warn", "worker.expiry_mail_failed", { error: (e as Error).message }), false));
    }
  }
  return sent;
}

/**
 * P-110 보존기간 만료 리드 삭제 (데이터모델 §6 / 보안정책 §3 목적 제한).
 *
 * 삭제 기록은 남기고 내용은 남기지 않는다: 감사로그에 리드 **id 와 프로필 id** 만 적는다.
 * "지웠다는 사실"은 증명해야 하고 "지운 내용"은 보관하면 삭제가 아니기 때문이다 (N-13).
 * DELETE 와 감사 기록을 하나의 data-modifying CTE 로 묶어 둘이 갈라질 수 없게 한다.
 */
export async function purgeExpiredLeads(): Promise<number> {
  const r = await q<{ n: string }>(
    `WITH doomed AS (
       DELETE FROM leads WHERE retention_until < now() RETURNING id, profile_id
     ), logged AS (
       INSERT INTO audit_logs (event_type, actor_role, aggregate_type, aggregate_id, payload_minimized, access_purpose)
       SELECT 'lead.retention_purged', 'system', 'lead', d.id,
              jsonb_build_object('profileId', d.profile_id), 'retention'
         FROM doomed d
       RETURNING 1
     )
     SELECT count(*)::text AS n FROM logged`,
  );
  return Number(r[0]?.n ?? 0);
}

/** 플랫폼 보조 테이블 청소. 커지면 느려지기만 하고 아무도 안 보는 데이터다. */
export async function purgePlatformScratch(): Promise<void> {
  await q("DELETE FROM idempotency_keys WHERE created_at < now() - interval '2 days'");
  await q("DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day'");
  await q("DELETE FROM sessions WHERE expires_at < now() - interval '30 days'");
  await purgeOldLimitWindows();
}

/**
 * 연동 ② (ADR-012 / 05 §2): 소유자가 켜 둔 프로필의 상담을 LINKOS 연락처로 전달한다.
 *
 * **왜 outbox dispatch 가 아니라 별도 패스인가**
 *   `dispatch` 는 outbox 트랜잭션 안에서 돈다. 외부 HTTP 호출을 그 안에 넣으면 느린 응답 하나가
 *   트랜잭션을 붙잡아 큐 전체를 막는다(head-of-line blocking). 여기서는 트랜잭션 밖이다.
 *
 * **멱등성**(P-184): 보낼 대상을 고르는 쿼리가 이미 보낸 것을 `integration_deliveries` 로 제외한다.
 *   그래서 재시도가 공짜다 — 실패하면 다음 tick 에 자연히 다시 집힌다. 워커가 중간에 죽어도
 *   같은 리드를 두 번 보내지 않는 근거는 그 테이블의 UNIQUE 다.
 *
 * 연동이 설정되지 않았으면 쿼리조차 돌리지 않는다. PROPLUS 핵심은 LINKOS 없이 동작해야 한다(05 §5).
 */
export async function forwardPendingLeads(limit = 20): Promise<number> {
  if (!linkosConfigured()) return 0;

  const rows = await q<{ id: string }>(
    `SELECT l.id::text AS id
       FROM leads l
       JOIN profiles p ON p.id = l.profile_id
      WHERE COALESCE((p.public_settings->>'linkosSync')::boolean, false) = true
        AND NOT EXISTS (
          SELECT 1 FROM integration_deliveries d
           WHERE d.target = 'linkos' AND d.kind = 'lead' AND d.source_id = l.id
        )
      ORDER BY l.created_at
      LIMIT $1`,
    [limit],
  );

  let sent = 0;
  for (const row of rows) {
    // 한 건의 실패가 나머지를 막지 않는다. 실패 사유는 integration_deliveries 에 남는다.
    const r = await integration
      .forwardLeadToLinkos(systemCtx(randomUUID()), row.id)
      .catch((e) => {
        log("warn", "worker.lead_forward_failed", { leadId: row.id, error: (e as Error).message });
        return { status: "failed" as const };
      });
    if (r.status === "sent") sent += 1;
  }
  return sent;
}

export async function tick(): Promise<{ relayed: number; expiring: number; purgedLeads: number; forwarded: number }> {
  const relayed = await relayOutbox();
  // 알림·삭제가 실패해도 outbox 발행은 계속되어야 한다. 그래서 각각을 따로 감싼다.
  const expiring = await notifyExpiringBadges().catch((e) => (log("warn", "worker.expiry_failed", { error: (e as Error).message }), 0));
  const purgedLeads = await purgeExpiredLeads().catch((e) => (log("warn", "worker.retention_failed", { error: (e as Error).message }), 0));
  const forwarded = await forwardPendingLeads().catch((e) => (log("warn", "worker.forward_failed", { error: (e as Error).message }), 0));
  if (Math.random() < 0.05) await purgePlatformScratch().catch(() => undefined);
  return { relayed, expiring, purgedLeads, forwarded };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stopping = false;
  // systemd 가 SIGTERM 을 보내면 현재 tick 을 끝내고 멈춘다 — 배포 중 트랜잭션을 반쯤 끊지 않는다.
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));
  void (async () => {
    log("info", "worker.started", { expiryNoticeDays: EXPIRY_NOTICE_DAYS });
    while (!stopping) {
      try {
        const r = await tick();
        if (r.relayed || r.expiring || r.purgedLeads) log("info", "worker.tick", r);
      } catch (e) {
        log("error", "worker.tick_failed", { error: (e as Error).message });
      }
      await new Promise((r) => setTimeout(r, Number(process.env.WORKER_INTERVAL_MS ?? 2000)));
    }
    await closePool();
  })();
}
