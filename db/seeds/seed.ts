// Development/CI seed (`pnpm db:seed`). Fills the core tables of 05_DATABASE_SCHEMA with a small, realistic
// dataset so that a fresh database is immediately usable and so the F-184/F-186 restore drills compare
// non-zero row counts instead of 0 == 0.
//
// Rules this seed keeps (CLAUDE.md §3):
//   - exchange/claim tokens exist only as SHA-256 hashes; the plaintext never reaches the database.
//   - no real personal data; every address is an obviously fake @example.test one.
// Idempotent: fixed ids + ON CONFLICT, so running it twice changes nothing.
import { createHash, randomUUID } from "node:crypto";
import { closePool, pool } from "../../services/api/src/lib/db";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Stable ids keep the seed idempotent and make fixtures easy to reference from a drill or a demo. */
const ID = {
  userA: "11111111-1111-4111-8111-111111111111",
  userB: "22222222-2222-4222-8222-222222222222",
  profileA: "33333333-3333-4333-8333-333333333333",
  profileB: "33333333-3333-4333-8333-444444444444",
  contactB: "44444444-4444-4444-8444-444444444444",
  contactC: "44444444-4444-4444-8444-555555555555",
  encounter: "55555555-5555-4555-8555-555555555555",
  session: "66666666-6666-4666-8666-666666666666",
  claim: "77777777-7777-4777-8777-777777777777",
  meeting: "88888888-8888-4888-8888-888888888888",
  subscription: "99999999-9999-4999-8999-999999999999",
} as const;

