// netintelJobs — 인적네트워크 인텔리전스 백그라운드 작업 (N-013 projection · N-024 품질 · N-103 엣지 강도 · N-106 알림).
// `pnpm worker` 의 tick 에서 호출된다. 모든 작업은 **idempotent** 해야 한다(지침 §8: at-least-once 소비).
//
// 설계:
//   * 알림은 "새로 생긴 후보"만 보낸다 — 같은 결과를 매주 다시 알리면 사용자가 알림을 끈다.
//   * 엣지 강도 재계산은 EdgeQuality 를 실제 값으로 만든다. 이것이 없으면 모든 엣지가 기본값 0.5 로 남는다.
//   * 데이터 품질 항목은 중복 생성하지 않는다(열린 항목이 있으면 건너뛴다).
import {
  type RelSignals,
  availabilityFrom,
  deriveRelSignals,
  relationshipStrength,
  shareabilityFrom,
} from "@linkos/domain";
import type pg from "pg";
import { one, pool, q, tx } from "../lib/db";
import { log } from "../lib/platform";
import { notify } from "./push";
import { search } from "./netintel";

const r4 = (n: number): number => Math.round(n * 10000) / 10000;

// ================================================================ N-103 연락처끼리의 엣지 강도

interface EdgeRow {
  id: string;
  owner_user_id: string;
  from_contact_id: string;
  to_contact_id: string;
  confirmed: boolean;
  inferred: boolean;
  interaction_count: number;
  first_met_at: Date | null;
  last_interaction_at: Date | null;
  prev_strength: string;
  has_reverse: boolean;
  same_company: boolean;
  shared_orgs: number;
  referrals_given: number;
  referrals_succeeded: number;
  from_last_activity: Date | null;
}

/**
 * contact_relationships 의 강도와 EdgeQuality factor 를 다시 계산한다.
 *
 * 연락처끼리의 관계에는 내 접촉기록(encounters)이 없다 — 내가 관찰한 간접 관계이기 때문이다.
 * 그래서 **있는 신호만** 쓴다: 상호작용 횟수·최근성·관계 기간·양방향성·공유 맥락.
 * 없는 신호(미팅 깊이·거래·직접 신뢰)는 0 으로 두고, 그 사실이 설명에 그대로 드러난다(지침 §3: 추측하지 않는다).
 */
