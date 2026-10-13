// 인적네트워크 완성 항목 통합테스트: N-017 3D slice · N-008 소속 이력 · N-107 별칭 ·
// N-103/N-106/N-024 워커 · N-013 network.* 이벤트 소비 · 시드 더미 데이터.
//
// 핵심 테스트는 `netintel.integration.test.ts` 에 있다. 이 파일은 "나중에 완성한 것"만 다룬다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_x";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const jobs = await import("../src/modules/netintelJobs");
const { identity, netintel, relationship, closePool, one, pool, q } = api;

const ctx = (userId: string | null, ip = "10.11.0.1") => ({ userId, ip, userAgent: "test", requestId: "t" });
const consents = ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true }));
const stamp = Date.now();
let n = 0;

async function user(prefix: string) {
  const email = `${prefix}${stamp}-${n++}@netjobs.test`;
  const { devCode } = await identity.requestOtp(ctx(null, `10.11.${n % 250}.1`), email);
  return (await identity.verifyOtp(ctx(null, `10.11.${n % 250}.1`), email, devCode!, consents)).user;
}

const contact = (over: Partial<Parameters<typeof relationship.createContact>[1]> = {}) => ({
  fullName: "김철수",
  company: "알파메디칼",
  jobTitle: "대표이사",
  email: "chulsoo@alpha.example.com",
  phone: "+821012345678",
  address: "서울특별시 강남구",
  source: "manual" as const,
  provenance: {},
  ...over,
});

async function addContact(userId: string, input: ReturnType<typeof contact>): Promise<{ id: string }> {
  const r = await relationship.createContact(ctx(userId), input);
  return { id: r.contactId };
}

/** 시드 유저 A — db/seeds/seed.ts 의 고정 id */
const SEED_USER_A = "11111111-1111-4111-8111-111111111111";

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await closePool();
});

// ================================================================ N-017 3D

describe("N-017 3D slice", () => {
  it("dim=3 을 요청하면 3D 좌표가 함께 온다", async () => {
    const u = await user("dim3");
    await addContact(u.id, contact({ fullName: "삼차원대표" }));
    const flat = await netintel.graphSlice(ctx(u.id), { hops: 2, dim: 2 });
    expect(flat.dim).toBe(2);
    expect(flat.nodes.every((x) => !("z" in x))).toBe(true);

    const cube = await netintel.graphSlice(ctx(u.id), { hops: 2, dim: 3 });
    expect(cube.dim).toBe(3);
    expect(cube.nodes.length).toBeGreaterThan(0);
    for (const node of cube.nodes) {
      expect(typeof (node as { z?: number }).z).toBe("number");
      expect(typeof (node as { x3?: number }).x3).toBe("number");
    }
  });

  it("3D 는 노드 상한이 더 낮다(화면명세 S09)", async () => {
    const u = await user("dim3cap");
    const big = await netintel.graphSlice(ctx(u.id), { hops: 3, dim: 3, maxNodes: 5000 });
    expect(big.maxNodes).toBeLessThanOrEqual(500);
  });
});

// ================================================================ N-008 소속 이력

