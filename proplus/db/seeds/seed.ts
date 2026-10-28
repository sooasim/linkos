/**
 * PROPLUS 개발·E2E 시드.
 *
 * 실행: pnpm proplus:db:seed   (마이그레이션 후)
 *
 * 설계 의도: **시드가 정책을 우회하지 않는다.** 배지는 반드시 verifications 를 거쳐 만들고,
 * 자기기재 증거는 일부러 verified 로 올리지 않는다 — 시드 데이터로 N-1 을 깨면
 * E2E 가 "통과"하면서 실제로는 금지된 상태를 그리게 된다.
 *
 * 멱등하다. 같은 slug 가 있으면 지우고 다시 만든다.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

const SLUG = process.env.PROPLUS_SEED_SLUG ?? "demo-pro";
const EMAIL = process.env.PROPLUS_SEED_EMAIL ?? "demo@proplus.example";
const POLICY = "verification-2026-10-22";
const PRIVACY_POLICY = "privacy-2026-10-22";

async function main() {
  // lib/db.ts 와 같은 우선순위를 쓴다: PROPLUS_DATABASE_URL 이 먼저다.
  // 변수 이름이 하나뿐이면 LINKOS DB 에 PROPLUS 시드를 붓는 사고가 난다 (전략 §1 DB 분리).
  const url = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("PROPLUS_DATABASE_URL (또는 DATABASE_URL) 이 설정되지 않았다");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const c = await pool.connect();

  try {
    await c.query("BEGIN");

    // ── 정리 (멱등) ────────────────────────────────────────────────────────
    //
    // ⚠️ `DELETE FROM users` 만으로는 **지워지지 않는다.** 두 가지 이유가 있다:
    //
    //  1. `evidence.submitted_by` · `verifications.reviewer_id` · `memberships.verified_by` ·
    //     `lead_notes.author_id` · `org_invites.invited_by` 등 12개 FK 가 `ON DELETE` 절 없이
    //     `users(id)` 를 참조한다. 참조가 하나라도 남아 있으면 DELETE 가 FK 위반으로 실패한다.
    //  2. `evidence.subject_id` 는 **FK 가 아니다**(subject_type 으로 프로필·조직을 함께 가리키는
    //     다형 참조라서). 그래서 프로필이 CASCADE 로 지워져도 증거 행은 남는다.
    //
    // 운영의 계정 삭제(P-011)는 이 경로를 쓰지 않는다 — 소프트 삭제 + 익명화이고,
    // 검증 이력은 법정 보존 대상으로 분리한다(데이터모델 §6). 여기는 **시드 전용** 정리다.
    const stale = await c.query<{ id: string }>("SELECT id FROM users WHERE email = ANY($1)", [
      [EMAIL, "reviewer@proplus.example"],
    ]);
    const staleIds = stale.rows.map((r) => r.id);

    if (staleIds.length > 0) {
      const staleProfiles = await c.query<{ id: string }>("SELECT id FROM profiles WHERE user_id = ANY($1)", [staleIds]);
      const profileIds = staleProfiles.rows.map((r) => r.id);

      // 증거 → (CASCADE 로 verifications·evidence_files·appeals·badges 가 따라 지워진다)
      if (profileIds.length > 0) {
        await c.query("DELETE FROM evidence WHERE subject_type = 'profile' AND subject_id = ANY($1)", [profileIds]);
      }
      await c.query("DELETE FROM evidence WHERE submitted_by = ANY($1)", [staleIds]);

      // 사용자를 가리키는 나머지 참조를 끊는다. 지우는 것이 아니라 비우는 쪽이 안전한 것은 비운다.
      await c.query("UPDATE memberships SET verified_by = NULL WHERE verified_by = ANY($1)", [staleIds]);
      await c.query("UPDATE reports SET handled_by = NULL WHERE handled_by = ANY($1)", [staleIds]);
      await c.query("UPDATE leads SET assigned_to = NULL WHERE assigned_to = ANY($1)", [staleIds]);
      await c.query("DELETE FROM org_invites WHERE invited_by = ANY($1)", [staleIds]);
      await c.query("DELETE FROM lead_notes WHERE author_id = ANY($1)", [staleIds]);
      await c.query("DELETE FROM lead_stage_history WHERE changed_by = ANY($1)", [staleIds]);
      await c.query("DELETE FROM profile_versions WHERE created_by = ANY($1)", [staleIds]);

      await c.query("DELETE FROM users WHERE id = ANY($1)", [staleIds]);
    }

    // 조직에 매달린 증거도 같은 이유로 직접 지운다.
    const staleOrg = await c.query<{ id: string }>("SELECT id FROM organizations WHERE slug = $1", ["demo-org"]);
    const orgIds = staleOrg.rows.map((r) => r.id);
    if (orgIds.length > 0) {
      await c.query("DELETE FROM evidence WHERE subject_type = 'organization' AND subject_id = ANY($1)", [orgIds]);
      await c.query("DELETE FROM organizations WHERE id = ANY($1)", [orgIds]);
    }

    // ── 사용자 ─────────────────────────────────────────────────────────────
    const userId = randomUUID();
    await c.query(
      `INSERT INTO users (id, email, auth_provider, status, platform_role) VALUES ($1,$2,'email','active','none')`,
      [userId, EMAIL],
    );

    // 검증자 계정. 관리자 콘솔 확인용.
    const reviewerId = randomUUID();
    await c.query(
      `INSERT INTO users (id, email, auth_provider, status, platform_role) VALUES ($1,$2,'email','active','reviewer')`,
      [reviewerId, "reviewer@proplus.example"],
    );

    // ── 조직 (도메인 검증 완료 상태) ────────────────────────────────────────
    const orgId = randomUUID();
    await c.query(
      `INSERT INTO organizations (id, name, slug, verified_domain, domain_verified_at, status)
       VALUES ($1,'주식회사 예시메디','demo-org','medi.example', now() - interval '30 days','active')`,
      [orgId],
    );
    await c.query(
      `INSERT INTO memberships (organization_id, user_id, role, status, started_at, verified_by, verified_at)
       VALUES ($1,$2,'member','active', now() - interval '400 days', $3, now() - interval '30 days')`,
      [orgId, userId, reviewerId],
    );

    // ── 발급기관 (발급 권한 확인 기록이 있다 — P-072) ────────────────────────
    const issuerId = randomUUID();
    await c.query(
      `INSERT INTO issuers (id, name, kind, organization_id, authority_checked_at, authority_note)
       VALUES ($1,'주식회사 예시메디','company',$2, now() - interval '30 days','사업자등록증 및 인사담당자 확인')`,
      [issuerId, orgId],
    );

    // ── 프로필 ─────────────────────────────────────────────────────────────
    const profileId = randomUUID();
    await c.query(
      `INSERT INTO profiles (id, user_id, slug, display_name, headline, bio, specialties, languages, region, public_settings, published_at)
       VALUES ($1,$2,$3,'김영업','의료기기 유통 · 수도권 병원 영업',
               '병원 영상진단 장비 도입을 12년 동안 담당했습니다. 도입 전 현장 실측과 설치 후 교육까지 함께 진행합니다.',
               ARRAY['의료기기','영상진단장비','병원영업'], ARRAY['ko','en'], '서울',
               '{"showRegion":true,"showEmail":false,"showPhone":false}'::jsonb, now() - interval '20 days')`,
      [profileId, userId, SLUG],
    );

    // 자기기재 경력 항목 (verification_id 가 NULL — 공개 시 "자기기재"로 표기된다)
    await c.query(
      `INSERT INTO profile_facts (profile_id, kind, label, detail, started_on, position)
       VALUES ($1,'career','예시메디 영업팀','수도권 병원 담당','2015-03-01',0),
              ($1,'skill','영상진단장비 설치 교육',NULL,NULL,1)`,
      [profileId],
    );

    // 블록 (N-10: schema allowlist 를 통과하는 형태만)
    await c.query(
      `INSERT INTO profile_blocks (profile_id, kind, position, props, visible) VALUES
        ($1,'intro',0,'{}'::jsonb,true),
        ($1,'badges',1,'{}'::jsonb,true),
        ($1,'specialties',2,'{}'::jsonb,true),
        ($1,'offers',3,'{}'::jsonb,true),
        ($1,'faq',4,'{"items":[{"q":"상담은 어떻게 진행되나요?","a":"현장 방문 전 전화로 요구사항을 확인합니다."}]}'::jsonb,true),
        ($1,'contact',5,'{}'::jsonb,true)`,
      [profileId],
    );

    // ── 증거 → 검증 → 배지 (정책 경로를 그대로 따른다) ───────────────────────

    /** 증거를 만들고 verified 검증과 배지까지 발급한다. */
    async function verifiedBadge(opts: {
      type: string;
      method: "document_reviewed" | "issuer_confirmed" | "system_integrated";
      scope: string;
      label: string;
      issuer: boolean;
      ttlDays: number | null;
      sourceType: "user" | "organization" | "platform" | "third_party";
    }) {
      const evId = randomUUID();
      await c.query(
        `INSERT INTO evidence (id, subject_type, subject_id, organization_id, evidence_type, issuer_id, source_type, claim, status, submitted_by, submitted_at)
         VALUES ($1,'profile',$2,$3,$4,$5,$6,$7,'verified',$8, now() - interval '25 days')`,
        [evId, profileId, opts.issuer ? orgId : null, opts.type, opts.issuer ? issuerId : null, opts.sourceType, JSON.stringify({ scope: opts.scope }), userId],
      );

      const verifiedAt = new Date(Date.now() - 20 * 86_400_000);
      const expiresAt = opts.ttlDays ? new Date(verifiedAt.getTime() + opts.ttlDays * 86_400_000) : null;

      const vId = randomUUID();
      await c.query(
        `INSERT INTO verifications (id, evidence_id, method, reviewer_id, status, scope, verified_at, expires_at, policy_version)
         VALUES ($1,$2,$3,$4,'verified',$5,$6,$7,$8)`,
        [vId, evId, opts.method, reviewerId, opts.scope, verifiedAt, expiresAt, POLICY],
      );

      await c.query(
        `INSERT INTO badges (profile_id, badge_type, verification_id, public_label, method, scope, issuer_name, status, verified_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`,
        [profileId, opts.type, vId, opts.label, opts.method, opts.scope, opts.issuer ? "주식회사 예시메디" : null, verifiedAt, expiresAt],
      );
      return vId;
    }

    await verifiedBadge({
      type: "identity", method: "document_reviewed", scope: "성명·생년 확인",
      label: "본인 확인 완료", issuer: false, ttlDays: null, sourceType: "user",
    });

    await verifiedBadge({
      type: "affiliation", method: "issuer_confirmed", scope: "2026년 재직 확인",
      label: "현재 소속 확인", issuer: true, ttlDays: 365, sourceType: "organization",
    });

    await verifiedBadge({
      type: "career", method: "document_reviewed", scope: "2015-03 ~ 재직 중",
      label: "경력 확인", issuer: false, ttlDays: null, sourceType: "user",
    });

    // 거래 실적 — system_integrated 여야 지표에 붙일 수 있다 (P-067)
    const txVerificationId = await verifiedBadge({
      type: "transaction_count", method: "system_integrated", scope: "2026-01 ~ 2026-06 CRM 연동",
      label: "거래 데이터 확인", issuer: false, ttlDays: 180, sourceType: "third_party",
    });

    // N-8: 기간·분모·표본·근거가 모두 있는 지표만 저장된다.
    await c.query(
      `INSERT INTO metric_claims (profile_id, metric_code, value_numeric, unit, period_start, period_end, sample_size, basis, verification_id)
       VALUES ($1,'contracts_closed',128,'건','2026-01-01','2026-06-30',128,
               'CRM 연동 데이터. 계약 체결 완료 건만. 취소·반품 제외.',$2)`,
      [profileId, txVerificationId],
    );

    // ── 일부러 미완성 상태로 두는 것들 ───────────────────────────────────────

    // 1) 검토 대기 중인 증거 — 관리자 큐(P-160)에 보일 것.
    const pendingId = randomUUID();
    await c.query(
      `INSERT INTO evidence (id, subject_type, subject_id, evidence_type, issuer_id, source_type, claim, status, submitted_by)
       VALUES ($1,'profile',$2,'license',$3,'third_party','{"licenseNo":"MD-0000-XXXX"}'::jsonb,'submitted',$4)`,
      [pendingId, profileId, issuerId, userId],
    );

    // 2) 자기기재 증거 — **verified 로 올리지 않는다.** N-1 을 시드가 깨지 않게 하려는 것이다.
    //    공개 프로필에서 "자기기재"로 표기되는지 확인하는 데이터다.
    const selfId = randomUUID();
    await c.query(
      `INSERT INTO evidence (id, subject_type, subject_id, evidence_type, source_type, claim, status, submitted_by)
       VALUES ($1,'profile',$2,'product_training','user','{"course":"내부 교육 수료"}'::jsonb,'submitted',$3)`,
      [selfId, profileId, userId],
    );
    await c.query(
      `INSERT INTO verifications (evidence_id, method, status, policy_version, reason_code)
       VALUES ($1,'self_declared','needs_more_info',$2,'self_declared_requires_document')`,
      [selfId, POLICY],
    );

    // ── 상품 ───────────────────────────────────────────────────────────────
    await c.query(
      `INSERT INTO offers (owner_type, owner_id, profile_id, title, description, price_display_policy, status, published_at)
       VALUES ('profile',$1,$1,'영상진단 장비 도입 상담','현장 실측과 설치 공간 검토를 포함합니다.','inquiry','active', now()),
              ('organization',$2,$1,'초음파 장비 데모 신청','제조사 공식 데모 일정으로 연결됩니다.','inquiry','active', now())`,
      [profileId, orgId],
    );

    // ── 리드 (동의 레코드를 먼저 만든다 — leads.consent_record_id 가 NOT NULL) ──
    const consentId = randomUUID();
    await c.query(
      `INSERT INTO consent_records (id, subject_ref, purpose, granted, policy_version)
       VALUES ($1,'seed-lead-1','service',true,$2)`,
      [consentId, PRIVACY_POLICY],
    );
    await c.query(
      `INSERT INTO leads (profile_id, organization_id, contact_name, contact_channel_encrypted, contact_channel_kind, contact_masked,
                          purpose, message, consent_record_id, stage, retention_until)
       VALUES ($1,$2,'박고객','v1:seed-placeholder-not-a-real-ciphertext','email','pa***@example.com',
               '장비 도입 문의','도입 일정과 견적을 알고 싶습니다.',$3,'new', now() + interval '180 days')`,
      [profileId, orgId, consentId],
    );

    // ── 분석 이벤트 (N-13: 방문자 식별은 해시만) ──────────────────────────────
    for (let i = 0; i < 24; i++) {
      await c.query(
        `INSERT INTO analytics_events (profile_id, kind, visitor_hash, occurred_at)
         VALUES ($1,'profile_view',$2, now() - ($3 || ' hours')::interval)`,
        [profileId, `seed-visitor-${i % 7}`, String(i)],
      );
    }
    await c.query(
      `INSERT INTO analytics_events (profile_id, kind, target, occurred_at)
       VALUES ($1,'cta_click','contact', now() - interval '3 hours'),
              ($1,'lead_submit',NULL, now() - interval '2 hours')`,
      [profileId],
    );

    await c.query("COMMIT");

    console.log(`seeded:
  프로필      /p/${SLUG}
  사용자      ${EMAIL}
  검증자      reviewer@proplus.example  (platform_role=reviewer)
  조직        demo-org (medi.example 도메인 검증 완료)
  배지        4개 활성 (본인확인·소속·경력·거래데이터)
  검토 대기   2건 (license 서류 / product_training 자기기재 → needs_more_info)
  지표        1건 (contracts_closed, system_integrated 근거)`);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