export async function recomputeContactEdges(limit = 500): Promise<number> {
  const rows = await q<EdgeRow>(
    `SELECT cr.id, cr.owner_user_id, cr.from_contact_id, cr.to_contact_id, cr.confirmed, cr.inferred,
            cr.interaction_count, cr.first_met_at, cr.last_interaction_at, cr.strength::text AS prev_strength,
            EXISTS (SELECT 1 FROM contact_relationships rev
                     WHERE rev.owner_user_id = cr.owner_user_id
                       AND rev.from_contact_id = cr.to_contact_id AND rev.to_contact_id = cr.from_contact_id) AS has_reverse,
            (f.company_id IS NOT NULL AND f.company_id = t.company_id) AS same_company,
            (SELECT count(DISTINCT a.organization_id)::int FROM network_activities a
              WHERE a.owner_user_id = cr.owner_user_id AND a.organization_id IS NOT NULL
                AND a.contact_id IN (cr.from_contact_id, cr.to_contact_id)) AS shared_orgs,
            (SELECT count(*)::int FROM network_activities a
              WHERE a.owner_user_id = cr.owner_user_id AND a.contact_id = cr.from_contact_id
                AND a.activity_type IN ('referral_given','referral_received')) AS referrals_given,
            (SELECT count(*)::int FROM network_activities a
              WHERE a.owner_user_id = cr.owner_user_id AND a.contact_id = cr.from_contact_id
                AND a.activity_type IN ('referral_given','referral_received') AND a.outcome IN ('met','qualified','won')) AS referrals_succeeded,
            (SELECT max(a.occurred_at) FROM network_activities a
              WHERE a.owner_user_id = cr.owner_user_id AND a.contact_id = cr.from_contact_id) AS from_last_activity
       FROM contact_relationships cr
       JOIN contacts f ON f.id = cr.from_contact_id
       JOIN contacts t ON t.id = cr.to_contact_id
      WHERE f.deleted_at IS NULL AND t.deleted_at IS NULL
        AND (cr.strength_computed_at IS NULL OR cr.strength_computed_at < now() - interval '1 day')
      ORDER BY cr.strength_computed_at NULLS FIRST
      LIMIT $1`,
    [limit],
  );
  if (!rows.length) return 0;

  const days = (d: Date | null): number | null => (d ? Math.max(0, (Date.now() - d.getTime()) / 864e5) : null);
  let updated = 0;

  for (const e of rows) {
    const lastDays = days(e.last_interaction_at);
    const signals: RelSignals = deriveRelSignals({
      daysSinceLastContact: lastDays,
      // 간접 관계에는 90일 창이 따로 없다 — 누적 횟수만 신호로 쓴다
      encounters90d: 0,
      encountersTotal: e.interaction_count,
      meetingsTotal: 0,
      meetingMinutesTotal: 0,
      outboundCount: 0,
      inboundCount: 0,
      reciprocal: e.has_reverse,
      dealsTotal: 0,
      dealsWon: 0,
      firstMetDaysAgo: days(e.first_met_at),
      sharedOrganizations: e.shared_orgs,
      sharedEvents: 0,
      sharedCompanies: e.same_company ? 1 : 0,
      userTrust: null,
      referralsGiven: e.referrals_given,
      referralsSucceeded: e.referrals_succeeded,
      confirmed: e.confirmed,
      inferred: e.inferred,
    });
    const result = relationshipStrength(signals, { confirmed: e.confirmed, inferred: e.inferred, daysSinceLastContact: lastDays });

    // EdgeQuality 의 factor 들. context_fit 은 질의별로 달라지므로 중립값을 유지하고 요청 시점에 재계산한다.
    const shareability = shareabilityFrom(e.referrals_given, e.referrals_succeeded);
    const availability = availabilityFrom(days(e.from_last_activity) ?? lastDays);
    const trust = e.confirmed ? Math.min(1, result.score + 0.2) : result.score * 0.7;
    const introLikelihood = r4(shareability * availability);

    await tx(async (c) => {
      const upd = await c.query(
        `UPDATE contact_relationships
            SET strength=$2, trust=$3, intro_likelihood=$4, reciprocity=$5, shareability=$6, availability=$7,
                strength_factors=$8::jsonb, strength_computed_at=now(), updated_at=now()
          WHERE id=$1`,
        [e.id, r4(result.score), r4(trust), introLikelihood, r4(signals.reciprocity), r4(shareability), r4(availability), JSON.stringify(result.components)],
      );
      if (!upd.rowCount) return;
      // 점수가 실제로 움직였을 때만 샘플과 이벤트를 남긴다. 매일 같은 값을 다시 적으면
      // 추세 그래프가 평평한 점으로 가득 차고 outbox 가 무의미한 이벤트로 불어난다.
      const moved = Math.abs(Number(e.prev_strength ?? 0) - result.score) >= 0.01;
      if (moved) {
        for (const comp of result.components) {
          if (comp.value <= 0) continue;
          await c.query(
            `INSERT INTO relationship_signal_samples (owner_user_id, contact_relationship_id, signal_type, value, model_version)
             VALUES ($1,$2,$3,$4,'edge-strength-v1')`,
            [e.owner_user_id, e.id, comp.kind, r4(comp.value)],
          );
        }
        await c.query(
          `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
           VALUES ('contact_relationship',$1,'network.strength.recomputed',$2)`,
          [e.id, JSON.stringify({ edge_id: e.id, score: r4(result.score), model_version: "edge-strength-v1" })],
        );
      }
      updated++;
    });
  }
  // 샘플이 무한히 쌓이지 않게 자른다. 최근 흐름(추세 표시)에 필요한 만큼만 남긴다.
  await q(
    `DELETE FROM relationship_signal_samples s
      WHERE s.contact_relationship_id IS NOT NULL
        AND s.measured_at < now() - interval '180 days'
        AND s.evidence_id IS NULL`,
  );
  return updated;
}

// ================================================================ N-106 저장된 검색 알림

/**
 * 주기가 된 저장된 검색을 실행하고 **새로 등장한 후보가 있을 때만** 알린다.
 * 알림 본문에 이름을 넣지 않는다 — masked 후보가 섞일 수 있고, 잠금화면에 신원이 뜨면 안 된다(지침 §2).
 */