export async function seed(): Promise<Record<string, number>> {
  const db = pool();
  const counts: Record<string, number> = {};
  const run = async (table: string, sql: string, params: unknown[] = []) => {
    const r = await db.query(sql, params);
    counts[table] = (counts[table] ?? 0) + (r.rowCount ?? 0);
  };

  await run(
    "users",
    `INSERT INTO users (id, email, display_name, locale) VALUES
       ($1, 'founder@example.test', '김수아', 'ko-KR'),
       ($2, 'partner@example.test', '이도윤', 'ko-KR')
     ON CONFLICT (id) DO NOTHING`,
    [ID.userA, ID.userB],
  );

  await run(
    "profiles",
    `INSERT INTO profiles (id, user_id, name, headline, bio_short, visibility, is_primary, industries, regions) VALUES
       ($1, $3, '김수아', '의료 AI 창업자', '영상 판독 보조 모델을 만듭니다.', 'business', true, ARRAY['healthcare','ai'], ARRAY['KR-11']),
       ($2, $4, '이도윤', '임상 데이터 파트너', '병원 데이터 계약을 설계합니다.', 'business', true, ARRAY['healthcare'], ARRAY['KR-41'])
     ON CONFLICT (id) DO NOTHING`,
    [ID.profileA, ID.profileB, ID.userA, ID.userB],
  );

  // Contact ≠ BusinessCard ≠ Encounter ≠ Relationship (CLAUDE.md §2.5): each one is its own row.
  await run(
    "contacts",
    `INSERT INTO contacts (id, owner_user_id, linked_user_id, full_name, job_title, email, phone, source, field_provenance) VALUES
       ($1, $3, $4, '이도윤', '파트너십 리드', 'partner@example.test', '010-0000-0001', 'exchange',
        '{"email":{"provenance":"sync","confidence":1},"phone":{"provenance":"user","confidence":1}}'::jsonb),
       ($2, $3, NULL, '박하늘', '연구소장', 'lab@example.test', '010-0000-0002', 'scan',
        '{"email":{"provenance":"ocr","confidence":0.82},"phone":{"provenance":"ocr","confidence":0.74}}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [ID.contactB, ID.contactC, ID.userA, ID.userB],
  );

  await run(
    "encounters",
    `INSERT INTO encounters (id, owner_user_id, contact_id, source, place_label, context) VALUES
       ($1, $2, $3, 'exchange', '코엑스 디지털헬스케어쇼', '{"channel":"os_share"}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [ID.encounter, ID.userA, ID.contactB],
  );

  await run(
    "relationships",
    `INSERT INTO relationships (owner_user_id, contact_id, status, strength, last_contact_at, next_followup_at) VALUES
       ($1, $2, 'active', 0.72, now() - interval '3 days', now() + interval '4 days'),
       ($1, $3, 'active', 0.31, now() - interval '70 days', NULL)
     ON CONFLICT (owner_user_id, contact_id) DO NOTHING`,
    [ID.userA, ID.contactB, ID.contactC],
  );

  // Only the hash is stored. The plaintext token is generated here and deliberately discarded.
  await run(
    "exchange_sessions",
    `INSERT INTO exchange_sessions (id, sender_user_id, sender_profile_id, token_hash, state, expires_at, selected_channel, channel_plan, state_history)
     VALUES ($1, $2, $3, $4, 'EXCHANGED', now() + interval '10 minutes', 'os_share', ARRAY['os_share','short_code','qr'],
             jsonb_build_array(jsonb_build_object('from', NULL, 'to', 'CREATED', 'at', now())))
     ON CONFLICT (id) DO NOTHING`,
    [ID.session, ID.userA, ID.profileA, sha256(randomUUID())],
  );

  await run(
    "guest_claims",
    `INSERT INTO guest_claims (id, exchange_session_id, claim_token_hash, draft_contact, expires_at)
     VALUES ($1, $2, $3, '{"full_name":"박하늘","email":"lab@example.test"}'::jsonb, now() + interval '30 days')
     ON CONFLICT (id) DO NOTHING`,
    [ID.claim, ID.session, sha256(randomUUID())],
  );

  // consent_status stays 'unknown' and no recording exists: recording needs consent_records first (CLAUDE.md §2.7).
  await run(
    "meetings",
    `INSERT INTO meetings (id, owner_user_id, title, started_at, ended_at, summary)
     VALUES ($1, $2, '임상 데이터 파트너십 1차', now() - interval '2 days', now() - interval '2 days' + interval '45 minutes',
             '{"decisions":["PoC 범위는 영상 2종"],"todos":[{"text":"DPA 초안 공유","due":"+7d"}]}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [ID.meeting, ID.userA],
  );

  // Consent is recorded per type with its policy_version (CLAUDE.md §3). The table is append-only with no unique
  // key, so idempotency comes from a NOT EXISTS probe rather than ON CONFLICT.
  await run(
    "consent_records",
    `INSERT INTO consent_records (subject_user_id, consent_type, policy_version, granted)
     SELECT v.user_id::uuid, v.consent_type, '2026-10-01', v.granted
       FROM (VALUES ($1, 'service', true), ($1, 'privacy', true), ($1, 'marketing', false),
                    ($2, 'service', true), ($2, 'privacy', true)) AS v(user_id, consent_type, granted)
      WHERE NOT EXISTS (
        SELECT 1 FROM consent_records c
         WHERE c.subject_user_id = v.user_id::uuid AND c.consent_type = v.consent_type AND c.policy_version = '2026-10-01')`,
    [ID.userA, ID.userB],
  );

  await run(
    "subscriptions",
    `INSERT INTO subscriptions (id, user_id, plan, status, provider, seats)
     VALUES ($1, $2, 'free', 'active', 'none', 1)
     ON CONFLICT (id) DO NOTHING`,
    [ID.subscription, ID.userA],
  );

  // audit_logs / outbox_events are append-only (bigserial / uuid), so guard re-runs with a NOT EXISTS probe.
  await run(
    "audit_logs",
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
     SELECT $1, 'seed.applied', 'user', $1, '{"source":"db/seeds/seed.ts"}'::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM audit_logs WHERE action='seed.applied')`,
    [ID.userA],
  );

  await run(
    "outbox_events",
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, published_at)
     SELECT 'exchange_session', $1, 'exchange.session.created',
            jsonb_build_object('session_id', $1, 'sender_id', $2, 'channel_candidates', ARRAY['os_share']), now()
     WHERE NOT EXISTS (SELECT 1 FROM outbox_events WHERE event_type='exchange.session.created' AND aggregate_id=$1)`,
    [ID.session, ID.userA],
  );

  return counts;
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("db/seeds/seed.ts");
if (invokedDirectly) {
  seed()
    .then((counts) => {
      const inserted = Object.entries(counts).filter(([, n]) => n > 0);
      console.log(inserted.length ? `seeded: ${inserted.map(([t, n]) => `${t}=${n}`).join(", ")}` : "already seeded (no changes)");
      return closePool();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