describe("N-008 소속 이력", () => {
  it("소속을 추가하면 회사가 생기고 역할 카테고리가 추론된다", async () => {
    const u = await user("roles");
    const c = await addContact(u.id, contact({ fullName: "소속대표", jobTitle: null }));
    const r = await netintel.addRole(ctx(u.id), { contactId: c.id, companyName: "롤테스트메디칼", title: "구매팀 과장", decidesFor: true });
    expect(r.roleId).toBeTruthy();

    const list = await netintel.listRoles(ctx(u.id), c.id);
    expect(list.roles).toHaveLength(1);
    expect(list.roles[0]!.company).toBe("롤테스트메디칼");
    expect(list.roles[0]!.roleCategory).toBe("구매/조달");
    expect(list.roles[0]!.decidesFor).toBe(true);
    expect(list.roleCategoryOptions.length).toBeGreaterThan(5);
  });

  it("현재 소속의 역할 카테고리가 masked 라벨에 쓰인다", async () => {
    // 내 연락처는 신원이 보이므로 masked 라벨을 직접 확인할 수 없다. 그래서 소속 이력이
    // 실제로 역할 카테고리를 덮어쓰는지를 listRoles 로 확인하고(직책 텍스트는 "사원"),
    // 그 값이 maskedLabel 생성에 쓰이는 것은 도메인 단위테스트가 보장한다.
    const u = await user("rolelabel");
    const c = await addContact(u.id, contact({ fullName: "라벨대표", jobTitle: "사원" }));
    await netintel.addRole(ctx(u.id), { contactId: c.id, companyName: "라벨회사", title: "구매팀 과장" });
    expect((await netintel.listRoles(ctx(u.id), c.id)).roles[0]!.roleCategory).toBe("구매/조달");

    const nb = await netintel.neighbors(ctx(u.id), { hops: 1 });
    const hit = nb.neighbors.find((x) => x.contactId === c.id);
    expect(hit).toBeTruthy();
    // 내 연락처이므로 신원이 공개되고 masked 라벨은 null 이어야 한다(공유 설정과 무관)
    expect(hit!.displayName).toBe("라벨대표");
    expect(hit!.maskedLabel).toBeNull();
  });

  it("공유 범위를 none 으로 둬도 내 연락처는 내 네트워크에서 사라지지 않는다", async () => {
    // 리뷰에서 드러난 결함: share_permission / org_share_opt_in 이 소유자 본인에게도 적용돼
    // "조직에 공유 안 함" 설정이 내 주소록에서 그 사람을 지웠다.
    const u = await user("ownview");
    const c = await addContact(u.id, contact({ fullName: "비공유대표" }));
    await netintel.setSharePermission(ctx(u.id), c.id, { sharePermission: "none", orgShareOptIn: false });
    const nb = await netintel.neighbors(ctx(u.id), { hops: 2 });
    const hit = nb.neighbors.find((x) => x.contactId === c.id);
    expect(hit).toBeTruthy();
    expect(hit!.displayName).toBe("비공유대표");
    // 경로 조회도 막히지 않는다
    const paths = await netintel.introPaths(ctx(u.id), { targetContactId: c.id });
    expect(paths.paths.length).toBeGreaterThan(0);
  });

  it("공개 범위 변경이 network.disclosure.changed 를 발행한다", async () => {
    // 이벤트를 발행하는 코드가 없어 소비자가 죽은 경로였다
    const u = await user("discevent");
    const c = await addContact(u.id, contact({ fullName: "이벤트대표" }));
    await netintel.setSharePermission(ctx(u.id), c.id, { sharePermission: "profile" });
    const events = await q<{ event_type: string }>("SELECT event_type FROM outbox_events WHERE aggregate_id=$1", [c.id]);
    expect(events.map((e) => e.event_type)).toContain("network.disclosure.changed");
  });

  it("새 현재 소속이 들어오면 기존 현재 소속이 닫힌다", async () => {
    const u = await user("roles2");
    const c = await addContact(u.id, contact({ fullName: "이직대표" }));
    await netintel.addRole(ctx(u.id), { contactId: c.id, companyName: "이전회사", title: "팀장" });
    await netintel.addRole(ctx(u.id), { contactId: c.id, companyName: "현재회사", title: "이사" });
    const list = await netintel.listRoles(ctx(u.id), c.id);
    expect(list.roles.filter((x) => x.isCurrent)).toHaveLength(1);
    expect(list.roles.find((x) => x.isCurrent)!.company).toBe("현재회사");
  });

  it("같은 회사 이름은 companies 행을 재사용한다", async () => {
    const u = await user("roles3");
    const a = await addContact(u.id, contact({ fullName: "동료1" }));
    const b = await addContact(u.id, contact({ fullName: "동료2" }));
    await netintel.addRole(ctx(u.id), { contactId: a.id, companyName: " 공유회사 " });
    await netintel.addRole(ctx(u.id), { contactId: b.id, companyName: "공유회사" });
    const la = await netintel.listRoles(ctx(u.id), a.id);
    const lb = await netintel.listRoles(ctx(u.id), b.id);
    expect(la.roles[0]!.companyId).toBe(lb.roles[0]!.companyId);
  });

  it("퇴사 처리하면 현재 소속에서 빠진다", async () => {
    const u = await user("roles4");
    const c = await addContact(u.id, contact({ fullName: "퇴사대표" }));
    const r = await netintel.addRole(ctx(u.id), { contactId: c.id, companyName: "퇴사회사", title: "대표" });
    await netintel.endRole(ctx(u.id), r.roleId, {});
    expect((await netintel.listRoles(ctx(u.id), c.id)).roles[0]!.isCurrent).toBe(false);
  });

  it("다른 소유자의 연락처·소속은 404 다", async () => {
    const a = await user("rolea");
    const b = await user("roleb");
    const c = await addContact(a.id, contact());
    const r = await netintel.addRole(ctx(a.id), { contactId: c.id, companyName: "비공개회사" });
    await expect(netintel.listRoles(ctx(b.id), c.id)).rejects.toMatchObject({ status: 404 });
    await expect(netintel.addRole(ctx(b.id), { contactId: c.id, companyName: "침입" })).rejects.toMatchObject({ status: 404 });
    await expect(netintel.endRole(ctx(b.id), r.roleId, {})).rejects.toMatchObject({ status: 404 });
  });

  it("잘못된 역할 카테고리와 빈 회사명은 400 이다", async () => {
    const u = await user("rolecat");
    const c = await addContact(u.id, contact());
    await expect(netintel.addRole(ctx(u.id), { contactId: c.id, companyName: "회사", roleCategory: "없는카테고리" })).rejects.toMatchObject({ status: 400 });
    await expect(netintel.addRole(ctx(u.id), { contactId: c.id, companyName: "  " })).rejects.toMatchObject({ status: 400 });
  });
});

