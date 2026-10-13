// 인적네트워크 인텔리전스 도메인 단위테스트 (N-ID · docs/NETWORK_INTELLIGENCE.md §16 인수 게이트)
import { describe, expect, it } from "vitest";
import {
  COVERED_MIN_SCORE,
  type CandidateFacts,
  type DisclosureSubject,
  type Evidence,
  type NetworkActivity,
  type NetworkEdge,
  type SearchIntent,
  EDGE_FACTOR_FLOOR,
  INFERRED_ONLY_CAP,
  INDUSTRIES,
  InMemoryGraphRepository,
  LexicalVectorIndex,
  MAX_3D_NODES,
  NETWORK_EVENT_NAMES,
  RECO_WEIGHTS,
  REL_WEIGHTS,
  activityContribution,
  activityStats,
  applyDisclosure,
  availabilityFrom,
  canOpportunityTransition,
  canonicalKey,
  coverageFor,
  coverageSummary,
  decomposeProject,
  deriveFeatures,
  deriveRelSignals,
  discoverNeighbors,
  diversify,
  edgeQuality,
  enumeratePaths,
  evaluateDisclosure,
  evidenceQuality,
  findIndustries,
  findRegions,
  findWithAliases,
  forceLayout3D,
  gapSuggestions,
  groundedReasons,
  hardGate,
  icpFit,
  industryWithParents,
  isNetworkEventName,
  maskedLabel,
  nextActions,
  normalizeIndustry,
  normalizeRegion,
  oneToOneHealth,
  opportunityHealth,
  outcomeLabelFor,
  parseSearchIntent,
  pathCost,
  pathQualityFeature,
  projectionLag,
  rankBusinessPaths,
  rankReferralPartners,
  reachableSet,
  normalizeAlias,
  recencyDecay,
  relationshipStrength,
  roleCategory,
  scoreRecommendation,
  shareabilityFrom,
  tauForRelation,
  unmetMustHave,
  validateAlias,
  validateParsedIntent,
} from "../src/index";

// ---------------------------------------------------------------- N-022 공개 판정

const subject = (over: Partial<DisclosureSubject> = {}): DisclosureSubject => ({
  ownedByViewer: false,
  hops: 2,
  sharePermission: "path_only",
  optOut: false,
  deleted: false,
  introApproved: false,
  orgShareOptIn: null,
  ...over,
});

describe("N-022 공개 판정 5단계", () => {
  it("내가 보유한 연락처는 신원과 연락처를 모두 본다", () => {
    const d = evaluateDisclosure(subject({ ownedByViewer: true, hops: 1, sharePermission: "contact" }));
    expect(d.level).toBe("full");
    expect(d.gates.can_reveal_contact).toBe(true);
  });

  it("2촌 path_only 연락처는 masked 이고 신원이 열리지 않는다", () => {
    const d = evaluateDisclosure(subject());
    expect(d.level).toBe("masked");
    expect(d.gates.can_discover).toBe(true);
    expect(d.gates.can_request_intro).toBe(true);
    expect(d.gates.can_reveal_identity).toBe(false);
    expect(d.gates.can_reveal_contact).toBe(false);
  });

  it("각 단계는 앞 단계를 통과해도 자동으로 열리지 않는다 — profile 공유는 신원까지만", () => {
    const d = evaluateDisclosure(subject({ sharePermission: "profile" }));
    expect(d.gates.can_reveal_identity).toBe(true);
    expect(d.gates.can_reveal_contact).toBe(false);
    expect(d.level).toBe("intro_only");
  });

  it("연락처는 소개 승인 이후 + contact 이상 공유일 때만 열린다", () => {
    expect(evaluateDisclosure(subject({ sharePermission: "contact", introApproved: false })).gates.can_reveal_contact).toBe(false);
    expect(evaluateDisclosure(subject({ sharePermission: "contact", introApproved: true })).gates.can_reveal_contact).toBe(true);
    // profile 공유는 소개가 승인되어도 연락처까지 가지 않는다
    expect(evaluateDisclosure(subject({ sharePermission: "profile", introApproved: true })).gates.can_reveal_contact).toBe(false);
  });

  it("opt-out · 삭제 · 조직공유 거부는 탐색 자체를 막는다(hidden)", () => {
    for (const over of [{ optOut: true }, { deleted: true }, { orgShareOptIn: false }] as Partial<DisclosureSubject>[]) {
      const d = evaluateDisclosure(subject(over));
      expect(d.level).toBe("hidden");
      expect(d.gates.can_discover).toBe(false);
      expect(d.consentGate).toBe(0);
    }
  });

  it("share_permission=none 이면 후보로 등장하지 않는다", () => {
    expect(evaluateDisclosure(subject({ sharePermission: "none" })).level).toBe("hidden");
  });

  it("consentGate 는 소개 요청 가능 여부와 같다 — EdgeQuality 를 0 으로 만든다", () => {
    expect(evaluateDisclosure(subject()).consentGate).toBe(1);
    expect(evaluateDisclosure(subject({ optOut: true })).consentGate).toBe(0);
  });
});

describe("N-022 masked payload 에 PII 가 없다 (인수 게이트)", () => {
  const identity = {
    id: "c1",
    type: "person" as const,
    displayName: "김철수",
    companyName: "알파메디칼",
    jobTitle: "대표이사",
    email: "chulsoo@alpha.example.com",
    phone: "+821012345678",
    industry: "의료기기",
    region: "서울",
  };

  it("masked 후보 응답에 이름·회사·이메일·전화가 어떤 필드에도 없다", () => {
    const d = evaluateDisclosure(subject());
    const out = applyDisclosure(identity, d, { hops: 2, industry: "의료기기", region: "서울", hasPath: true });
    expect(out).not.toBeNull();
    const json = JSON.stringify(out);
    for (const pii of ["김철수", "알파메디칼", "chulsoo", "821012345678", "대표이사"]) {
      expect(json).not.toContain(pii);
    }
    expect(out!.displayName).toBeNull();
    expect(out!.companyName).toBeNull();
    expect(out!.email).toBeNull();
    expect(out!.phone).toBeNull();
    expect(out!.maskedLabel).toBe("2촌 · 의료기기 · 대표/창업자 · 서울 · 소개경로 있음");
  });

  it("호출자가 들고 있는 추가 PII 는 allowlist 때문에 응답에 새지 않는다", () => {
    const d = evaluateDisclosure(subject());
    const leaky = { ...identity, secretNote: "집주소 서울시 강남구 ...", ssn: "900101-1234567" } as typeof identity;
    const json = JSON.stringify(applyDisclosure(leaky, d, { hops: 2, hasPath: true }));
    expect(json).not.toContain("강남구");
    expect(json).not.toContain("900101");
  });

  it("hidden 은 null 을 돌려줘 목록에서 빠진다", () => {
    expect(applyDisclosure(identity, evaluateDisclosure(subject({ optOut: true })), { hops: 2, hasPath: false })).toBeNull();
  });

  it("full 공개일 때만 연락처가 담긴다", () => {
    const d = evaluateDisclosure(subject({ ownedByViewer: true, hops: 1, sharePermission: "contact" }));
    const out = applyDisclosure(identity, d, { hops: 1, hasPath: true })!;
    expect(out.email).toBe(identity.email);
    expect(out.maskedLabel).toBeNull();
  });

  it("직책은 카테고리로 뭉개진다", () => {
    expect(roleCategory("대표이사")).toBe("대표/창업자");
    expect(roleCategory("구매팀 과장")).toBe("중간관리자");
    expect(roleCategory(null)).toBeNull();
  });

  it("masked 라벨은 경로 유무를 밝힌다", () => {
    expect(maskedLabel({ hops: 3, industry: "유통·도소매", region: "베트남", hasPath: false })).toBe("3촌 · 유통·도소매 · 베트남 · 소개경로 없음");
  });

  it("nextActions 는 공개 수준에 따라 달라진다", () => {
    expect(nextActions(evaluateDisclosure(subject()))).toContain("request_intro");
    expect(nextActions(evaluateDisclosure(subject()))).not.toContain("contact_directly");
    expect(nextActions(evaluateDisclosure(subject({ ownedByViewer: true, sharePermission: "contact" })))).toContain("contact_directly");
  });
});