export async function processSavedSearchAlerts(limit = 20): Promise<number> {
  const due = await q<{ id: string; owner_user_id: string; name: string; query: string; alert_frequency: string; last_result_ids: string[] }>(
    `SELECT s.id, s.owner_user_id, s.name, s.query, s.alert_frequency, s.last_result_ids
       FROM saved_searches s JOIN users u ON u.id = s.owner_user_id
      WHERE s.alert_enabled AND u.status='active' AND u.deleted_at IS NULL
        AND (s.last_run_at IS NULL OR s.last_run_at < now() - (CASE s.alert_frequency
               WHEN 'daily' THEN interval '1 day' WHEN 'monthly' THEN interval '30 days' ELSE interval '7 days' END))
      ORDER BY s.last_run_at NULLS FIRST
      LIMIT $1`,
    [limit],
  );
  let notified = 0;
  for (const s of due) {
    // 실행 시각을 먼저 찍는다. 검색이 실패해도 같은 항목을 매 tick 재시도하지 않는다.
    await q("UPDATE saved_searches SET last_run_at = now() WHERE id = $1", [s.id]);
    try {
      const ctx = { userId: s.owner_user_id, ip: "worker", userAgent: "worker", requestId: `saved-search:${s.id}` };
      const res = await search(ctx, { query: s.query, limit: 20 });
      const previous = new Set(s.last_result_ids ?? []);
      const fresh = res.results.filter((r) => !previous.has(r.resultId));
      await q("UPDATE saved_searches SET last_result_ids = $2 WHERE id = $1", [s.id, res.results.map((r) => r.resultId)]);
      if (!fresh.length) continue;
      await tx(async (c) => {
        await notify(c, s.owner_user_id, {
          kind: "netintel.saved_search",
          title: `저장한 검색에 새 후보 ${fresh.length}명`,
          body: `“${s.name}” 조건에 맞는 후보가 새로 생겼습니다. 앱에서 확인하세요.`,
          url: `/app/network?q=${encodeURIComponent(s.query)}`,
          // 같은 검색에 대해 같은 주기 안에서는 한 번만 알린다
          dedupeKey: `saved-search:${s.id}:${new Date().toISOString().slice(0, 10)}`,
        });
      });
      notified++;
    } catch (e) {
      log("warn", "netintel.saved_search_failed", { savedSearchId: s.id, error: (e as Error).message });
    }
  }
  return notified;
}

// ================================================================ N-024 데이터 품질 스캔

type QualityKind = "duplicate_contact" | "unresolved_company" | "stale_role" | "missing_share_permission" | "projection_lag" | "failed_outbox" | "embedding_backlog";

/** 열린 항목이 이미 있으면 다시 만들지 않는다(worker 가 매 tick 돌아도 큐가 불어나지 않게). */
const INSERT_ITEM = `
  INSERT INTO data_quality_items (owner_user_id, kind, entity_type, entity_id, severity, detail)
  SELECT $1::uuid, $2::text, $3::text, $4::uuid, $5::text, $6::jsonb
   WHERE NOT EXISTS (
     SELECT 1 FROM data_quality_items d
      WHERE d.kind = $2::text AND d.status = 'open'
        AND d.owner_user_id IS NOT DISTINCT FROM $1::uuid
        AND d.entity_id IS NOT DISTINCT FROM $4::uuid)`;

async function addItem(c: pg.PoolClient, ownerUserId: string | null, kind: QualityKind, entityType: string | null, entityId: string | null, severity: "info" | "warn" | "critical", detail: Record<string, unknown>): Promise<number> {
  const r = await c.query(INSERT_ITEM, [ownerUserId, kind, entityType, entityId, severity, JSON.stringify(detail)]);
  return r.rowCount ?? 0;
}

/**
 * 데이터 품질을 운영 1급 기능으로 다룬다(지침 §15 DoD). 고칠 수 있는 것만 큐에 넣는다 —
 * 사용자가 아무것도 할 수 없는 항목을 쌓으면 큐가 소음이 된다.
 */
