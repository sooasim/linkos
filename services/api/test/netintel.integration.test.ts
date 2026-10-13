// 인적네트워크 인텔리전스 통합테스트 (N-ID · docs/NETWORK_INTELLIGENCE.md §16 인수 게이트)
//
// 특히 아래 세 가지를 DB 를 거쳐 검증한다 — 순수 함수 단위테스트로는 잡히지 않는 부분이다:
//   * masked 후보의 PII 가 API 응답 **어디에도** 없다.
//   * 다른 소유자의 연락처 UUID 를 직접 조회해도 정보가 새지 않는다(테넌트 격리).
//   * 요구사항 초안은 사용자 확정 전까지 요구사항이 아니다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_x";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { identity, netintel, relationship, closePool, one, q } = api;

const ctx = (userId: string | null, ip = "10.9.0.1") => ({ userId, ip, userAgent: "test", requestId: "t" });
const consents = ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true }));
const stamp = Date.now();
let n = 0;

async function user(prefix: string) {
  const email = `${prefix}${stamp}-${n++}@netintel.test`;
  const { devCode } = await identity.requestOtp(ctx(null, `10.9.${n % 250}.1`), email);
  return (await identity.verifyOtp(ctx(null, `10.9.${n % 250}.1`), email, devCode!, consents)).user;
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

/** createContact 는 contact/encounter/relationship 을 함께 만든다 — 테스트는 연락처 id 만 필요하다. */
async function addContact(userId: string, input: ReturnType<typeof contact>): Promise<{ id: string }> {
  const r = await relationship.createContact(ctx(userId), input);
  return { id: r.contactId };
}

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await closePool();
});

describe("N-014 / N-016 하이브리드 검색", () => {
  it("내 연락처는 1촌으로 full 공개되고 조건 일치가 점수에 반영된다", async () => {
    const u = await user("search");
    await addContact(u.id, contact({ fullName: "의료기기유통대표", company: "베타메디" }));
    const res = await netintel.search(ctx(u.id), { query: "서울 의료기기 대표를 찾아줘" });
    expect(res.parsedIntent.industries).toContain("의료기기");
    expect(res.parsedIntent.geographies).toContain("서울");
    expect(res.results.length).toBeGreaterThan(0);
    const hit = res.results[0]!;
    expect(hit.disclosure).toBe("full");
    expect(hit.displayName).toBeTruthy();
    expect(hit.score).toBeGreaterThan(0);
    // 표준 응답 필드가 모두 있다(지침 §5)
    expect(hit).toHaveProperty("scoreComponents");
    expect(hit).toHaveProperty("evidence");
    expect(hit).toHaveProperty("paths");
    expect(hit).toHaveProperty("nextActions");
  });

  it("너무 짧은 질의는 400 이다", async () => {
    const u = await user("short");
    await expect(netintel.search(ctx(u.id), { query: "a" })).rejects.toMatchObject({ status: 400 });
  });

  it("필수 조건을 만족하지 못하는 후보는 점수와 무관하게 결과에서 빠진다 (hard gate)", async () => {
    const u = await user("must");
    await addContact(u.id, contact({ fullName: "게임회사대표", company: "감마게임즈", jobTitle: "대표", address: "부산" }));
    const res = await netintel.search(ctx(u.id), { query: "반드시 반도체 장비 회사" });
    expect(res.results.some((r) => r.displayName === "게임회사대표")).toBe(false);
  });

  it("chip 수정은 재파싱 없이 그대로 적용된다", async () => {
    const u = await user("chip");
    await addContact(u.id, contact({ fullName: "원격지대표", address: "베트남 하노이" }));
    const res = await netintel.search(ctx(u.id), { query: "서울 대표", intentEdits: { geographies: ["베트남"] } });
    expect(res.parsedIntent.geographies).toEqual(["베트남"]);
    expect(res.parsedIntent.provenance).toBe("user_edited");
  });
});