// ================================================================ N-107 별칭

describe("N-107 별칭이 검색에 반영된다", () => {
  it("등록한 별칭으로 검색하면 조건이 잡힌다", async () => {
    const u = await user("alias");
    await addContact(u.id, contact({ fullName: "메디텍대표", address: "서울특별시" }));
    const before = await netintel.search(ctx(u.id), { query: "메디텍 회사" });
    expect(before.parsedIntent.industries).not.toContain("의료기기");

    await netintel.addAlias(ctx(u.id), { kind: "industry", alias: "메디텍", canonicalName: "의료기기" });
    const after = await netintel.search(ctx(u.id), { query: "메디텍 회사" });
    expect(after.parsedIntent.industries).toContain("의료기기");

    const list = await netintel.listAliases(ctx(u.id));
    expect(list.aliases).toHaveLength(1);
    expect(list.aliases[0]!.scope).toBe("personal");
    expect(list.options.industry.length).toBeGreaterThan(10);
  });

  it("사전 밖 canonical 값과 이미 사전에 있는 표현은 400 이다", async () => {
    const u = await user("alias2");
    await expect(netintel.addAlias(ctx(u.id), { kind: "industry", alias: "머시기", canonicalName: "존재하지않는산업" })).rejects.toMatchObject({ status: 400 });
    await expect(netintel.addAlias(ctx(u.id), { kind: "industry", alias: "의료기기", canonicalName: "반도체" })).rejects.toMatchObject({ status: 400 });
  });

  it("다른 사용자의 별칭은 보이지 않고 삭제할 수 없다", async () => {
    const a = await user("aliasa");
    const b = await user("aliasb");
    const made = await netintel.addAlias(ctx(a.id), { kind: "region", alias: "동남아", canonicalName: "베트남" });
    expect((await netintel.listAliases(ctx(b.id))).aliases).toHaveLength(0);
    await expect(netintel.deleteAlias(ctx(b.id), made.aliasId)).rejects.toMatchObject({ status: 404 });
    expect(await netintel.deleteAlias(ctx(a.id), made.aliasId)).toEqual({ deleted: true });
  });
});

// ================================================================ N-103 워커