export async function scanDataQuality(): Promise<number> {
  return tx(async (c) => {
    let created = 0;

    // 1) 중복 인물: 같은 소유자 안에서 이메일/전화가 정확히 겹치는 활성 연락처
    const dupes = await c.query<{ owner_user_id: string; id: string; key: string; n: number }>(
      `SELECT owner_user_id, id, key, n FROM (
         SELECT c.owner_user_id, c.id,
                COALESCE(NULLIF(lower(btrim(c.email)), ''), regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g')) AS key,
                (count(*) OVER (PARTITION BY c.owner_user_id,
                  COALESCE(NULLIF(lower(btrim(c.email)), ''), regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g'))))::int AS n,
                row_number() OVER (PARTITION BY c.owner_user_id,
                  COALESCE(NULLIF(lower(btrim(c.email)), ''), regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g')) ORDER BY c.created_at) AS rn
           FROM contacts c
          WHERE c.deleted_at IS NULL AND c.merged_into_id IS NULL
            AND (NULLIF(btrim(COALESCE(c.email,'')), '') IS NOT NULL OR length(regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g')) >= 9)
       ) x WHERE x.n > 1 AND x.rn = 1 AND x.key <> '' LIMIT 200`,
    );
    for (const d of dupes.rows) {
      created += await addItem(c, d.owner_user_id, "duplicate_contact", "contact", d.id, "warn", { duplicates: d.n, matchedOn: d.key.includes("@") ? "email" : "phone" });
    }

    // 2) 공유 범위를 한 번도 정하지 않은 연락처 → 기본값(path_only)으로 masked 탐색에 노출된다. 사용자가 알아야 한다.
    const noShare = await c.query<{ owner_user_id: string; n: number }>(
      `SELECT c.owner_user_id, count(*)::int AS n
         FROM contacts c LEFT JOIN contact_share_permissions sp ON sp.contact_id = c.id
        WHERE c.deleted_at IS NULL AND c.merged_into_id IS NULL AND sp.contact_id IS NULL
        GROUP BY c.owner_user_id HAVING count(*) >= 5 LIMIT 200`,
    );
    for (const r of noShare.rows) {
      created += await addItem(c, r.owner_user_id, "missing_share_permission", "user", r.owner_user_id, "info", { contacts: r.n });
    }

    // 3) 끝난 소속이 현재로 남아 있음 → 역할 카테고리와 masked 라벨이 틀린 값으로 나간다
    const stale = await c.query<{ owner_user_id: string; contact_id: string; role_id: string; ended_on: Date }>(
      `SELECT c.owner_user_id, r.contact_id, r.id AS role_id, r.ended_on
         FROM contact_company_roles r JOIN contacts c ON c.id = r.contact_id
        WHERE r.is_current AND r.ended_on IS NOT NULL AND r.ended_on < current_date AND c.deleted_at IS NULL
        LIMIT 200`,
    );
    for (const r of stale.rows) {
      created += await addItem(c, r.owner_user_id, "stale_role", "contact", r.contact_id, "warn", { roleId: r.role_id, endedOn: r.ended_on.toISOString().slice(0, 10) });
    }

    // 4) 회사를 특정하지 못한 연락처 → 회사 기준 검색·공급망 분석에서 빠진다
    const noCompany = await c.query<{ owner_user_id: string; n: number }>(
      `SELECT owner_user_id, count(*)::int AS n FROM contacts
        WHERE deleted_at IS NULL AND merged_into_id IS NULL AND company_id IS NULL
        GROUP BY owner_user_id HAVING count(*) >= 10 LIMIT 200`,
    );
    for (const r of noCompany.rows) {
      created += await addItem(c, r.owner_user_id, "unresolved_company", "user", r.owner_user_id, "info", { contacts: r.n });
    }

    // 5) projection 지연 / 실패한 outbox / 임베딩 적체 — 운영 항목이라 owner 는 null 이다
    const ob = await c.query<{ pending: number; failed: number; embedding: number; oldest: Date | null }>(
      `SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS pending,
              count(*) FILTER (WHERE published_at IS NULL AND attempts >= 3)::int AS failed,
              count(*) FILTER (WHERE published_at IS NULL AND event_type = 'network.embedding.invalidated')::int AS embedding,
              min(created_at) FILTER (WHERE published_at IS NULL) AS oldest
         FROM outbox_events`,
    );
    const o = ob.rows[0];
    if (o) {
      const ageSeconds = o.oldest ? Math.round((Date.now() - o.oldest.getTime()) / 1000) : 0;
      if (ageSeconds > 300) created += await addItem(c, null, "projection_lag", null, null, "critical", { pending: o.pending, oldestAgeSeconds: ageSeconds });
      if (o.failed > 0) created += await addItem(c, null, "failed_outbox", null, null, "critical", { failed: o.failed });
      if (o.embedding > 0) created += await addItem(c, null, "embedding_backlog", null, null, "info", { pending: o.embedding });
    }

    // 자동으로 해소된 항목은 닫는다 — 사용자가 고친 뒤에도 큐에 남아 있으면 신뢰를 잃는다
    await c.query(
      `UPDATE data_quality_items d SET status='resolved', resolved_at=now()
        WHERE d.status='open' AND d.kind='stale_role'
          AND NOT EXISTS (SELECT 1 FROM contact_company_roles r
                           WHERE r.contact_id = d.entity_id AND r.is_current AND r.ended_on IS NOT NULL AND r.ended_on < current_date)`,
    );
    await c.query(
      `UPDATE data_quality_items d SET status='resolved', resolved_at=now()
        WHERE d.status='open' AND d.kind IN ('projection_lag','failed_outbox','embedding_backlog')
          AND NOT EXISTS (SELECT 1 FROM outbox_events e WHERE e.published_at IS NULL)`,
    );
    return created;
  });
}