describe("N-022 masked 응답에 PII 가 없다 (인수 게이트)", () => {
  it("공유 범위를 path_only 로 둔 다른 소유자의 연락처는 신원이 공개되지 않는다", async () => {
    const owner = await user("owner");
    const c = await addContact(owner.id, contact({ fullName: "비공개대표", company: "시크릿메디칼", email: "secret@x.example.com" }));
    // 소유자 본인에게는 full 로 보인다
    const own = await netintel.search(ctx(owner.id), { query: "의료기기 대표" });
    expect(own.results.some((r) => r.displayName === "비공개대표")).toBe(true);

    // 다른 사용자는 그 UUID 를 직접 알아도 아무 정보를 얻지 못한다
    const stranger = await user("stranger");
    await expect(netintel.relationshipIntelligence(ctx(stranger.id), c.id)).rejects.toMatchObject({ status: 404 });
    await expect(netintel.getSharePermission(ctx(stranger.id), c.id)).rejects.toMatchObject({ status: 404 });
    const theirs = await netintel.search(ctx(stranger.id), { query: "의료기기 대표" });
    const json = JSON.stringify(theirs);
    for (const pii of ["비공개대표", "시크릿메디칼", "secret@x.example.com"]) expect(json).not.toContain(pii);
  });

  it("discovery_opt_out 연락처는 어떤 응답에도 등장하지 않는다", async () => {
    const u = await user("optout");
    const c = await addContact(u.id, contact({ fullName: "탐색거부대표" }));
    await netintel.setSharePermission(ctx(u.id), c.id, { discoveryOptOut: true, sharePermission: "none" });
    const res = await netintel.search(ctx(u.id), { query: "의료기기 대표" });
    expect(JSON.stringify(res)).not.toContain("탐색거부대표");
    const nb = await netintel.neighbors(ctx(u.id), { hops: 3 });
    expect(JSON.stringify(nb)).not.toContain("탐색거부대표");
    const slice = await netintel.graphSlice(ctx(u.id), { hops: 3 });
    expect(JSON.stringify(slice)).not.toContain("탐색거부대표");
    // 경로 API 도 막힌다
    await expect(netintel.introPaths(ctx(u.id), { targetContactId: c.id })).rejects.toMatchObject({ status: 403 });
  });

  it("그래프 slice 는 masked 노드의 raw identity 를 payload 에 넣지 않는다", async () => {
    const u = await user("slice");
    await addContact(u.id, contact({ fullName: "슬라이스대표" }));
    const slice = await netintel.graphSlice(ctx(u.id), { hops: 2, maxNodes: 50 });
    // 내 연락처라 이름이 보이는 것이 정상이다 — masked 노드만 가려진다
    expect(slice.nodes.some((x) => x.label === "슬라이스대표")).toBe(true);
    for (const node of slice.nodes) {
      if (node.masked) expect(node.label).toMatch(/촌/);
    }
    // 서버가 좌표까지 계산해 준다(브라우저가 전체 그래프를 받아 숨기지 않는다)
    expect(slice.nodes.every((x) => typeof x.x === "number" && typeof x.y === "number")).toBe(true);
  });

  it("공개 권한 변경은 audit 에 남는다", async () => {
    const u = await user("audit");
    const c = await addContact(u.id, contact());
    await netintel.setSharePermission(ctx(u.id), c.id, { sharePermission: "profile" });
    const row = await one<{ n: number }>("SELECT count(*)::int AS n FROM audit_logs WHERE actor_user_id=$1 AND action='netintel.share_permission_changed'", [u.id]);
    expect(row!.n).toBeGreaterThan(0);
    expect((await netintel.getSharePermission(ctx(u.id), c.id)).sharePermission).toBe("profile");
  });
});