describe("N-103 워커: 연락처 엣지 강도 재계산", () => {
  it("엣지 강도와 EdgeQuality factor 를 채우고 신호 샘플을 남긴다", async () => {
    const u = await user("edgejob");
    const a = await addContact(u.id, contact({ fullName: "중개자A" }));
    const b = await addContact(u.id, contact({ fullName: "대상B" }));
    await q(
      `INSERT INTO contact_relationships (owner_user_id, from_contact_id, to_contact_id, rel_type, strength, confirmed, interaction_count, last_interaction_at, first_met_at)
       VALUES ($1,$2,$3,'knows',0.5,true,8, now() - interval '10 days', now() - interval '2 years')`,
      [u.id, a.id, b.id],
    );
    expect(await jobs.recomputeContactEdges(50)).toBeGreaterThan(0);

    const row = await one<{ strength: string; shareability: string; availability: string; computed: Date | null; factors: unknown }>(
      `SELECT strength::text, shareability::text, availability::text, strength_computed_at AS computed, strength_factors AS factors
         FROM contact_relationships WHERE owner_user_id=$1 AND from_contact_id=$2`,
      [u.id, a.id],
    );
    expect(row!.computed).not.toBeNull();
    expect(Number(row!.strength)).toBeGreaterThan(0);
    expect((row!.factors as unknown[]).length).toBe(9);
    const samples = await q<{ signal_type: string }>("SELECT signal_type FROM relationship_signal_samples WHERE owner_user_id=$1 AND contact_relationship_id IS NOT NULL", [u.id]);
    expect(samples.length).toBeGreaterThan(0);
  });

  it("한 번 계산한 엣지는 하루 안에 다시 계산하지 않는다(쓰기 폭증 방지)", async () => {
    const u = await user("edgejob2");
    const a = await addContact(u.id, contact({ fullName: "A2" }));
    const b = await addContact(u.id, contact({ fullName: "B2" }));
    await q(
      `INSERT INTO contact_relationships (owner_user_id, from_contact_id, to_contact_id, rel_type, interaction_count, last_interaction_at)
       VALUES ($1,$2,$3,'knows',3, now() - interval '5 days')`,
      [u.id, a.id, b.id],
    );
    await jobs.recomputeContactEdges(50);
    const before = await one<{ n: string }>("SELECT count(*)::text AS n FROM relationship_signal_samples WHERE owner_user_id=$1", [u.id]);
    await jobs.recomputeContactEdges(50);
    const after = await one<{ n: string }>("SELECT count(*)::text AS n FROM relationship_signal_samples WHERE owner_user_id=$1", [u.id]);
    expect(after!.n).toBe(before!.n);
  });

  it("재계산 표시를 받으면 다음 실행에서 다시 집어 간다", async () => {
    const u = await user("edgejob3");
    const a = await addContact(u.id, contact({ fullName: "A3" }));
    const b = await addContact(u.id, contact({ fullName: "B3" }));
    const edge = await one<{ id: string }>(
      `INSERT INTO contact_relationships (owner_user_id, from_contact_id, to_contact_id, rel_type, interaction_count)
       VALUES ($1,$2,$3,'knows',1) RETURNING id`,
      [u.id, a.id, b.id],
    );
    await jobs.recomputeContactEdges(50);
    expect((await one<{ c: Date | null }>("SELECT strength_computed_at AS c FROM contact_relationships WHERE id=$1", [edge!.id]))!.c).not.toBeNull();

    const client = await pool().connect();
    try {
      await jobs.consumeNetworkEvent(client, "network.edge.upserted", { edge_id: edge!.id });
    } finally {
      client.release();
    }
    expect((await one<{ c: Date | null }>("SELECT strength_computed_at AS c FROM contact_relationships WHERE id=$1", [edge!.id]))!.c).toBeNull();
  });
});

// ================================================================ N-106 워커