// ================================================================ N-013 network.* 이벤트 소비

/**
 * 그래프/검색 projection 소비자. `events.ts` 의 카탈로그 이벤트와 달리 `network.` 접두사를 쓰므로
 * worker 의 dispatch 에서 이쪽으로 넘어온다. **반드시 relay 트랜잭션 클라이언트를 쓴다.**
 *
 * 반환 false = 이 모듈이 처리하지 않는 타입(호출자가 다음 소비자로 넘긴다).
 */
export async function consumeNetworkEvent(c: pg.PoolClient, type: string, payload: Record<string, unknown>): Promise<boolean> {
  switch (type) {
    case "network.edge.upserted":
    case "network.edge.removed":
      // projection 은 contact_relationships 자체이므로 별도 저장이 없다. 다음 tick 의 강도 재계산 대상으로만 표시한다.
      if (typeof payload.edge_id === "string") {
        // strength_computed_at 을 비우면 다음 tick 의 recomputeContactEdges() 가 이 엣지를 먼저 집어 간다
        await c.query("UPDATE contact_relationships SET strength_computed_at = NULL WHERE id = $1", [payload.edge_id]);
      }
      return true;

    case "network.strength.recomputed":
      // 경로 비용 캐시가 생기면 여기서 무효화한다. 지금은 질의 시점에 계산하므로 할 일이 없다.
      return true;

    case "network.disclosure.changed": {
      // 공개 범위가 좁아졌으면 그 연락처를 가리키는 **열린** 기회를 보류한다 — 더 이상 소개를 진행할 수 없다.
      if (typeof payload.contact_id !== "string") return true;
      if (payload.share_permission === "none") {
        await c.query(
          `UPDATE opportunities SET stage='dismissed', stage_entered_at=now(), updated_at=now()
            WHERE target_contact_id = $1 AND stage IN ('detected','qualified')`,
          [payload.contact_id],
        );
      }
      return true;
    }

    case "network.project.requirements.confirmed":
      // 커버리지는 요청 시점에 계산한다. 다음 조회가 새 요구사항을 보도록 계산시각만 비운다.
      if (typeof payload.project_id === "string") {
        await c.query("UPDATE project_requirements SET coverage_computed_at = NULL WHERE project_id = $1", [payload.project_id]);
      }
      return true;

    case "network.opportunity.detected": {
      // 사용자에게만 알린다. 상대에게는 아무것도 보내지 않는다(지침 §12).
      if (typeof payload.opportunity_id !== "string") return true;
      const o = await c.query<{ owner_user_id: string; project_id: string | null }>("SELECT owner_user_id, project_id FROM opportunities WHERE id=$1", [payload.opportunity_id]);
      const row = o.rows[0];
      if (row) {
        await notify(c, row.owner_user_id, {
          kind: "netintel.opportunity",
          title: "새 사업 기회 후보 (AI 추론)",
          body: "근거와 소개 경로를 확인한 뒤 진행하세요. 상대에게는 아무것도 발송되지 않았습니다.",
          url: "/app/opportunities",
          dedupeKey: `opportunity:${payload.opportunity_id}`,
        });
      }
      return true;
    }

    case "network.outcome.recorded":
      // 학습 신호는 recommendation_feedback 에 이미 쓰였다. 재학습 파이프라인이 붙으면 여기서 큐에 넣는다.
      return true;

    case "network.embedding.invalidated":
      // 임베딩 어댑터(N-012)가 붙기 전에는 소비자가 없다. 이벤트를 버리지 않고 품질 큐가 적체를 보고한다.
      return true;

    default:
      return false;
  }
}

/** worker tick 에서 한 번에 호출한다. 개별 실패가 다른 작업을 막지 않는다. */
export async function processNetworkIntel(): Promise<{ edges: number; alerts: number; quality: number }> {
  const edges = await recomputeContactEdges().catch((e) => (log("warn", "netintel.edges_failed", { error: (e as Error).message }), 0));
  const alerts = await processSavedSearchAlerts().catch((e) => (log("warn", "netintel.alerts_failed", { error: (e as Error).message }), 0));
  const quality = await scanDataQuality().catch((e) => (log("warn", "netintel.quality_failed", { error: (e as Error).message }), 0));
  return { edges, alerts, quality };
}