// ---------------------------------------------------------------- N-103 / N-104 관계강도

describe("N-103 관계강도 9신호", () => {
  it("가중치 합이 1 이다", () => {
    expect(Object.values(REL_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("모든 신호가 1 이면 만점, 0 이면 0 점", () => {
    const all = (v: number) => Object.fromEntries(Object.keys(REL_WEIGHTS).map((k) => [k, v])) as Record<keyof typeof REL_WEIGHTS, number>;
    expect(relationshipStrength(all(1)).score).toBeCloseTo(1, 6);
    expect(relationshipStrength(all(0)).score).toBe(0);
  });

  it("frequency·recency·reciprocity 증가가 점수를 올린다 (인수 게이트)", () => {
    const base = deriveRelSignals(obs({}));
    const better = deriveRelSignals(obs({ encounters90d: 6, encountersTotal: 20, daysSinceLastContact: 3, inboundCount: 5, outboundCount: 5 }));
    expect(relationshipStrength(better).score).toBeGreaterThan(relationshipStrength(base).score);
    // 개별 신호도 방향이 맞아야 한다
    expect(better.frequency).toBeGreaterThan(base.frequency);
    expect(better.recency).toBeGreaterThan(base.recency);
    expect(better.reciprocity).toBeGreaterThan(base.reciprocity);
  });

  it("구성요소를 기여도 순으로 돌려주고 합이 점수와 같다", () => {
    const r = relationshipStrength(deriveRelSignals(obs({})));
    expect(r.components).toHaveLength(9);
    for (let i = 1; i < r.components.length; i++) {
      expect(r.components[i - 1]!.contribution).toBeGreaterThanOrEqual(r.components[i]!.contribution);
    }
    const sum = r.components.reduce((a, c) => a + c.contribution, 0);
    expect(r.score).toBeCloseTo(Math.round(sum * 1000) / 1000, 2);
  });

  it("inferred 전용 관계는 confidence 상한이 걸린다", () => {
    const strong = Object.fromEntries(Object.keys(REL_WEIGHTS).map((k) => [k, 1])) as Record<keyof typeof REL_WEIGHTS, number>;
    const capped = relationshipStrength(strong, { inferred: true, confirmed: false });
    expect(capped.confidenceCap).toBe(INFERRED_ONLY_CAP);
    expect(capped.score).toBeLessThanOrEqual(INFERRED_ONLY_CAP);
    // 사용자가 확인하면 상한이 풀린다
    expect(relationshipStrength(strong, { inferred: true, confirmed: true }).confidenceCap).toBeNull();
  });

  it("신호별 evidenceId 를 보존한다 (N-108)", () => {
    const r = relationshipStrength(deriveRelSignals(obs({})), { evidence: { meeting_depth: "ev-1" } });
    expect(r.components.find((c) => c.kind === "meeting_depth")!.evidenceId).toBe("ev-1");
    expect(r.components.find((c) => c.kind === "frequency")!.evidenceId).toBeNull();
  });

  it("접촉 기록이 없으면 recency 를 추측하지 않고 0 이다", () => {
    expect(recencyDecay(null)).toBe(0);
    expect(deriveRelSignals(obs({ daysSinceLastContact: null })).recency).toBe(0);
  });
});

describe("N-104 감쇠와 휴면", () => {
  it("관계 유형별 tau 가 다르다 — 투자 관계가 지인보다 천천히 식는다", () => {
    expect(tauForRelation("investor")).toBeGreaterThan(tauForRelation("knows"));
    expect(recencyDecay(200, tauForRelation("investor"))).toBeGreaterThan(recencyDecay(200, tauForRelation("knows")));
  });

  it("휴면 관계에 stale 신호가 표시된다 (인수 게이트)", () => {
    const r = relationshipStrength(deriveRelSignals(obs({ daysSinceLastContact: 400 })), { daysSinceLastContact: 400, relationType: "knows" });
    expect(r.stale.isStale).toBe(true);
    expect(r.stale.text).toContain("400일째");
  });

  it("최근 접촉이 있으면 stale 이 아니다", () => {
    expect(relationshipStrength(deriveRelSignals(obs({})), { daysSinceLastContact: 10 }).stale.isStale).toBe(false);
  });

  it("recency 는 단조 감소한다", () => {
    expect(recencyDecay(0)).toBe(1);
    expect(recencyDecay(30)).toBeGreaterThan(recencyDecay(90));
    expect(recencyDecay(90)).toBeGreaterThan(recencyDecay(365));
  });
});

describe("N-105 EdgeQuality", () => {
  it("consentGate=0 이면 엣지 품질이 0 이다 — 경로에 쓰이지 않는다", () => {
    expect(edgeQuality({ strength: 0.9, shareability: 0.9, availability: 0.9, contextFit: 0.9, consentGate: 0 })).toBe(0);
  });

  it("미지의 factor 가 엣지를 죽이지 않도록 floor 가 적용된다", () => {
    const q = edgeQuality({ strength: 0.8, shareability: 0, availability: 0, contextFit: 0, consentGate: 1 });
    expect(q).toBeCloseTo(0.8 * EDGE_FACTOR_FLOOR ** 3, 3);
    expect(q).toBeGreaterThan(0);
  });

  it("strength 에는 floor 가 없다 — 관계가 없으면 엣지도 없다", () => {
    expect(edgeQuality({ strength: 0, shareability: 1, availability: 1, contextFit: 1, consentGate: 1 })).toBe(0);
  });

  it("shareability/availability 기본값 계산", () => {
    expect(shareabilityFrom(0, 0)).toBe(0.5); // 이력 없음 = 중립
    expect(shareabilityFrom(4, 3)).toBe(0.75);
    expect(availabilityFrom(null)).toBe(0.4);
    expect(availabilityFrom(0)).toBe(1);
    expect(availabilityFrom(180)).toBeLessThan(0.2);
  });
});

// ---------------------------------------------------------------- N-014 / N-105 경로

/** me → a → target, me → b → target, me → a → c → target 의 3경로 fixture */
function fixtureEdges(): NetworkEdge[] {
  const e = (fromId: string, toId: string, quality: number, over: Partial<NetworkEdge> = {}): NetworkEdge => ({
    fromId,
    toId,
    relation: "KNOWS",
    quality,
    strength: quality,
    confirmed: true,
    dormancy: 0,
    privacy: 0,
    ...over,
  });
  return [
    e("me", "a", 0.8, { companyId: "co-a" }),
    e("me", "b", 0.7, { companyId: "co-b" }),
    e("me", "d", 0.6, { companyId: "co-d" }),
    e("a", "target", 0.75, { companyId: "co-t" }),
    e("b", "target", 0.65, { companyId: "co-t" }),
    e("a", "c", 0.9, { companyId: "co-c" }),
    e("c", "target", 0.8, { companyId: "co-t" }),
    e("d", "target", 0.5, { companyId: "co-t", dormancy: 0.9 }),
    e("me", "blocked", 0, { companyId: "co-x" }),
    e("blocked", "target", 0.9),
  ];
}

describe("N-014 1~3촌 탐색", () => {
  it("촌수와 최선 품질을 함께 돌려준다", () => {
    const n = discoverNeighbors(fixtureEdges(), "me", 3);
    const byId = new Map(n.map((x) => [x.nodeId, x]));
    expect(byId.get("a")!.hops).toBe(1);
    expect(byId.get("target")!.hops).toBe(2);
    expect(byId.get("c")!.hops).toBe(2);
    expect(byId.get("target")!.bestQuality).toBeCloseTo(0.8 * 0.75, 3);
  });

  it("첫 중개자(viaId)를 알려준다", () => {
    const n = discoverNeighbors(fixtureEdges(), "me", 3);
    expect(n.find((x) => x.nodeId === "c")!.viaId).toBe("a");
    expect(n.find((x) => x.nodeId === "a")!.viaId).toBe("a");
  });

  it("consentGate=0 엣지는 그래프에 올라가지 않는다", () => {
    const n = discoverNeighbors(fixtureEdges(), "me", 3);
    expect(n.some((x) => x.nodeId === "blocked")).toBe(false);
  });

  it("maxHops 를 넘는 노드는 돌려주지 않는다", () => {
    expect(discoverNeighbors(fixtureEdges(), "me", 1).every((x) => x.hops === 1)).toBe(true);
  });
});

describe("N-105 Top-K 소개 경로", () => {
  it("동일 fixture 에서 대안 경로가 최소 3개 생성된다 (인수 게이트)", () => {
    const paths = enumeratePaths(fixtureEdges(), "me", "target", 3);
    expect(paths.length).toBeGreaterThanOrEqual(4);
    const ranked = rankBusinessPaths(paths, { k: 3 });
    expect(ranked).toHaveLength(3);
    expect(new Set(ranked.map((p) => p.nodeIds.join(">")))).toHaveProperty("size", 3);
  });

  it("최단 경로가 아니라 품질이 좋은 경로가 1순위가 될 수 있다", () => {
    // d 를 거치는 2-hop 경로는 휴면 페널티가 커서, 품질 좋은 다른 2-hop 보다 비싸야 한다
    const paths = enumeratePaths(fixtureEdges(), "me", "target", 3);
    const dormant = paths.find((p) => p.nodeIds.includes("d"))!;
    const good = paths.find((p) => p.nodeIds.join(">") === "me>a>target")!;
    expect(pathCost(dormant).cost).toBeGreaterThan(pathCost(good).cost);
  });

  it("경로 비용은 공식의 각 항으로 분해되어 설명된다", () => {
    const paths = enumeratePaths(fixtureEdges(), "me", "target", 3);
    const { breakdown } = pathCost(paths[0]!, { conflict: 0.5, sharedContext: 1 });
    expect(breakdown.conflict).toBeCloseTo(0.15 * 0.5, 6);
    expect(breakdown.sharedContext).toBeCloseTo(-0.25, 6);
    expect(breakdown.edgeCost).toBeGreaterThan(0);
  });

  it("공유 맥락 보너스는 비용을 내리고 이해충돌은 올린다", () => {
    const p = enumeratePaths(fixtureEdges(), "me", "target", 3)[0]!;
    expect(pathCost(p, { sharedContext: 1 }).cost).toBeLessThan(pathCost(p).cost);
    expect(pathCost(p, { conflict: 1 }).cost).toBeGreaterThan(pathCost(p).cost);
  });

  it("다양성 페널티로 같은 소개자가 Top-K 를 독점하지 않는다", () => {
    const paths = enumeratePaths(fixtureEdges(), "me", "target", 3);
    const ranked = rankBusinessPaths(paths, { k: 3 });
    const introducers = ranked.map((p) => p.introducerId);
    expect(new Set(introducers).size).toBeGreaterThan(1);
  });

  it("경로에 masked 노드가 있으면 disclosure 가 masked 다", () => {
    const paths = enumeratePaths(fixtureEdges(), "me", "target", 3);
    const ranked = rankBusinessPaths(paths, { k: 1, maskedNodeIds: new Set(["target"]) });
    expect(ranked[0]!.disclosure).toBe("masked");
    expect(ranked[0]!.reasons.some((r) => r.includes("비공개"))).toBe(true);
  });

  it("경로 품질은 엣지 품질의 곱이다", () => {
    const direct: NetworkEdge[] = [{ fromId: "me", toId: "t", relation: "KNOWS", quality: 0.5, strength: 0.5, confirmed: true, dormancy: 0, privacy: 0 }];
    const ranked = rankBusinessPaths(enumeratePaths(direct, "me", "t", 3), { k: 1 });
    expect(ranked[0]!.quality).toBeCloseTo(0.5, 6);
    expect(ranked[0]!.hops).toBe(1);
    expect(ranked[0]!.introducerId).toBeNull();
  });

  it("경로가 없으면 pathQuality feature 가 0 이다", () => {
    expect(pathQualityFeature([])).toBe(0);
    expect(pathQualityFeature(rankBusinessPaths(enumeratePaths(fixtureEdges(), "me", "target", 3), { k: 1 }))).toBeGreaterThan(0);
  });

  it("순환 경로를 만들지 않는다", () => {
    for (const p of enumeratePaths(fixtureEdges(), "me", "target", 3)) {
      expect(new Set(p.nodeIds).size).toBe(p.nodeIds.length);
    }
  });
});

// ---------------------------------------------------------------- N-011 / N-107 분류

describe("N-011 / N-107 분류 체계와 별칭", () => {
  it("한국어·영어·별칭을 같은 canonical 값으로 정규화한다", () => {
    expect(normalizeIndustry("의료기기")).toBe("의료기기");
    expect(normalizeIndustry("Medical Devices")).toBe("의료기기");
    expect(normalizeIndustry("medical device")).toBe("의료기기");
    expect(normalizeRegion("vietnam")).toBe("베트남");
    expect(normalizeRegion("하노이")).toBe("베트남");
  });

  it("사전에 없으면 null — 값을 지어내지 않는다", () => {
    expect(normalizeIndustry("아무말산업")).toBeNull();
    expect(normalizeRegion("없는지역")).toBeNull();
  });

  it("문장에서 분류값을 찾고 긴 별칭을 우선한다", () => {
    const ind = findIndustries("베트남에서 의료기기를 유통할 회사");
    expect(ind).toContain("의료기기");
    expect(ind).toContain("유통·도소매");
    expect(findRegions("베트남에서 의료기기를 유통할 회사")).toEqual(["베트남"]);
  });

  it("상위 분류를 함께 돌려준다", () => {
    expect(industryWithParents("의료기기")).toEqual(["의료기기", "헬스케어"]);
    expect(industryWithParents("교육")).toEqual(["교육"]);
  });

  it("canonicalKey 는 중복 제거용으로 안정적이다", () => {
    expect(canonicalKey("  의료기기 / 유통!! ")).toBe(canonicalKey("의료기기 유통"));
  });
});

// ---------------------------------------------------------------- N-015 Intent Parser

describe("N-015 자연어 Intent Parser", () => {
  const q = "베트남에서 의료기기를 유통할 회사를 내 3촌 안에서 찾아줘";

  it("패키지 예시 질의를 구조화한다", () => {
    const i = parseSearchIntent(q);
    expect(i.geographies).toEqual(["베트남"]);
    expect(i.industries).toContain("의료기기");
    expect(i.targetTypes).toContain("company");
    expect(i.networkHopsMax).toBe(3);
    expect(i.privacyMode).toBe("masked_until_intro");
    expect(i.provenance).toBe("rule_parsed");
  });

  it("촌수 표현을 1..3 으로 제한한다", () => {
    expect(parseSearchIntent("2촌 안에서 찾아줘").networkHopsMax).toBe(2);
    expect(parseSearchIntent("직접 아는 사람 중에서").networkHopsMax).toBe(1);
    expect(parseSearchIntent("within 2 hops").networkHopsMax).toBe(2);
    expect(parseSearchIntent("9촌까지 찾아줘").networkHopsMax).toBe(3);
    expect(parseSearchIntent("아무 조건 없음").networkHopsMax).toBe(3);
  });

  it("기간 조건을 일수로 바꾼다", () => {
    expect(parseSearchIntent("최근 6개월 안에 만난 사람").recencyDays).toBe(180);
    expect(parseSearchIntent("최근 30일").recencyDays).toBe(30);
    expect(parseSearchIntent("올해 만난 사람").recencyDays).toBe(365);
    expect(parseSearchIntent("기간 조건 없음").recencyDays).toBeNull();
  });

  it("필수 조건과 선호 조건을 분리한다", () => {
    const i = parseSearchIntent("의료기기 유통사, 반드시 베트남 현지 법인이 있어야 함, 가능하면 영어 가능");
    expect(i.mustHave.join(" ")).toContain("베트남 현지 법인");
    expect(i.niceToHave.join(" ")).toContain("영어");
  });

  it("대상 타입 단서를 읽는다", () => {
    expect(parseSearchIntent("협회 사람 찾아줘").targetTypes).toContain("organization");
    expect(parseSearchIntent("구매 담당자 찾아줘").targetTypes).toContain("person");
    // 단서가 없으면 사람과 회사를 모두 본다
    expect(parseSearchIntent("의료기기").targetTypes).toEqual(["person", "company"]);
  });

  it("같은 질의는 항상 같은 결과를 낸다(결정적)", () => {
    expect(parseSearchIntent(q)).toEqual(parseSearchIntent(q));
  });

  it("LLM 출력 검증에 실패하면 null 을 돌려준다(규칙 파서로 폴백)", () => {
    expect(validateParsedIntent(null, q)).toBeNull();
    expect(validateParsedIntent({ industries: "의료기기" }, q)).toBeNull(); // 배열이 아님
    expect(validateParsedIntent({ targetTypes: [] }, q)).toBeNull(); // 타입 없음
    expect(validateParsedIntent({ targetTypes: ["unicorn"] }, q)).toBeNull();
  });

  it("LLM 은 privacyMode 를 완화할 수 없다", () => {
    const v = validateParsedIntent({ targetTypes: ["person"], privacyMode: "normal", networkHopsMax: 2 }, q);
    expect(v!.privacyMode).toBe("masked_until_intro");
    expect(v!.provenance).toBe("llm_parsed");
  });
});

// ---------------------------------------------------------------- N-016 / N-108 추천

const facts = (over: Partial<CandidateFacts> = {}): CandidateFacts => ({
  industries: ["의료기기"],
  regions: ["베트남"],
  roleCategories: ["대표/창업자"],
  capabilities: ["의료기기 유통"],
  needs: [],
  type: "company",
  relationshipStrength: 0.6,
  daysSinceLastContact: 30,
  dealsWon: 1,
  userPreference: 0,
  confidence: 0.9,
  ...over,
});

const ev = (over: Partial<Evidence> = {}): Evidence => ({
  id: "ev-1",
  type: "meeting",
  summary: "최근 6개월 3회 미팅",
  confidence: 0.9,
  occurredAt: new Date("2026-08-01").toISOString(),
  inferred: false,
  ...over,
});

describe("N-016 추천 점수", () => {
  it("가중치 합이 1 이다", () => {
    expect(Object.values(RECO_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("0..100 범위이고 구성요소 기여도 합과 일치한다", () => {
    const s = scoreRecommendation({ intentFit: 1, capabilityFit: 1, pathQuality: 1, relationshipStrength: 1, industryFit: 1, evidenceQuality: 1, recency: 1, geo: 1, dealHistory: 1, userPreference: 1 });
    expect(s.score).toBeCloseTo(100, 3);
    expect(scoreRecommendation({}).score).toBe(0);
  });

  it("intentFit 은 조건 충족 비율을 반영한다", () => {
    const intent = parseSearchIntent("베트남 의료기기 유통 회사");
    const good = deriveFeatures(intent, facts(), [], []);
    const bad = deriveFeatures(intent, facts({ industries: ["게임"], regions: ["서울"], type: "person" }), [], []);
    expect(good.intentFit).toBeGreaterThan(bad.intentFit);
  });

  it("근거가 없으면 evidenceQuality 가 0 이다 — 중립값으로 올려주지 않는다", () => {
    expect(evidenceQuality([])).toBe(0);
  });

  it("user_confirmed 근거가 ai_inferred 보다 높게 평가된다", () => {
    const now = new Date("2026-10-13");
    expect(evidenceQuality([ev({ type: "user_confirmed" })], now)).toBeGreaterThan(evidenceQuality([ev({ type: "ai_inferred" })], now));
  });

  it("오래된 근거는 감쇠한다", () => {
    const now = new Date("2026-10-13");
    const recent = evidenceQuality([ev({ occurredAt: new Date("2026-10-01").toISOString() })], now);
    const old = evidenceQuality([ev({ occurredAt: new Date("2020-01-01").toISOString() })], now);
    expect(recent).toBeGreaterThan(old);
  });
});

describe("N-016 Hard gate 가 점수보다 먼저다 (인수 게이트)", () => {
  const base = { isSelf: false, blocked: false, deleted: false, canDiscover: true, mustHaveUnmet: [], confidence: 0.9, minConfidence: 0.55 };

  it("필수 조건 미충족은 점수와 무관하게 탈락이다", () => {
    const g = hardGate({ ...base, mustHaveUnmet: ["베트남 현지 법인"] });
    expect(g.pass).toBe(false);
    expect(g.reason).toBe("must_have_unmet");
  });

  it("탐색 권한이 없으면 탈락이다", () => {
    expect(hardGate({ ...base, canDiscover: false }).reason).toBe("not_discoverable");
  });

  it("차단·삭제·본인은 탈락이다", () => {
    expect(hardGate({ ...base, blocked: true }).reason).toBe("blocked");
    expect(hardGate({ ...base, deleted: true }).reason).toBe("deleted");
    expect(hardGate({ ...base, isSelf: true }).reason).toBe("self");
  });

  it("최소 confidence 미달은 탈락이다", () => {
    expect(hardGate({ ...base, confidence: 0.3 }).reason).toBe("below_min_confidence");
  });

  it("정상 후보는 통과한다", () => {
    expect(hardGate(base).pass).toBe(true);
  });

  it("필수 조건은 분류값 또는 의미 유사도로 판정한다", () => {
    expect(unmetMustHave(["의료기기"], facts())).toEqual([]);
    expect(unmetMustHave(["반도체 장비"], facts())).toEqual(["반도체 장비"]);
  });
});

describe("N-108 근거 추적", () => {
  it("evidence 출처 이유는 실재하는 evidenceId 가 없으면 제거된다", () => {
    const reasons = [
      { text: "미팅 3회", feature: "recency" as const, source: "evidence" as const, evidenceId: "ev-missing", inferred: false },
      { text: "미팅 3회", feature: "recency" as const, source: "evidence" as const, evidenceId: "ev-1", inferred: false },
      { text: "산업 일치", feature: "industryFit" as const, source: "field" as const, evidenceId: null, inferred: false },
    ];
    const kept = groundedReasons(reasons, [ev()]);
    expect(kept).toHaveLength(2);
    expect(kept.every((r) => r.source !== "evidence" || r.evidenceId === "ev-1")).toBe(true);
  });

  it("evidenceId 없는 evidence 이유는 통과하지 못한다", () => {
    expect(groundedReasons([{ text: "x", feature: "recency", source: "evidence", evidenceId: null, inferred: false }], [ev()])).toHaveLength(0);
  });
});

describe("N-016 MMR 다양성", () => {
  const reco = (id: string, score: number, companyName: string | null) =>
    ({
      resultId: id,
      resultType: "person" as const,
      disclosure: "full" as const,
      displayName: id,
      maskedLabel: null,
      companyName,
      jobTitle: null,
      email: null,
      phone: null,
      industry: "의료기기",
      region: null,
      gates: { can_process: true, can_discover: true, can_request_intro: true, can_reveal_identity: true, can_reveal_contact: true },
      withheldReasons: [],
      score,
      scoreComponents: {} as never,
      reasons: [],
      evidence: [],
      paths: [],
      nextActions: [],
    });

  it("점수가 비슷하면 같은 회사 대신 다른 회사를 올린다", () => {
    // 순수 점수순이면 a1 > a2 > b1 이지만, a2 는 a1 과 회사·산업이 같아 다양성 페널티를 받는다
    const results = [reco("a1", 90, "알파"), reco("a2", 72, "알파"), reco("b1", 70, "베타")];
    const picked = diversify(results, 3);
    expect(picked[0]!.resultId).toBe("a1");
    expect(picked[1]!.resultId).toBe("b1");
  });

  it("관련성이 압도적으로 높으면 같은 회사라도 유지된다 — 다양성이 적합도를 뒤집지 않는다", () => {
    const results = [reco("a1", 95, "알파"), reco("a2", 92, "알파"), reco("b1", 30, "베타")];
    expect(diversify(results, 2).map((r) => r.resultId)).toEqual(["a1", "a2"]);
  });

  it("limit 을 넘지 않고 점수 순을 크게 뒤집지 않는다", () => {
    const results = [reco("a", 90, "알파"), reco("b", 50, "베타"), reco("c", 10, "감마")];
    expect(diversify(results, 2)).toHaveLength(2);
    expect(diversify(results, 3)[0]!.resultId).toBe("a");
  });
});

// ---------------------------------------------------------------- N-018 / N-019 프로젝트

describe("N-018 프로젝트 분해", () => {
  it("원문에 단서가 있는 Role/Need 만 초안으로 만든다", () => {
    const drafts = decomposeProject({
      name: "베트남 의료기기 유통 진출",
      description: "현지 유통 파트너가 필요합니다.\n구매 담당자를 소개받고 싶습니다.\n반드시 인허가 컨설팅이 필요해요.",
    });
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((d) => d.provenance === "rule_parsed")).toBe(true);
    // 모든 초안은 출처 문장을 보존한다 — 지어내지 않았음을 보일 수 있어야 한다
    expect(drafts.every((d) => d.sourceSentence.length > 0)).toBe(true);
    expect(drafts.some((d) => d.kind === "role" && d.name === "구매/조달")).toBe(true);
    expect(drafts.some((d) => d.kind === "need")).toBe(true);
  });

  it("단서가 없는 설명에서는 아무것도 만들지 않는다", () => {
    expect(decomposeProject({ name: "회사 소개", description: "저희는 2010년에 설립되었습니다." })).toEqual([]);
  });

  it("필수 표현이 있으면 우선순위가 올라간다", () => {
    const d = decomposeProject({ name: "p", description: "반드시 인허가 전문가가 필요합니다." });
    expect(d[0]!.priority).toBe(1);
  });

  it("문장에 산업·지역 단서가 없으면 프로젝트 기본값을 상속한다", () => {
    const d = decomposeProject({ name: "p", description: "현지 파트너가 필요합니다.", targetIndustries: ["의료기기"], targetRegions: ["베트남"] });
    expect(d[0]!.industry).toBe("의료기기");
    expect(d[0]!.region).toBe("베트남");
  });

  it("문장 자체의 단서가 프로젝트 기본값보다 우선한다", () => {
    const d = decomposeProject({ name: "p", description: "유통 파트너가 필요합니다.", targetIndustries: ["의료기기"], targetRegions: ["베트남"] });
    expect(d[0]!.industry).toBe("유통·도소매");
  });
});

describe("N-019 커버리지와 Gap", () => {
  const req = { id: "r1", kind: "role" as const, name: "구매/조달", priority: 1 };
  const cand = (score: number, hasPath: boolean, disclosure: "full" | "masked" | "intro_only" = "full") => ({
    resultId: `c-${score}-${String(hasPath)}`,
    score,
    disclosure,
    hops: hasPath ? 2 : null,
    hasPath,
    displayName: disclosure === "masked" ? null : "후보",
    maskedLabel: disclosure === "masked" ? "2촌 · 의료기기 · 소개경로 있음" : null,
  });

  it("기준 점수를 넘고 경로가 있으면 covered", () => {
    const c = coverageFor(req, [cand(COVERED_MIN_SCORE + 5, true)]);
    expect(c.status).toBe("covered");
  });

  it("점수가 높아도 경로가 없으면 covered 가 아니다", () => {
    const c = coverageFor(req, [cand(95, false)]);
    expect(c.status).toBe("partial");
    expect(c.reasons.some((r) => r.includes("소개 경로"))).toBe(true);
  });

  it("후보가 없으면 gap 이다", () => {
    expect(coverageFor(req, []).status).toBe("gap");
  });

  it("masked 후보도 covered 로 셀 수 있지만 사실을 알려준다", () => {
    const c = coverageFor(req, [cand(80, true, "masked")]);
    expect(c.status).toBe("covered");
    expect(c.reasons.some((r) => r.includes("신원 비공개"))).toBe(true);
  });

  it("커버리지율은 우선순위로 가중된다", () => {
    const covered = coverageFor({ ...req, id: "r1", priority: 1 }, [cand(80, true)]);
    const gapHigh = coverageFor({ ...req, id: "r2", priority: 1 }, []);
    const gapLow = coverageFor({ ...req, id: "r3", priority: 5 }, []);
    expect(coverageSummary([covered, gapLow]).coverageRate).toBeGreaterThan(coverageSummary([covered, gapHigh]).coverageRate);
  });

  it("우선순위 높은 gap 을 critical 로 집계한다", () => {
    const s = coverageSummary([coverageFor({ ...req, priority: 1 }, []), coverageFor({ ...req, id: "r9", priority: 5 }, [])]);
    expect(s.gap).toBe(2);
    expect(s.criticalGaps).toHaveLength(1);
    expect(s.criticalGaps[0]!.priority).toBe(1);
  });

  it("외부 provider 제안은 사용자 승인을 요구한다", () => {
    const sug = gapSuggestions([coverageFor(req, [])], { hopsUsed: 2, hasOrgNetwork: true, hadRegionFilter: true, hadIndustryFilter: false });
    const ext = sug.find((s) => s.action === "external_provider")!;
    expect(ext.requiresApproval).toBe(true);
    expect(sug.find((s) => s.action === "search_wider_hops")!.requiresApproval).toBe(false);
    expect(sug.some((s) => s.action === "relax_industry")).toBe(false); // 산업 필터가 없으면 제안하지 않는다
  });
});

// ---------------------------------------------------------------- N-109 / N-110

const act = (over: Partial<NetworkActivity> = {}): NetworkActivity => ({
  id: "a1",
  type: "one_to_one",
  occurredAt: new Date("2026-09-01"),
  durationMinutes: 60,
  outcome: null,
  organizationId: null,
  evidenceId: null,
  ...over,
});

describe("N-109 네트워크 활동 기록", () => {
  it("1:1 주기를 계산한다", () => {
    const s = activityStats([act({ id: "1", occurredAt: new Date("2026-01-01") }), act({ id: "2", occurredAt: new Date("2026-02-01") }), act({ id: "3", occurredAt: new Date("2026-03-01") })]);
    expect(s.oneToOneCount).toBe(3);
    expect(s.oneToOneCadenceDays).toBeGreaterThanOrEqual(28);
    expect(s.oneToOneCadenceDays).toBeLessThanOrEqual(31);
  });

  it("1회뿐이면 주기를 계산하지 않는다", () => {
    expect(activityStats([act()]).oneToOneCadenceDays).toBeNull();
  });

  it("소개 성공은 결과 기록에서만 센다", () => {
    const s = activityStats([
      act({ id: "r1", type: "referral_given", outcome: "won" }),
      act({ id: "r2", type: "referral_given", outcome: "declined" }),
      act({ id: "r3", type: "referral_received", outcome: null }),
    ]);
    expect(s.referralsGiven).toBe(2);
    expect(s.referralsReceived).toBe(1);
    expect(s.referralsSucceeded).toBe(1);
  });

  it("활동이 관계강도 관측값으로 환산된다", () => {
    const c = activityContribution(activityStats([act(), act({ id: "g", type: "group_meeting", organizationId: "org-1" })]));
    expect(c.meetingsTotal).toBe(2);
    expect(c.meetingMinutesTotal).toBe(60);
    expect(c.sharedOrganizations).toBe(1);
  });

  it("1:1 리듬을 진단한다", () => {
    expect(oneToOneHealth(activityStats([])).state).toBe("never");
    const regular = activityStats([act({ id: "1", occurredAt: new Date("2026-08-01") }), act({ id: "2", occurredAt: new Date("2026-09-01") })]);
    expect(oneToOneHealth(regular, new Date("2026-09-15")).state).toBe("healthy");
    expect(oneToOneHealth(regular, new Date("2027-03-01")).state).toBe("lapsed");
  });
});

describe("N-110 Referral Partner / ICP", () => {
  const myIcp = { industries: ["의료기기"], regions: ["서울"], roleCategories: ["구매/조달"], needs: ["의료기기 조달"] };

  it("ICP 적합도는 축별 일치를 반영한다", () => {
    const good = icpFit({ industries: ["의료기기"], regions: ["서울"], roleCategories: ["구매/조달"], needs: ["의료기기 조달 담당"] }, myIcp);
    const bad = icpFit({ industries: ["게임"], regions: ["부산"], roleCategories: ["디자인"], needs: [] }, myIcp);
    expect(good.score).toBeGreaterThan(bad.score);
    expect(good.reasons.length).toBeGreaterThan(0);
  });

  it("교차 소개는 양방향일 때만 reciprocal 이다", () => {
    const [both] = rankReferralPartners(
      { icp: myIcp, capabilities: ["병원 인허가 컨설팅"] },
      [
        {
          id: "p1",
          icp: { industries: ["병원·의료서비스"], regions: ["서울"], roleCategories: [], needs: ["병원 인허가 컨설팅"] },
          capabilities: ["의료기기 유통"],
          networkIndustries: ["의료기기"],
          networkRoleCategories: ["구매/조달"],
          strength: 0.7,
          hops: 1,
          referralTrack: 0.8,
        },
      ],
    );
    expect(both!.reciprocal).toBe(true);
    expect(both!.inboundPotential).toBeGreaterThan(0);
    expect(both!.outboundPotential).toBeGreaterThan(0);
  });

  it("한쪽만 이득이면 reciprocal=false 이고 그 사실을 알려준다", () => {
    const [oneWay] = rankReferralPartners(
      { icp: myIcp, capabilities: ["게임 서버 운영"] },
      [{ id: "p2", icp: { industries: ["반도체"], regions: [], roleCategories: [], needs: ["웨이퍼 공급"] }, capabilities: [], networkIndustries: ["의료기기"], networkRoleCategories: ["구매/조달"], strength: 0.5, hops: 2, referralTrack: 0 }],
    );
    expect(oneWay!.reciprocal).toBe(false);
    expect(oneWay!.reasons.join(" ")).toMatch(/받을 쪽|줄 쪽/);
  });
});

// ---------------------------------------------------------------- N-021 기회 파이프라인

describe("N-021 기회 파이프라인", () => {
  it("허용된 전이만 통과한다", () => {
    expect(canOpportunityTransition("detected", "qualified")).toBe(true);
    expect(canOpportunityTransition("detected", "won")).toBe(false);
    expect(canOpportunityTransition("won", "lost")).toBe(false);
  });

  it("전이를 학습 라벨로 환산한다", () => {
    expect(outcomeLabelFor("won")).toBe("won");
    expect(outcomeLabelFor("dismissed")).toBe("not_relevant");
    expect(outcomeLabelFor("negotiating")).toBeNull();
  });

  it("단계 체류가 길면 주의 표시하고 다음 할 일을 알려준다", () => {
    const fresh = opportunityHealth("detected", new Date("2026-10-10"), new Date("2026-10-13"));
    expect(fresh.stale).toBe(false);
    const old = opportunityHealth("detected", new Date("2026-09-01"), new Date("2026-10-13"));
    expect(old.stale).toBe(true);
    expect(old.nextStep.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- N-012 / N-013 어댑터

describe("N-013 그래프 어댑터", () => {
  it("InMemory 구현이 기본 provider 이고 결정적이다", async () => {
    const repo = new InMemoryGraphRepository(fixtureEdges());
    expect(repo.provider).toBe("sql");
    expect(await repo.neighbors("me", 3, 100)).toEqual(await repo.neighbors("me", 3, 100));
  });

  it("reachable set 은 촌수별 노드 집합이다 — provider contract test 기준", async () => {
    const set = await reachableSet(new InMemoryGraphRepository(fixtureEdges()), "me", 3);
    expect(set.get(1)).toEqual(["a", "b", "d"]);
    expect(set.get(2)).toContain("target");
    expect([...set.values()].flat()).not.toContain("blocked");
  });

  it("slice 는 넘겨받은 노드만 담고 잘린 수를 알려준다", () => {
    const repo = new InMemoryGraphRepository(fixtureEdges());
    const visible = ["me", "a", "b", "target"].map((id) => ({ id, type: "person", label: id, masked: false, score: 0.5, community: null }));
    const slice = repo.buildSlice("me", visible, 3);
    expect(slice.nodes).toHaveLength(3);
    expect(slice.truncated).toBe(1);
    const ids = new Set(slice.nodes.map((n) => n.id));
    expect(slice.links.every((l) => ids.has(l.source) && ids.has(l.target))).toBe(true);
  });

  it("projection lag 임계값을 넘으면 degraded 다", () => {
    const now = new Date("2026-10-13T12:00:00Z");
    expect(projectionLag(0, null, now).degraded).toBe(false);
    expect(projectionLag(5, new Date("2026-10-13T11:00:00Z"), now).degraded).toBe(true);
  });
});

describe("N-012 벡터 어댑터", () => {
  it("기본 어휘 인덱스가 의미 유사 후보를 돌려준다", async () => {
    const idx = new LexicalVectorIndex();
    expect(idx.provider).toBe("lexical");
    const hits = await idx.search("의료기기 유통", [
      { entityId: "a", content: "의료기기 유통 및 수입" },
      { entityId: "b", content: "게임 서버 운영" },
    ]);
    expect(hits[0]!.entityId).toBe("a");
    expect(hits.some((h) => h.entityId === "b")).toBe(false);
  });

  it("같은 입력에 같은 순서를 돌려준다(결정적)", async () => {
    const idx = new LexicalVectorIndex();
    const pool = [
      { entityId: "a", content: "의료기기 유통" },
      { entityId: "b", content: "의료기기 유통" },
    ];
    expect(await idx.search("의료기기", pool)).toEqual(await idx.search("의료기기", pool));
  });
});

describe("N-013 이벤트 네임스페이스", () => {
  it("모든 이름이 network. 접두사를 쓴다 — 기능 원장 카탈로그와 섞이지 않는다", () => {
    expect(NETWORK_EVENT_NAMES.length).toBeGreaterThan(0);
    expect(NETWORK_EVENT_NAMES.every((n) => n.startsWith("network."))).toBe(true);
    expect(isNetworkEventName("network.edge.upserted")).toBe(true);
    expect(isNetworkEventName("contact.updated")).toBe(false);
  });
});

// ---------------------------------------------------------------- N-017 3D 레이아웃

describe("N-017 3D 레이아웃", () => {
  const nodes = ["me", "a", "b", "c", "d", "e"].map((id) => ({ id }));
  const edges = [
    { source: "me", target: "a", weight: 0.8 },
    { source: "me", target: "b", weight: 0.6 },
    { source: "a", target: "c", weight: 0.7 },
    { source: "b", target: "d", weight: 0.5 },
  ];

  it("모든 노드에 좌표를 준다", () => {
    const pos = forceLayout3D(nodes, edges);
    expect(Object.keys(pos).sort()).toEqual(nodes.map((n) => n.id).sort());
    for (const p of Object.values(pos)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });

  it("같은 입력이면 같은 좌표가 나온다(결정적) — 서버가 계산해 보내도 화면이 흔들리지 않는다", () => {
    expect(forceLayout3D(nodes, edges)).toEqual(forceLayout3D(nodes, edges));
  });

  it("좌표가 경계 안에 있다", () => {
    const size = 400;
    for (const p of Object.values(forceLayout3D(nodes, edges, { size }))) {
      for (const v of [p.x, p.y, p.z]) {
        expect(v).toBeGreaterThanOrEqual(-size / 2 - 0.1);
        expect(v).toBeLessThanOrEqual(size / 2 + 0.1);
      }
    }
  });

  it("연결된 노드가 연결되지 않은 노드보다 가깝다", () => {
    const pos = forceLayout3D(nodes, edges, { iterations: 300 });
    const dist = (a: string, b: string) => Math.hypot(pos[a]!.x - pos[b]!.x, pos[a]!.y - pos[b]!.y, pos[a]!.z - pos[b]!.z);
    // me-a 는 엣지가 있고 e 는 고립 노드다
    expect(dist("me", "a")).toBeLessThan(dist("me", "e"));
  });

  it("빈 입력은 빈 결과다", () => {
    expect(forceLayout3D([], [])).toEqual({});
  });

  it("3D 노드 상한이 정의되어 있다(화면명세 S09)", () => {
    expect(MAX_3D_NODES).toBe(500);
  });

  it("없는 노드를 가리키는 엣지는 무시한다", () => {
    expect(() => forceLayout3D(nodes, [{ source: "me", target: "ghost" }])).not.toThrow();
  });
});

// ---------------------------------------------------------------- N-107 별칭

describe("N-107 분류 별칭", () => {
  const aliases = [
    { kind: "industry" as const, alias: "메디텍", canonicalName: "의료기기" },
    { kind: "region" as const, alias: "동남아", canonicalName: "베트남" },
  ];

  it("사전에 없는 표현을 canonical 값으로 흡수한다", () => {
    expect(findWithAliases("메디텍 유통사를 찾아줘", "industry", aliases)).toContain("의료기기");
    expect(findWithAliases("동남아 파트너", "region", aliases)).toContain("베트남");
  });

  it("별칭이 없으면 사전 결과만 돌려준다", () => {
    expect(findWithAliases("메디텍 유통사", "industry", [])).not.toContain("의료기기");
    expect(findWithAliases("의료기기 유통사", "industry", [])).toContain("의료기기");
  });

  it("canonical 값이 사전에 없으면 무시한다 — 사전 밖 값이 feature 로 새지 않는다", () => {
    const bogus = [{ kind: "industry" as const, alias: "머시기", canonicalName: "존재하지않는산업" }];
    expect(findWithAliases("머시기 회사", "industry", bogus)).toEqual([]);
  });

  it("검색 의도 파싱에 별칭이 반영되고, 별칭 단어가 역량 후보로 남지 않는다", () => {
    const i = parseSearchIntent("동남아에서 메디텍 유통할 회사", { aliases });
    expect(i.industries).toContain("의료기기");
    expect(i.geographies).toContain("베트남");
    expect(i.capabilities).not.toContain("메디텍");
    expect(i.capabilities).not.toContain("동남아");
  });

  it("validateAlias 는 사전 밖 canonical 값과 중복 등록을 거부한다", () => {
    expect(validateAlias({ kind: "industry", alias: "메디텍", canonicalName: "의료기기" })).toMatchObject({ ok: true, canonicalName: "의료기기" });
    expect(validateAlias({ kind: "industry", alias: "메디텍", canonicalName: "없는산업" })).toMatchObject({ ok: false, reason: "unknown_canonical" });
    // 이미 사전에 있는 표현은 별칭으로 등록할 필요가 없다
    expect(validateAlias({ kind: "industry", alias: "의료기기", canonicalName: "제약·바이오" })).toMatchObject({ ok: false, reason: "already_in_dictionary" });
    expect(validateAlias({ kind: "industry", alias: "x", canonicalName: "의료기기" })).toMatchObject({ ok: false, reason: "alias_too_short" });
  });

  it("capability 별칭은 자유 텍스트 canonical 값을 허용한다", () => {
    expect(validateAlias({ kind: "capability", alias: "콜드체인", canonicalName: "콜드체인 물류" })).toMatchObject({ ok: true });
  });

  it("normalizeAlias 는 DB 의 normalized_alias 와 같은 키를 만든다", () => {
    expect(normalizeAlias("  메디텍 / 유통 ")).toBe(normalizeAlias("메디텍 유통"));
  });
});

// ---------------------------------------------------------------- 시드가 참조하는 분류값

describe("시드 데이터가 참조하는 산업 이름이 사전에 존재한다", () => {
  // db/seeds/netintel.ts 는 이 이름으로 industries 행을 찾는다. 사전에서 이름이 바뀌면 시드가 깨진다.
  const used = ["의료기기", "유통·도소매", "병원·의료서비스", "반도체", "물류·운송", "화학·소재", "벤처투자·PE"];
  it.each(used)("%s", (name) => {
    expect(INDUSTRIES.some((i) => i.name === name)).toBe(true);
  });
});

// ---------------------------------------------------------------- helper

function obs(over: Partial<Parameters<typeof deriveRelSignals>[0]>): Parameters<typeof deriveRelSignals>[0] {
  return {
    daysSinceLastContact: 60,
    encounters90d: 1,
    encountersTotal: 2,
    meetingsTotal: 1,
    meetingMinutesTotal: 60,
    outboundCount: 2,
    inboundCount: 1,
    reciprocal: false,
    dealsTotal: 0,
    dealsWon: 0,
    firstMetDaysAgo: 200,
    sharedOrganizations: 0,
    sharedEvents: 0,
    sharedCompanies: 0,
    userTrust: null,
    referralsGiven: 0,
    referralsSucceeded: 0,
    confirmed: true,
    inferred: false,
    ...over,
  };
}