describe("N-106 워커: 저장된 검색 알림", () => {
  it("새 후보가 생겼을 때만 알리고, 알림 본문에 이름을 넣지 않는다", async () => {
    const u = await user("alertjob");
    await addContact(u.id, contact({ fullName: "알림대상", address: "서울특별시" }));
    await netintel.saveSearch(ctx(u.id), { query: "서울 의료기기 대표", alertEnabled: true, alertFrequency: "daily" });

    expect(await jobs.processSavedSearchAlerts(10)).toBeGreaterThan(0);
    const inbox = await q<{ title: string; body: string }>("SELECT title, body FROM notifications WHERE user_id=$1 AND kind='netintel.saved_search'", [u.id]);
    expect(inbox.length).toBeGreaterThan(0);
    expect(JSON.stringify(inbox)).not.toContain("알림대상");

    // 주기(daily)가 안 됐으므로 다시 돌려도 아무것도 안 한다
    expect(await jobs.processSavedSearchAlerts(10)).toBe(0);
  });

  it("알림이 꺼진 검색은 건드리지 않는다", async () => {
    const u = await user("alertoff");
    await addContact(u.id, contact());
    const s = await netintel.saveSearch(ctx(u.id), { query: "서울 의료기기", alertEnabled: false });
    await jobs.processSavedSearchAlerts(10);
    expect((await one<{ last_run_at: Date | null }>("SELECT last_run_at FROM saved_searches WHERE id=$1", [s.savedSearchId]))!.last_run_at).toBeNull();
  });
});

// ================================================================ N-024 워커

describe("N-024 워커: 데이터 품질 스캔", () => {
  it("중복 연락처와 끝난 소속을 큐에 담고 중복 생성하지 않는다", async () => {
    const u = await user("dqjob");
    const email = `dupe${Date.now()}@example.test`;
    await addContact(u.id, contact({ fullName: "중복가", email }));
    await addContact(u.id, contact({ fullName: "중복나", email }));
    const c = await addContact(u.id, contact({ fullName: "끝난소속" }));
    const r = await netintel.addRole(ctx(u.id), { contactId: c.id, companyName: "옛회사", title: "팀장" });
    await q("UPDATE contact_company_roles SET is_current = true, ended_on = current_date - 30 WHERE id = $1", [r.roleId]);

    await jobs.scanDataQuality(true);
    const kinds = (await q<{ kind: string }>("SELECT DISTINCT kind FROM data_quality_items WHERE owner_user_id=$1 AND status='open'", [u.id])).map((k) => k.kind);
    expect(kinds).toContain("duplicate_contact");
    expect(kinds).toContain("stale_role");

    const before = await one<{ n: string }>("SELECT count(*)::text AS n FROM data_quality_items WHERE owner_user_id=$1", [u.id]);
    await jobs.scanDataQuality(true);
    expect((await one<{ n: string }>("SELECT count(*)::text AS n FROM data_quality_items WHERE owner_user_id=$1", [u.id]))!.n).toBe(before!.n);

    const summary = await netintel.dataQuality(ctx(u.id));
    expect(summary.items.some((i) => i.kind === "duplicate_contact")).toBe(true);
  });

  it("고쳐진 항목은 자동으로 닫힌다", async () => {
    const u = await user("dqfix");
    const c = await addContact(u.id, contact({ fullName: "고칠소속" }));
    const r = await netintel.addRole(ctx(u.id), { contactId: c.id, companyName: "닫을회사", title: "대표" });
    await q("UPDATE contact_company_roles SET is_current = true, ended_on = current_date - 10 WHERE id = $1", [r.roleId]);
    await jobs.scanDataQuality(true);
    expect((await q("SELECT 1 FROM data_quality_items WHERE owner_user_id=$1 AND kind='stale_role' AND status='open'", [u.id])).length).toBeGreaterThan(0);

    await netintel.endRole(ctx(u.id), r.roleId, {});
    await jobs.scanDataQuality(true);
    expect((await q("SELECT 1 FROM data_quality_items WHERE owner_user_id=$1 AND kind='stale_role' AND status='open'", [u.id])).length).toBe(0);
  });
});

// ================================================================ N-013 이벤트 소비