describe("N-103 / N-104 / N-109 관계강도와 활동", () => {
  it("활동 기록이 관계강도 신호와 evidence 를 함께 만든다", async () => {
    const u = await user("intel");
    const c = await addContact(u.id, contact({ fullName: "활동대표" }));
    const before = await netintel.relationshipIntelligence(ctx(u.id), c.id);

    await netintel.recordActivity(ctx(u.id), { contactId: c.id, activityType: "one_to_one", durationMinutes: 90 });
    await netintel.recordActivity(ctx(u.id), { contactId: c.id, activityType: "referral_given", outcome: "won" });

    const after = await netintel.relationshipIntelligence(ctx(u.id), c.id);
    expect(after.signals.meeting_depth).toBeGreaterThan(before.signals.meeting_depth);
    expect(after.signals.referral_success).toBe(1);
    expect(after.activity.oneToOneCount).toBe(1);
    expect(after.activity.referralsSucceeded).toBe(1);
    expect(after.strength.score100).toBeGreaterThanOrEqual(before.strength.score100);

    // 모든 활동은 evidence 로도 남는다(N-108) — 근거 없는 주장이 생기지 않는다
    const ev = await netintel.listEvidence(ctx(u.id), "contact", c.id);
    expect(ev.evidence.length).toBeGreaterThanOrEqual(2);
    expect(ev.evidence.every((e) => e.summary.length > 0)).toBe(true);
    // 근거 요약에 연락처 원문이 들어가지 않는다
    expect(JSON.stringify(ev.evidence)).not.toContain("821012345678");
  });

  it("구성요소 합이 점수와 일치하고 9개 신호가 모두 보고된다", async () => {
    const u = await user("comp");
    const c = await addContact(u.id, contact());
    const r = await netintel.relationshipIntelligence(ctx(u.id), c.id);
    expect(r.strength.components).toHaveLength(9);
    const sum = r.strength.components.reduce((a, x) => a + x.contribution, 0);
    expect(Math.round(sum * 100)).toBe(r.strength.score100);
  });

  it("사용자 교정이 신호 샘플과 audit 를 남긴다", async () => {
    const u = await user("correct");
    const c = await addContact(u.id, contact());
    const r = await netintel.correctRelationship(ctx(u.id), c.id, { userTrust: 0.9, label: "wrong_relationship" });
    expect(r.signals.user_trust).toBeCloseTo(0.9, 3);
    const samples = await q<{ signal_type: string }>("SELECT signal_type FROM relationship_signal_samples WHERE owner_user_id=$1", [u.id]);
    expect(samples.some((s) => s.signal_type === "user_trust")).toBe(true);
    const fb = await q<{ label: string }>("SELECT label FROM recommendation_feedback WHERE owner_user_id=$1", [u.id]);
    expect(fb.some((x) => x.label === "wrong_relationship")).toBe(true);
  });

  it("범위를 벗어난 신뢰도는 400 이다", async () => {
    const u = await user("trustbad");
    const c = await addContact(u.id, contact());
    await expect(netintel.correctRelationship(ctx(u.id), c.id, { userTrust: 2 })).rejects.toMatchObject({ status: 400 });
  });
});