describe("N-013 network.* 이벤트 소비", () => {
  it("공유 범위를 none 으로 바꾸면 열린 기회가 보류된다", async () => {
    const u = await user("evshare");
    const c = await addContact(u.id, contact({ fullName: "차단대상" }));
    const o = await netintel.createOpportunity(ctx(u.id), { targetContactId: c.id });
    const client = await pool().connect();
    try {
      await jobs.consumeNetworkEvent(client, "network.disclosure.changed", { contact_id: c.id, share_permission: "none" });
    } finally {
      client.release();
    }
    expect((await one<{ stage: string }>("SELECT stage FROM opportunities WHERE id=$1", [o.opportunityId]))!.stage).toBe("dismissed");
  });

  it("다른 소유자의 연락처·프로젝트로는 기회를 만들 수 없다", async () => {
    const a = await user("oppa");
    const b = await user("oppb");
    const c = await addContact(a.id, contact({ fullName: "남의연락처" }));
    const p = await netintel.createProject(ctx(a.id), { name: "남의 프로젝트", description: "파트너가 필요합니다." });
    const mine = await addContact(b.id, contact({ fullName: "내연락처" }));
    // 대상이 내 네트워크에 없으면 404 — 201/FK실패 차이가 uuid 존재 여부를 알려주면 안 된다
    await expect(netintel.createOpportunity(ctx(b.id), { targetContactId: c.id })).rejects.toMatchObject({ status: 404 });
    await expect(netintel.createOpportunity(ctx(b.id), { targetContactId: mine.id, projectId: p.projectId })).rejects.toMatchObject({ status: 404 });
  });

  it("탐색을 거부한 연락처는 기회로 만들 수 없다", async () => {
    const u = await user("oppoptout");
    const c = await addContact(u.id, contact({ fullName: "거부대표" }));
    await netintel.setSharePermission(ctx(u.id), c.id, { discoveryOptOut: true, sharePermission: "none" });
    await expect(netintel.createOpportunity(ctx(u.id), { targetContactId: c.id })).rejects.toMatchObject({ status: 403 });
  });

  it("남의 capability 나 연락처에는 연결·근거 기록을 할 수 없다", async () => {
    const a = await user("capa");
    const b = await user("capb");
    const theirCap = await netintel.upsertCapability(ctx(a.id), { name: "남의 역량" });
    const theirContact = await addContact(a.id, contact({ fullName: "남의연락처2" }));
    const myContact = await addContact(b.id, contact({ fullName: "내연락처2" }));
    await expect(netintel.linkCapability(ctx(b.id), { contactId: myContact.id, capabilityId: theirCap.capabilityId })).rejects.toMatchObject({ status: 404 });
    await expect(
      netintel.recordEvidence(ctx(b.id), { entityType: "contact", entityId: theirContact.id, evidenceType: "note", summary: "침입" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("모르는 타입은 false 를 돌려줘 다음 소비자로 넘어간다", async () => {
    const client = await pool().connect();
    try {
      expect(await jobs.consumeNetworkEvent(client, "contact.updated", { contact_id: null })).toBe(false);
      expect(await jobs.consumeNetworkEvent(client, "network.outcome.recorded", { label: "won" })).toBe(true);
    } finally {
      client.release();
    }
  });

  it("요구사항 확정 이벤트는 커버리지 계산시각을 비운다", async () => {
    const u = await user("evreq");
    const p = await netintel.createProject(ctx(u.id), { name: "이벤트 프로젝트", description: "파트너가 필요합니다." });
    await netintel.analyzeProject(ctx(u.id), p.projectId);
    await q("UPDATE project_requirements SET coverage_computed_at = now() WHERE project_id = $1", [p.projectId]);
    const client = await pool().connect();
    try {
      await jobs.consumeNetworkEvent(client, "network.project.requirements.confirmed", { project_id: p.projectId, requirement_ids: [] });
    } finally {
      client.release();
    }
    const left = await q("SELECT 1 FROM project_requirements WHERE project_id=$1 AND coverage_computed_at IS NOT NULL", [p.projectId]);
    expect(left.length).toBe(0);
  });
});

// ================================================================ 시드 더미 데이터

describe("시드 더미 데이터", () => {
  const seedOnce = async () => {
    const { seed } = await import("../../../db/seeds/seed");
    const { NETINTEL_SEED_IDS } = await import("../../../db/seeds/netintel");
    await seed();
    return NETINTEL_SEED_IDS;
  };

  it("masked 2촌 발견과 Top-K 대안 경로가 실제로 만들어진다", async () => {
    const S = await seedOnce();
    const sctx = ctx(SEED_USER_A);

    const res = await netintel.search(sctx, { query: "베트남에서 의료기기를 유통할 회사를 내 3촌 안에서 찾아줘" });
    expect(res.parsedIntent.geographies).toContain("베트남");
    const masked = res.results.find((r) => r.resultId === S.c.hyunwoo);
    expect(masked).toBeTruthy();
    expect(masked!.disclosure).toBe("masked");
    expect(masked!.maskedLabel).toContain("베트남");

    // 인수 게이트: masked 후보의 신원 필드가 비어 있다
    expect(masked!.displayName).toBeNull();
    expect(masked!.companyName).toBeNull();
    expect(masked!.jobTitle).toBeNull();
    expect(masked!.email).toBeNull();
    expect(masked!.phone).toBeNull();

    // 그 사람을 특정하는 문자열이 응답 어디에도 없다
    const json = JSON.stringify(res);
    for (const pii of ["노현우", "hyunwoo@hanoimedi.example.test", "010-0000-2003"]) expect(json).not.toContain(pii);
    // 탐색을 거부한 연락처는 아예 나타나지 않는다
    expect(json).not.toContain("조은별");

    // 회사명(하노이메디)은 전역 금지 목록에 넣지 않는다 — 같은 회사의 **다른** 연락처(백도현,
    // 조직 공유 + contact 범위)가 정당하게 공개되기 때문이다. masked 후보 자신의 companyName 이
    // null 인지를 위에서 검사하는 것이 올바른 게이트다. 산업·지역 facet 으로 소속을 추론할
    // 여지는 masked discovery 설계가 수용하는 수준이다(§2: 신원 **필드**를 내보내지 않는다).
    const disclosedSameCompany = res.results.find((r) => r.resultId === S.cc.dohyun);
    if (disclosedSameCompany) expect(disclosedSameCompany.companyName).toBe("하노이메디");

    const paths = await netintel.introPaths(sctx, { targetContactId: S.c.hyunwoo, k: 3, maxHops: 3 });
    expect(paths.paths.length).toBeGreaterThanOrEqual(3);
    expect(paths.target.displayName).toBeNull();
    expect(new Set(paths.paths.map((p) => p.introducerId)).size).toBeGreaterThan(1);
    expect(JSON.stringify(paths)).not.toContain("노현우");
  });

  it("커버리지에 여러 상태가 나타나고 확정 여부가 구분된다", async () => {
    const S = await seedOnce();
    const sctx = ctx(SEED_USER_A);

    const confirmed = await netintel.projectCoverage(sctx, S.project.vietnam);
    expect(confirmed.requirementsConfirmed).toBe(true);
    expect(confirmed.requirements).toHaveLength(4);
    expect(confirmed.summary.total).toBe(4);
    expect(new Set(confirmed.coverage.map((c) => c.status)).size).toBeGreaterThan(1);
    expect(confirmed.requirements.every((r) => r.sourceSentence)).toBe(true);

    const draft = await netintel.projectCoverage(sctx, S.project.funding);
    expect(draft.requirementsConfirmed).toBe(false);

    const board = await netintel.listOpportunities(sctx);
    expect(new Set(board.opportunities.map((o) => o.stage)).size).toBeGreaterThanOrEqual(3);
    const maskedOpp = board.opportunities.find((o) => o.target?.contactId === S.c.hyunwoo);
    expect(maskedOpp?.target?.displayName).toBeNull();
    expect(maskedOpp?.target?.maskedLabel).toBeTruthy();
  });

  it("관계 인텔리전스·소속 이력·ICP·별칭이 채워져 있다", async () => {
    const S = await seedOnce();
    const sctx = ctx(SEED_USER_A);

    const intel = await netintel.relationshipIntelligence(sctx, S.c.minseo);
    expect(intel.strength.components).toHaveLength(9);
    expect(intel.strength.score100).toBeGreaterThan(0);
    expect(intel.strength.components.some((c) => c.value > 0)).toBe(true);
    expect(intel.activity.oneToOneCount).toBeGreaterThan(0);

    expect((await netintel.listEvidence(sctx, "contact", S.c.minseo)).evidence.length).toBeGreaterThanOrEqual(2);

    const roles = await netintel.listRoles(sctx, S.c.minseo);
    expect(roles.roles[0]!.roleCategory).toBe("구매/조달");
    expect(roles.roles[0]!.decidesFor).toBe(true);

    expect((await netintel.getIcp(sctx)).icp!.industries).toContain("의료기기");
    expect((await netintel.referralPartners(sctx)).needsIcp).toBe(false);

    const aliases = await netintel.listAliases(sctx);
    const medi = aliases.aliases.find((a) => a.alias === "메디텍");
    expect(medi).toBeTruthy();
    expect(medi!.scope).toBe("organization");

    // 조직 별칭으로 검색해도 조건이 잡힌다
    const found = await netintel.search(sctx, { query: "동남아 메디텍 유통사" });
    expect(found.parsedIntent.industries).toContain("의료기기");
    expect(found.parsedIntent.geographies).toContain("베트남");
  });

  it("조직 동료의 공유 연락처는 신원까지 보이고, 공유 안 한 연락처는 masked 다", async () => {
    const S = await seedOnce();
    const nb = await netintel.neighbors(ctx(SEED_USER_A), { hops: 3, limit: 300 });
    const byId = new Map(nb.neighbors.map((x) => [x.contactId, x]));
    // 백도현: scope='org' + share_permission='contact' → 신원 공개
    expect(byId.get(S.cc.dohyun)?.displayName).toBe("백도현");
    // 노현우: 동료 소유 + path_only → masked
    expect(byId.get(S.c.hyunwoo)?.displayName).toBeNull();
    expect(byId.get(S.c.hyunwoo)?.maskedLabel).toBeTruthy();
    // 조은별: 탐색 거부
    expect(byId.has(S.c.eunbyul)).toBe(false);
  });

  it("워커가 시드 데이터에서 엣지 강도와 품질 항목을 만들어낸다", async () => {
    const S = await seedOnce();
    expect(await jobs.recomputeContactEdges(200)).toBeGreaterThan(0);
    const computed = await q<{ id: string }>(
      "SELECT id FROM contact_relationships WHERE owner_user_id=$1 AND strength_computed_at IS NOT NULL",
      [SEED_USER_A],
    );
    expect(computed.length).toBeGreaterThan(0);

    await jobs.scanDataQuality(true);
    const kinds = (await q<{ kind: string }>("SELECT DISTINCT kind FROM data_quality_items WHERE owner_user_id=$1 AND status='open'", [SEED_USER_A])).map((k) => k.kind);
    // 시드가 일부러 남긴 중복 연락처와 끝난 소속을 잡아낸다
    expect(kinds).toContain("duplicate_contact");
    expect(kinds).toContain("stale_role");
    expect(S.c.minseoDup).toBeTruthy();
  });

  it("두 번 실행해도 행 수가 늘지 않는다(idempotent)", async () => {
    await seedOnce();
    const count = async () =>
      (await one<{ n: string }>(
        `SELECT ((SELECT count(*) FROM contacts) + (SELECT count(*) FROM contact_relationships)
               + (SELECT count(*) FROM project_requirements) + (SELECT count(*) FROM opportunities)
               + (SELECT count(*) FROM taxonomy_aliases) + (SELECT count(*) FROM contact_company_roles)
               + (SELECT count(*) FROM evidence_records) + (SELECT count(*) FROM network_activities))::text AS n`,
      ))!.n;
    const before = await count();
    await seedOnce();
    expect(await count()).toBe(before);
  });
});