describe("N-105 소개 경로", () => {
  it("1촌은 중개자 없이 직접 경로가 나온다", async () => {
    const u = await user("path1");
    const c = await addContact(u.id, contact({ fullName: "직접아는대표" }));
    const res = await netintel.introPaths(ctx(u.id), { targetContactId: c.id });
    expect(res.paths.length).toBeGreaterThan(0);
    expect(res.paths[0]!.hops).toBe(1);
    expect(res.paths[0]!.introducerId).toBeNull();
    expect(res.target.displayName).toBe("직접아는대표");
  });

  it("연락처끼리의 관계로 2촌 경로와 중개자가 만들어진다", async () => {
    const u = await user("path2");
    const mid = await addContact(u.id, contact({ fullName: "중개자" }));
    const target = await addContact(u.id, contact({ fullName: "최종대상" }));
    await q(
      `INSERT INTO contact_relationships (owner_user_id, from_contact_id, to_contact_id, rel_type, strength, confirmed) VALUES ($1,$2,$3,'knows',0.8,true)`,
      [u.id, mid.id, target.id],
    );
    const res = await netintel.introPaths(ctx(u.id), { targetContactId: target.id, maxHops: 3, k: 3 });
    // 내 연락처라 1촌 직접 경로도 있고, 중개자를 거치는 경로도 후보로 나온다
    expect(res.paths.length).toBeGreaterThan(1);
    const viaMid = res.paths.find((p) => p.nodeIds.includes(mid.id));
    expect(viaMid).toBeTruthy();
    expect(viaMid!.introducerId).toBe(mid.id);
    // 경로 노드에 라벨이 붙는다
    expect(viaMid!.nodes[0]!.label).toBe("나");
  });

  it("존재하지 않는 대상은 404 다", async () => {
    const u = await user("path404");
    await expect(netintel.introPaths(ctx(u.id), { targetContactId: "00000000-0000-0000-0000-0000000000ff" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("N-018 / N-019 프로젝트 커버리지", () => {
  it("분해 결과는 초안이며 확정 전까지 요구사항이 아니다", async () => {
    const u = await user("proj");
    const p = await netintel.createProject(ctx(u.id), {
      name: "베트남 의료기기 유통 진출",
      description: "현지 유통 파트너가 필요합니다.\n구매 담당자를 소개받고 싶습니다.",
      targetIndustries: ["의료기기"],
      targetRegions: ["베트남"],
    });
    const analysis = await netintel.analyzeProject(ctx(u.id), p.projectId);
    expect(analysis.needsReview).toBe(true);
    expect(analysis.drafts).toBeGreaterThan(0);

    const before = await netintel.projectCoverage(ctx(u.id), p.projectId);
    expect(before.requirementsConfirmed).toBe(false);
    expect(before.requirements.every((r) => !r.accepted)).toBe(true);
    // 모든 초안은 출처 문장을 보존한다
    expect(before.requirements.every((r) => (r.provenance === "rule_parsed" ? Boolean(r.sourceSentence) : true))).toBe(true);

    // 하나만 확정하면 나머지 초안은 삭제된다(사용자가 거부한 것)
    const keep = before.requirements[0]!.id;
    await netintel.confirmRequirements(ctx(u.id), p.projectId, { requirementIds: [keep] });
    const after = await netintel.projectCoverage(ctx(u.id), p.projectId);
    expect(after.requirementsConfirmed).toBe(true);
    expect(after.requirements).toHaveLength(1);
    expect(after.requirements[0]!.accepted).toBe(true);
  });

  it("후보가 없으면 gap, 있으면 covered/partial 로 집계하고 외부 provider 제안은 승인을 요구한다", async () => {
    const u = await user("cov");
    const p = await netintel.createProject(ctx(u.id), { name: "장비 소싱", description: "반도체 장비 공급사가 필요합니다." });
    await netintel.analyzeProject(ctx(u.id), p.projectId);
    const cov = await netintel.projectCoverage(ctx(u.id), p.projectId);
    expect(cov.coverage.length).toBeGreaterThan(0);
    expect(cov.coverage.every((c) => ["covered", "partial", "gap"].includes(c.status))).toBe(true);
    expect(cov.summary.total).toBe(cov.coverage.length);
    const ext = cov.gapSuggestions.find((s) => s.action === "external_provider");
    if (ext) expect(ext.requiresApproval).toBe(true);
  });

  it("다른 소유자의 프로젝트는 404 다", async () => {
    const a = await user("pa");
    const b = await user("pb");
    const p = await netintel.createProject(ctx(a.id), { name: "비공개 프로젝트", description: "파트너가 필요합니다." });
    await expect(netintel.projectCoverage(ctx(b.id), p.projectId)).rejects.toMatchObject({ status: 404 });
    await expect(netintel.analyzeProject(ctx(b.id), p.projectId)).rejects.toMatchObject({ status: 404 });
  });

  it("이름 없는 프로젝트는 400 이다", async () => {
    const u = await user("pname");
    await expect(netintel.createProject(ctx(u.id), { name: "  " })).rejects.toMatchObject({ status: 400 });
  });
});

describe("N-021 기회 파이프라인", () => {
  it("허용된 전이만 통과하고 결과는 학습 라벨로 기록된다", async () => {
    const u = await user("opp");
    const c = await addContact(u.id, contact({ fullName: "기회대상" }));
    const o = await netintel.createOpportunity(ctx(u.id), { targetContactId: c.id, score: 72 });
    expect(o.stage).toBe("detected");

    await expect(netintel.advanceOpportunity(ctx(u.id), o.opportunityId, { stage: "won" })).rejects.toMatchObject({ status: 409 });
    await netintel.advanceOpportunity(ctx(u.id), o.opportunityId, { stage: "qualified" });
    await netintel.advanceOpportunity(ctx(u.id), o.opportunityId, { stage: "intro_requested" });

    const fb = await q<{ label: string }>("SELECT label FROM recommendation_feedback WHERE owner_user_id=$1 AND subject_type='opportunity'", [u.id]);
    expect(fb.map((x) => x.label)).toContain("qualified");
    expect(fb.map((x) => x.label)).toContain("intro_requested");

    const board = await netintel.listOpportunities(ctx(u.id));
    expect(board.opportunities.find((x) => x.id === o.opportunityId)!.stage).toBe("intro_requested");
    expect(board.columns.length).toBeGreaterThan(0);
  });

  it("같은 대상에 대한 중복 기회는 409 다", async () => {
    const u = await user("oppdup");
    const c = await addContact(u.id, contact());
    await netintel.createOpportunity(ctx(u.id), { targetContactId: c.id });
    await expect(netintel.createOpportunity(ctx(u.id), { targetContactId: c.id })).rejects.toMatchObject({ status: 409 });
  });

  it("기회 탐지와 결과 기록이 outbox 이벤트를 남긴다 (N-013)", async () => {
    const u = await user("oppevent");
    const c = await addContact(u.id, contact());
    const o = await netintel.createOpportunity(ctx(u.id), { targetContactId: c.id });
    await netintel.advanceOpportunity(ctx(u.id), o.opportunityId, { stage: "qualified" });
    const events = await q<{ event_type: string }>("SELECT event_type FROM outbox_events WHERE aggregate_id=$1", [o.opportunityId]);
    expect(events.map((e) => e.event_type)).toContain("network.opportunity.detected");
    expect(events.map((e) => e.event_type)).toContain("network.outcome.recorded");
  });
});

describe("N-106 저장된 검색", () => {
  it("저장·실행·삭제가 동작하고 재실행 시 새 후보만 표시한다", async () => {
    const u = await user("saved");
    await addContact(u.id, contact({ fullName: "저장검색대상" }));
    const s = await netintel.saveSearch(ctx(u.id), { query: "서울 의료기기 대표", alertEnabled: true, alertFrequency: "weekly" });
    expect((await netintel.listSavedSearches(ctx(u.id))).savedSearches).toHaveLength(1);

    const first = await netintel.runSavedSearch(ctx(u.id), s.savedSearchId);
    expect(first.newCount).toBe(first.results.length);
    const second = await netintel.runSavedSearch(ctx(u.id), s.savedSearchId);
    expect(second.newCount).toBe(0); // 같은 후보를 다시 알리지 않는다

    await netintel.deleteSavedSearch(ctx(u.id), s.savedSearchId);
    expect((await netintel.listSavedSearches(ctx(u.id))).savedSearches).toHaveLength(0);
  });

  it("다른 소유자의 저장된 검색은 404 다", async () => {
    const a = await user("sa");
    const b = await user("sb");
    const s = await netintel.saveSearch(ctx(a.id), { query: "의료기기 유통" });
    await expect(netintel.runSavedSearch(ctx(b.id), s.savedSearchId)).rejects.toMatchObject({ status: 404 });
    await expect(netintel.deleteSavedSearch(ctx(b.id), s.savedSearchId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("N-110 ICP / Referral Partner", () => {
  it("ICP 가 없으면 파트너 추천 대신 설정을 요구한다", async () => {
    const u = await user("noicp");
    expect((await netintel.referralPartners(ctx(u.id))).needsIcp).toBe(true);
  });

  it("ICP 를 저장하면 교차 소개 가능성을 계산한다", async () => {
    const u = await user("icp");
    await netintel.setIcp(ctx(u.id), { industries: ["의료기기"], regions: ["서울"], roleCategories: ["구매/조달"], needs: ["의료기기 조달"] });
    const got = await netintel.getIcp(ctx(u.id));
    expect(got.icp!.industries).toContain("의료기기");
    expect(got.options.industries.length).toBeGreaterThan(10);

    const mid = await addContact(u.id, contact({ fullName: "파트너후보", jobTitle: "영업이사", company: "델타유통" }));
    const buyer = await addContact(u.id, contact({ fullName: "병원구매과장", jobTitle: "구매 과장", company: "서울메디칼", address: "서울" }));
    await q(
      `INSERT INTO contact_relationships (owner_user_id, from_contact_id, to_contact_id, rel_type, strength, confirmed) VALUES ($1,$2,$3,'knows',0.8,true)`,
      [u.id, mid.id, buyer.id],
    );
    const res = await netintel.referralPartners(ctx(u.id));
    expect(res.needsIcp).toBe(false);
    expect(res.partners.every((p) => p.score >= 0 && p.score <= 100)).toBe(true);
    // ICP 적합도 단건 조회도 동작한다
    const fit = await netintel.icpFitFor(ctx(u.id), buyer.id);
    expect(fit.needsIcp).toBe(false);
    expect(fit.fit!.score).toBeGreaterThan(0);
  });

  it("ICP 저장은 기본 프로필 하나만 유지한다", async () => {
    const u = await user("icpone");
    await netintel.setIcp(ctx(u.id), { industries: ["제약·바이오"] });
    await netintel.setIcp(ctx(u.id), { industries: ["반도체"] });
    const rows = await q<{ n: string }>("SELECT count(*)::text AS n FROM ideal_customer_profiles WHERE owner_user_id=$1 AND is_default", [u.id]);
    expect(Number(rows[0]!.n)).toBe(1);
    expect((await netintel.getIcp(ctx(u.id))).icp!.industries).toEqual(["반도체"]);
  });
});

describe("N-011 분류 · N-024 데이터 품질", () => {
  it("분류 사전을 제공한다", () => {
    const t = netintel.taxonomy();
    expect(t.industries.some((i) => i.name === "의료기기")).toBe(true);
    expect(t.regions.some((r) => r.name === "베트남")).toBe(true);
    expect(t.roleCategories.some((r) => r.name === "구매/조달")).toBe(true);
  });

  it("Capability 를 등록하고 연락처에 제공/필요로 연결한다", async () => {
    const u = await user("cap");
    const c = await addContact(u.id, contact());
    const cap = await netintel.upsertCapability(ctx(u.id), { name: "의료기기 유통" });
    await netintel.linkCapability(ctx(u.id), { contactId: c.id, capabilityId: cap.capabilityId, kind: "provides" });
    await netintel.linkCapability(ctx(u.id), { contactId: c.id, capabilityId: cap.capabilityId, kind: "needs" });
    const rows = await q<{ kind: string }>("SELECT kind FROM contact_capabilities WHERE contact_id=$1", [c.id]);
    // 제공과 필요는 서로 다른 행이다(섞지 않는다 — 지침 §10)
    expect(rows.map((r) => r.kind).sort()).toEqual(["needs", "provides"]);

    // 같은 이름을 다시 등록하면 같은 id 를 돌려준다
    expect((await netintel.upsertCapability(ctx(u.id), { name: " 의료기기  유통 " })).capabilityId).toBe(cap.capabilityId);
  });

  it("데이터 품질 요약과 projection 지연을 보고한다", async () => {
    const u = await user("dq");
    await addContact(u.id, contact());
    const dq = await netintel.dataQuality(ctx(u.id));
    expect(dq.projection).toHaveProperty("pending");
    expect(dq.projection).toHaveProperty("degraded");
    // 공유 범위를 설정하지 않은 연락처를 알려준다
    expect(dq.contactsWithoutSharePermission).toBeGreaterThan(0);
  });

  it("evidence 기록은 소유자에게만 보인다", async () => {
    const a = await user("eva");
    const b = await user("evb");
    const c = await addContact(a.id, contact());
    await netintel.recordEvidence(ctx(a.id), { entityType: "contact", entityId: c.id, evidenceType: "user_confirmed", summary: "직접 확인한 관계" });
    expect((await netintel.listEvidence(ctx(a.id), "contact", c.id)).evidence).toHaveLength(1);
    expect((await netintel.listEvidence(ctx(b.id), "contact", c.id)).evidence).toHaveLength(0);
  });
});

describe("인증 경계", () => {
  it("로그인하지 않은 호출은 401 이다", async () => {
    await expect(netintel.search(ctx(null), { query: "의료기기" })).rejects.toMatchObject({ status: 401 });
    await expect(netintel.listProjects(ctx(null))).rejects.toMatchObject({ status: 401 });
    await expect(netintel.graphSlice(ctx(null))).rejects.toMatchObject({ status: 401 });
    await expect(netintel.referralPartners(ctx(null))).rejects.toMatchObject({ status: 401 });
  });
});
