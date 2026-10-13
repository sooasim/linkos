// netintel module — 인적네트워크 인텔리전스 (N-ID · docs/NETWORK_INTELLIGENCE.md)
//
// 담당 기능: N-011/N-107 분류 · N-014 1~3촌 탐색 · N-015 Intent · N-016 추천 · N-017 그래프 slice ·
// N-018/N-019 프로젝트 커버리지 · N-021 기회 파이프라인 · N-022 공개 판정 · N-103/N-104 관계강도 ·
// N-105 Top-K 경로 · N-106 저장된 검색 · N-108 Evidence · N-109 활동 · N-110 Referral Partner · N-024 데이터 품질.
//
// 설계 규칙(지침 §2, §5, §8, §9):
//   * 공개 판정은 `evaluateDisclosure()` 한 곳에서만 하고, 응답은 반드시 `applyDisclosure()` 를 통과한다.
//   * 그래프 질의는 UUID 만 만들고 신원 공개는 canonical 테이블에서 다시 판정한다.
//   * 라우트 핸들러는 얇은 어댑터이고 계산은 전부 `@linkos/domain` 의 순수 함수다.
//   * 소유권은 owner_user_id 기준이다. 교차 소유자 탐색은 조직 멤버십 + 공유 opt-in 을 둘 다 확인한다.
import {
  type CandidateFacts,
  type CoverageCandidate,
  type DisclosureSubject,
  type Evidence,
  type IdealCustomerProfile,
  type NetworkActivity,
  type NetworkEdge,
  type OpportunityStage,
  type OutcomeLabel,
  type RankedPath,
  type Recommendation,
  type RelObservations,
  type RequirementKind,
  type SearchIntent,
  type SharePermission,
  type AliasKind,
  type TaxonomyAlias,
  INDUSTRIES,
  INTRO_STATES,
  MAX_3D_NODES,
  InMemoryGraphRepository,
  OPPORTUNITY_BOARD_COLUMNS,
  REGIONS,
  ROLE_CATEGORIES,
  activityContribution,
  activityStats,
  applyIntentEdits,
  availabilityFrom,
  buildRecommendation,
  canOpportunityTransition,
  canonicalKey,
  contactsRevealed,
  coverageFor,
  coverageSummary,
  decomposeProject,
  deriveRelSignals,
  diversify,
  edgeQuality,
  enumeratePaths,
  evaluateDisclosure,
  findIndustries,
  findRegions,
  forceLayout,
  forceLayout3D,
  gapSuggestions,
  icpFit,
  maskedLabel,
  oneToOneHealth,
  opportunityHealth,
  outcomeLabelFor,
  parseSearchIntent,
  projectionLag,
  rankBusinessPaths,
  rankReferralPartners,
  relationshipStrength,
  roleCategory,
  normalizeAlias,
  shareabilityFrom,
  validateAlias,
} from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit, log } from "../lib/platform";
import { activeOrgId } from "./org";

const DEFAULT_SHARE: SharePermission = "path_only";
const COLLEAGUE_STRENGTH = 0.7;

/**
 * 연락처가 공개되는 소개 상태. 도메인의 `contactsRevealed()` 가 유일한 기준이고 여기서 SQL 리터럴로 굳힌다 —
 * 상태 목록을 SQL 에 두 번 적으면 한쪽만 바뀌어 어긋난다. 값은 도메인 enum 에서 오므로 사용자 입력이 아니지만,
 * 그래도 식별자 형태를 확인한 뒤에만 인라인한다.
 */
const REVEALING_INTRO_STATES = INTRO_STATES.filter(contactsRevealed);
const REVEALING_INTRO_STATES_SQL = REVEALING_INTRO_STATES.map((s) => {
  if (!/^[A-Z_]+$/.test(s)) throw new Error(`unexpected intro state literal: ${s}`);
  return `'${s}'`;
}).join(",");

function requireUser(ctx: Ctx): string {
  if (!ctx.userId) throw unauthorized();
  return ctx.userId;
}

// ================================================================ 그래프 적재
//
// 노드 id 는 contact.id 또는 user.id(나 자신·조직 멤버)다. 둘 다 uuid 라 충돌하지 않는다.
// 엣지는 세 종류다:
//   me → 내 연락처            (relationships)
//   연락처 → 연락처            (contact_relationships — who-knows-whom)
//   me → 조직 멤버 → 그 멤버의 연락처  (organization_members + 공유 opt-in)

interface NodeRow {
  id: string;
  kind: "me" | "member" | "contact";
  ownerUserId: string | null;
  fullName: string;
  jobTitle: string | null;
  companyId: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  industry: string | null;
  region: string | null;
  /** 분류 테이블에서 온 역할 카테고리. 없으면 직책 텍스트에서 추론한다 */
  roleCategory: string | null;
  sharePermission: SharePermission;
  discoveryOptOut: boolean;
  orgShareOptIn: boolean | null;
  strength: number;
  lastContactAt: Date | null;
  introApproved: boolean;
}

interface LoadedNetwork {
  edges: NetworkEdge[];
  nodes: Map<string, NodeRow>;
  meId: string;
  orgId: string | null;
}

interface ContactRow {
  id: string;
  owner_user_id: string;
  full_name: string;
  job_title: string | null;
  company_id: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  strength: number | null;
  last_contact_at: Date | null;
  industry_name: string | null;
  region_name: string | null;
  role_category_name: string | null;
  share_permission: string | null;
  discovery_opt_out: boolean | null;
  org_share_opt_in: boolean | null;
  intro_accepted: boolean;
}

const CONTACT_SELECT = `
  SELECT c.id, c.owner_user_id, c.full_name, c.job_title, c.company_id, co.name AS company,
         c.email, c.phone, c.address,
         rel.strength, rel.last_contact_at,
         sp.share_permission, sp.discovery_opt_out, sp.org_share_opt_in,
         -- 분류는 명시 데이터를 먼저 쓴다. 직책·회사명 텍스트 추론은 값이 없을 때의 폴백이다.
         (SELECT i.name FROM contact_industries ci JOIN industries i ON i.id = ci.industry_id
           WHERE ci.contact_id = c.id ORDER BY ci.weight DESC, i.name LIMIT 1) AS industry_name,
         (SELECT r.role_category FROM contact_company_roles r
           WHERE r.contact_id = c.id AND r.is_current AND r.role_category IS NOT NULL
           ORDER BY r.started_on DESC NULLS LAST LIMIT 1) AS role_category_name,
         NULLIF(btrim(COALESCE(c.address, '')), '') AS region_name,
         -- 연락처 공개 단계에 도달한 소개가 있는가. 상태 목록은 도메인의 contactsRevealed() 가 유일한 기준이다
         -- (REVEALING_INTRO_STATES). 상태 컬럼은 state 다 — 0001 의 status 컬럼은 앱이 쓰지 않는다.
         EXISTS (
           SELECT 1 FROM introductions i
           WHERE (i.party_a_contact_id = c.id OR i.party_b_contact_id = c.id)
             AND i.introducer_user_id = $1
             AND i.state IN (${REVEALING_INTRO_STATES_SQL})
         ) AS intro_accepted
    FROM contacts c
    LEFT JOIN companies co ON co.id = c.company_id
    LEFT JOIN relationships rel ON rel.owner_user_id = c.owner_user_id AND rel.contact_id = c.id
    LEFT JOIN contact_share_permissions sp ON sp.contact_id = c.id
   WHERE c.deleted_at IS NULL AND c.merged_into_id IS NULL`;

function toNode(r: ContactRow): NodeRow {
  const industry = r.industry_name ?? findIndustries([r.job_title, r.company].filter(Boolean).join(" "))[0] ?? null;
  const region = findRegions(r.region_name ?? r.address ?? "")[0] ?? null;
  return {
    id: r.id,
    kind: "contact",
    ownerUserId: r.owner_user_id,
    fullName: r.full_name,
    jobTitle: r.job_title,
    companyId: r.company_id,
    companyName: r.company,
    email: r.email,
    phone: r.phone,
    industry,
    region,
    roleCategory: r.role_category_name ?? roleCategory(r.job_title),
    sharePermission: isSharePermission(r.share_permission) ? r.share_permission : DEFAULT_SHARE,
    discoveryOptOut: r.discovery_opt_out === true,
    orgShareOptIn: r.org_share_opt_in,
    strength: Number(r.strength ?? 0.3),
    lastContactAt: r.last_contact_at,
    introApproved: r.intro_accepted,
  };
}

function isSharePermission(v: unknown): v is SharePermission {
  return v === "none" || v === "path_only" || v === "profile" || v === "contact" || v === "introduction";
}

/** 엣지 하나를 만든다. consentGate 는 **도착 노드**의 소개 요청 허용 여부다(지침 §4). */
function makeEdge(from: string, to: NodeRow, relation: string, strength: number, opts: { confirmed: boolean; inferred: boolean; hops: number; ownedByViewer: boolean; contextFit?: number; evidenceId?: string | null }): NetworkEdge {
  const decision = evaluateDisclosure({
    ownedByViewer: opts.ownedByViewer,
    hops: opts.hops,
    sharePermission: to.sharePermission,
    optOut: to.discoveryOptOut,
    deleted: false,
    introApproved: to.introApproved,
    orgShareOptIn: to.orgShareOptIn,
  });
  const days = to.lastContactAt ? (Date.now() - to.lastContactAt.getTime()) / 864e5 : null;
  return {
    fromId: from,
    toId: to.id,
    relation,
    quality: edgeQuality({
      strength,
      shareability: shareabilityFrom(0, 0),
      availability: availabilityFrom(days),
      contextFit: opts.contextFit ?? 0.5,
      consentGate: decision.consentGate,
    }),
    strength,
    confirmed: opts.confirmed,
    inferred: opts.inferred,
    dormancy: days == null ? 0.5 : Math.min(1, days / 365),
    privacy: decision.gates.can_reveal_identity ? 0 : 1,
    companyId: to.companyId,
    evidenceId: opts.evidenceId ?? null,
  };
}

/**
 * 탐색 가능한 네트워크를 메모리로 읽는다. 조직 멤버 경유는 멤버의 `graph_opt_out` 과 조직 정책,
 * 그리고 연락처별 `org_share_opt_in` 을 모두 확인한 뒤에만 포함한다.
 */
export async function loadNetwork(ctx: Ctx, db: Db = pool()): Promise<LoadedNetwork> {
  const meId = requireUser(ctx);
  const orgId = await activeOrgId(meId, db);
  const nodes = new Map<string, NodeRow>();
  const edges: NetworkEdge[] = [];

  // 1) 내 연락처 (1촌)
  const mine = await q<ContactRow>(`${CONTACT_SELECT} AND c.owner_user_id = $1 ORDER BY rel.strength DESC NULLS LAST LIMIT 3000`, [meId], db);
  for (const r of mine) {
    const n = toNode(r);
    nodes.set(n.id, n);
    edges.push(makeEdge(meId, n, "KNOWS", n.strength, { confirmed: true, inferred: false, hops: 1, ownedByViewer: true }));
  }

  // 2) 연락처끼리의 관계 (who-knows-whom). 상대 연락처가 내 것이 아니면 진짜 2촌이다.
  const crs = await q<{ from_contact_id: string; to_contact_id: string; rel_type: string; strength: string | null; confirmed: boolean; inferred: boolean; evidence_id: string | null }>(
    `SELECT from_contact_id, to_contact_id, rel_type, strength, confirmed, inferred, evidence_id
       FROM contact_relationships WHERE owner_user_id = $1 LIMIT 20000`,
    [meId],
    db,
  );
  const unknownIds = [...new Set(crs.flatMap((c) => [c.from_contact_id, c.to_contact_id]))].filter((id) => !nodes.has(id));
  if (unknownIds.length) {
    for (const r of await q<ContactRow>(`${CONTACT_SELECT} AND c.id = ANY($2::uuid[]) LIMIT 5000`, [meId, unknownIds], db)) {
      nodes.set(r.id, toNode(r));
    }
  }
  for (const c of crs) {
    const to = nodes.get(c.to_contact_id);
    if (!to || !nodes.has(c.from_contact_id)) continue;
    edges.push(
      makeEdge(c.from_contact_id, to, c.rel_type.toUpperCase(), Number(c.strength ?? 0.5), {
        confirmed: c.confirmed,
        inferred: c.inferred,
        hops: 2,
        ownedByViewer: to.ownerUserId === meId,
        evidenceId: c.evidence_id,
      }),
    );
  }

  // 3) 조직 멤버 경유 (N-202 의 consent-aware 부분만: opt-in 한 멤버의 연락처)
  if (orgId) {
    const policy = (await one<{ policies: { graphPersonalExposure?: string } }>("SELECT policies FROM organizations WHERE id=$1", [orgId], db))?.policies ?? {};
    if (policy.graphPersonalExposure !== "shared_only") {
      const members = await q<{ user_id: string; name: string }>(
        `SELECT m.user_id, COALESCE(u.display_name, split_part(u.email,'@',1)) AS name
           FROM organization_members m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND m.status = 'active' AND m.user_id <> $2 AND m.graph_opt_out = false LIMIT 300`,
        [orgId, meId],
        db,
      );
      for (const m of members) {
        const memberNode: NodeRow = {
          id: m.user_id,
          kind: "member",
          ownerUserId: m.user_id,
          fullName: m.name,
          jobTitle: null,
          companyId: null,
          companyName: null,
          email: null,
          phone: null,
          industry: null,
          region: null,
          roleCategory: null,
          // 같은 조직 동료의 신원은 이미 서로 알고 있다
          sharePermission: "profile",
          discoveryOptOut: false,
          orgShareOptIn: true,
          strength: COLLEAGUE_STRENGTH,
          lastContactAt: null,
          introApproved: false,
        };
        nodes.set(memberNode.id, memberNode);
        edges.push(makeEdge(meId, memberNode, "COLLEAGUE", COLLEAGUE_STRENGTH, { confirmed: true, inferred: false, hops: 1, ownedByViewer: false }));
      }
      if (members.length) {
        // 멤버의 연락처: 조직 공유(scope='org')이거나 연락처별 org_share_opt_in 이 참인 것만
        const shared = await q<ContactRow>(
          `${CONTACT_SELECT} AND c.owner_user_id = ANY($2::uuid[])
             AND ((c.organization_id = $3 AND c.scope = 'org') OR sp.org_share_opt_in = true)
           ORDER BY rel.strength DESC NULLS LAST LIMIT 4000`,
          [meId, members.map((m) => m.user_id), orgId],
          db,
        );
        for (const r of shared) {
          const n = nodes.get(r.id) ?? toNode(r);
          nodes.set(n.id, n);
          edges.push(makeEdge(r.owner_user_id, n, "KNOWS", n.strength, { confirmed: true, inferred: false, hops: 2, ownedByViewer: r.owner_user_id === meId }));
        }
      }
    }
  }

  nodes.set(meId, {
    id: meId,
    kind: "me",
    ownerUserId: meId,
    fullName: "나",
    jobTitle: null,
    companyId: null,
    companyName: null,
    email: null,
    phone: null,
    industry: null,
    region: null,
    roleCategory: null,
    sharePermission: "introduction",
    discoveryOptOut: false,
    orgShareOptIn: null,
    strength: 1,
    lastContactAt: null,
    introApproved: true,
  });
  return { edges, nodes, meId, orgId };
}

/** 후보 노드의 공개 판정. 촌수가 들어가야 masked 라벨이 정확해진다. */
function decisionFor(n: NodeRow, hops: number, meId: string) {
  const subject: DisclosureSubject = {
    ownedByViewer: n.ownerUserId === meId,
    hops,
    sharePermission: n.sharePermission,
    optOut: n.discoveryOptOut,
    deleted: false,
    introApproved: n.introApproved,
    orgShareOptIn: n.orgShareOptIn,
  };
  return evaluateDisclosure(subject);
}

// ================================================================ N-014 이웃 탐색

export async function neighbors(ctx: Ctx, opts: { hops?: number; limit?: number } = {}) {
  const net = await loadNetwork(ctx);
  const repo = new InMemoryGraphRepository(net.edges);
  const hops = Math.max(1, Math.min(3, opts.hops ?? 2));
  const found = await repo.neighbors(net.meId, hops, Math.max(1, Math.min(500, opts.limit ?? 100)));
  const out = [];
  for (const nb of found) {
    const node = net.nodes.get(nb.nodeId);
    if (!node || node.kind === "me") continue;
    const d = decisionFor(node, nb.hops, net.meId);
    if (d.level === "hidden") continue;
    const via = nb.viaId ? net.nodes.get(nb.viaId) : null;
    const viaDecision = via ? decisionFor(via, 1, net.meId) : null;
    out.push({
      contactId: nb.nodeId,
      hops: nb.hops,
      quality: nb.bestQuality,
      disclosure: d.level,
      displayName: d.gates.can_reveal_identity ? node.fullName : null,
      maskedLabel: d.gates.can_reveal_identity ? null : maskedLabel({ hops: nb.hops, industry: node.industry, region: node.region, roleCategory: node.roleCategory, hasPath: true }),
      companyName: d.gates.can_reveal_identity ? node.companyName : null,
      industry: node.industry,
      region: node.region,
      // 중개자 이름은 **내가 직접 아는 사람**이므로 공개해도 된다. 그래야 소개를 부탁할 수 있다.
      via: via && viaDecision?.gates.can_reveal_identity ? { id: via.id, name: via.fullName, kind: via.kind } : null,
    });
  }
  return { hops, neighbors: out, provenance: "ai_inferred" as const };
}

// ================================================================ N-017 그래프 slice

export async function graphSlice(ctx: Ctx, opts: { hops?: number; maxNodes?: number; dim?: 2 | 3 } = {}) {
  const net = await loadNetwork(ctx);
  const repo = new InMemoryGraphRepository(net.edges);
  const hops = Math.max(1, Math.min(3, opts.hops ?? 2));
  const cap = opts.dim === 3 ? MAX_3D_NODES : 500;
  const maxNodes = Math.max(10, Math.min(cap, opts.maxNodes ?? 300));
  const found = await repo.neighbors(net.meId, hops, 2000);

  // 서버가 privacy-filtered slice 를 만든다 — 숨길 노드를 브라우저로 보내지 않는다(지침 §2)
  const visible: { id: string; type: string; label: string | null; masked: boolean; score: number | null; community: string | null }[] = [
    { id: net.meId, type: "me", label: "나", masked: false, score: 1, community: null },
  ];
  for (const nb of found) {
    const node = net.nodes.get(nb.nodeId);
    if (!node || node.kind === "me") continue;
    const d = decisionFor(node, nb.hops, net.meId);
    if (d.level === "hidden") continue;
    const identified = d.gates.can_reveal_identity;
    visible.push({
      id: node.id,
      type: node.kind === "member" ? "member" : "person",
      // masked 노드는 이름 대신 역할/산업 카테고리만 (S08)
      label: identified ? node.fullName : maskedLabel({ hops: nb.hops, industry: node.industry, region: node.region, roleCategory: node.roleCategory, hasPath: true }),
      masked: !identified,
      score: nb.bestQuality,
      // 클러스터링 키. masked 노드에는 회사 id 를 내보내지 않는다 — 이름을 가려도 "같은 회사"
      // 라는 UUID 가 나가면 클라이언트가 노드를 묶어 역추적할 단서가 된다(지침 §2). 산업만 쓴다.
      community: identified ? (node.industry ?? (node.companyId ? `co:${node.companyId}` : null)) : node.industry,
    });
  }
  const slice = repo.buildSlice(net.meId, visible, maxNodes);
  const layoutNodes = slice.nodes.map((n) => ({ id: n.id, kind: n.type }));
  const layoutEdges = slice.links.map((l) => ({ source: l.source, target: l.target, weight: l.strength }));

  // 레이아웃도 서버에서 계산한다(F-133 과 같은 결정적 force layout). 브라우저는 그릴 것만 받는다.
  const width = 900;
  const height = 640;
  const pos2 = forceLayout(layoutNodes, layoutEdges, { width, height, seed: 17 });
  // 3D 는 요청할 때만 계산한다 — 2D 화면에서 쓰지 않는 좌표를 매번 계산할 이유가 없다.
  const pos3 = opts.dim === 3 ? forceLayout3D(layoutNodes, layoutEdges, { size: 600, seed: 29 }) : null;

  await audit(pool(), ctx, "netintel.graph_slice", "user", net.meId, { hops, dim: opts.dim ?? 2, nodes: slice.nodes.length, truncated: slice.truncated });
  return {
    ...slice,
    // 패키지 3D 데이터 계약: nodes[] = {id,type,label,masked,size,community,x,y,z?,score}, links[] = {source,target,type,strength,confirmed}
    nodes: slice.nodes.map((n) => ({
      ...n,
      ...(pos2[n.id] ?? { x: width / 2, y: height / 2 }),
      ...(pos3 ? { z: pos3[n.id]?.z ?? 0, x3: pos3[n.id]?.x ?? 0, y3: pos3[n.id]?.y ?? 0 } : {}),
    })),
    width,
    height,
    hops,
    maxNodes,
    dim: opts.dim ?? 2,
  };
}

// ================================================================ N-103 / N-104 관계강도

async function observationsFor(userId: string, contactId: string, db: Db = pool()): Promise<{ obs: RelObservations; evidence: Record<string, string>; activities: NetworkActivity[] }> {
  const base = await one<{ last_contact_at: Date | null; first_met_at: Date | null; enc_total: number; enc_90: number; inbound: number; outbound: number; meetings: number; meeting_minutes: number; deals_total: number; deals_won: number; reciprocal: boolean }>(
    `SELECT rel.last_contact_at,
            (SELECT min(e.occurred_at) FROM encounters e WHERE e.owner_user_id=$1 AND e.contact_id=$2) AS first_met_at,
            (SELECT count(*)::int FROM encounters e WHERE e.owner_user_id=$1 AND e.contact_id=$2) AS enc_total,
            (SELECT count(*)::int FROM encounters e WHERE e.owner_user_id=$1 AND e.contact_id=$2 AND e.occurred_at > now() - interval '90 days') AS enc_90,
            -- 방향 신호의 근사치: LINKOS 는 접촉의 방향을 따로 저장하지 않는다.
            -- exchange/claim 은 상대가 회신·소유권 주장을 한 것(상대 행동), 나머지는 내가 기록한 것(내 행동)으로 본다.
            (SELECT count(*)::int FROM encounters e WHERE e.owner_user_id=$1 AND e.contact_id=$2 AND e.source IN ('exchange','claim')) AS inbound,
            (SELECT count(*)::int FROM encounters e WHERE e.owner_user_id=$1 AND e.contact_id=$2 AND e.source NOT IN ('exchange','claim')) AS outbound,
            (SELECT count(*)::int FROM meetings m JOIN meeting_participants mp ON mp.meeting_id=m.id WHERE m.owner_user_id=$1 AND mp.contact_id=$2) AS meetings,
            (SELECT COALESCE(sum(GREATEST(0, EXTRACT(EPOCH FROM (m.ended_at - m.started_at)) / 60))::int, 0) FROM meetings m JOIN meeting_participants mp ON mp.meeting_id=m.id WHERE m.owner_user_id=$1 AND mp.contact_id=$2 AND m.started_at IS NOT NULL AND m.ended_at IS NOT NULL) AS meeting_minutes,
            -- crm_deals 는 contact_ids uuid[] 를 쓴다. 초안(draft)은 사실이 아니므로 승인·동기화된 것만 센다.
            (SELECT count(*)::int FROM crm_deals d WHERE d.owner_user_id=$1 AND d.contact_ids @> ARRAY[$2]::uuid[] AND d.status IN ('approved','synced')) AS deals_total,
            (SELECT count(*)::int FROM crm_deals d WHERE d.owner_user_id=$1 AND d.contact_ids @> ARRAY[$2]::uuid[] AND d.status IN ('approved','synced') AND d.stage = 'won') AS deals_won,
            -- 양방향 교환: 상대가 LINKOS 사용자이고 그 사람의 주소록에도 내가 있다(network.ts 의 recipSet 과 같은 의미).
            EXISTS (
              SELECT 1 FROM contacts mine_in_theirs
               WHERE mine_in_theirs.owner_user_id = (SELECT linked_user_id FROM contacts WHERE id = $2)
                 AND mine_in_theirs.linked_user_id = $1
                 AND mine_in_theirs.deleted_at IS NULL
            ) AS reciprocal
       FROM relationships rel WHERE rel.owner_user_id=$1 AND rel.contact_id=$2`,
    [userId, contactId],
    db,
  );
  const rows = await q<{ id: string; activity_type: string; occurred_at: Date; duration_minutes: number | null; outcome: string | null; organization_id: string | null; evidence_id: string | null }>(
    `SELECT id, activity_type, occurred_at, duration_minutes, outcome, organization_id, evidence_id
       FROM network_activities WHERE owner_user_id=$1 AND contact_id=$2 ORDER BY occurred_at DESC LIMIT 500`,
    [userId, contactId],
    db,
  );
  const activities: NetworkActivity[] = rows.map((r) => ({
    id: r.id,
    type: r.activity_type as NetworkActivity["type"],
    occurredAt: r.occurred_at,
    durationMinutes: r.duration_minutes,
    outcome: r.outcome as NetworkActivity["outcome"],
    organizationId: r.organization_id,
    evidenceId: r.evidence_id,
  }));
  const stats = activityStats(activities);
  const add = activityContribution(stats);
  const days = (d: Date | null): number | null => (d ? Math.max(0, (Date.now() - d.getTime()) / 864e5) : null);
  const trust = await one<{ value: string }>(
    `SELECT value::text FROM relationship_signal_samples
      WHERE owner_user_id=$1 AND signal_type='user_trust'
        AND relationship_id = (SELECT id FROM relationships WHERE owner_user_id=$1 AND contact_id=$2)
      ORDER BY measured_at DESC LIMIT 1`,
    [userId, contactId],
    db,
  );
  const obs: RelObservations = {
    daysSinceLastContact: days(base?.last_contact_at ?? null),
    encounters90d: base?.enc_90 ?? 0,
    encountersTotal: base?.enc_total ?? 0,
    // 활동 기록이 있으면 더 정확하므로 큰 값을 쓴다(두 출처가 같은 미팅을 각각 셀 수 있다)
    meetingsTotal: Math.max(base?.meetings ?? 0, add.meetingsTotal),
    meetingMinutesTotal: Math.max(base?.meeting_minutes ?? 0, add.meetingMinutesTotal),
    outboundCount: base?.outbound ?? 0,
    inboundCount: base?.inbound ?? 0,
    reciprocal: base?.reciprocal === true,
    dealsTotal: base?.deals_total ?? 0,
    dealsWon: base?.deals_won ?? 0,
    firstMetDaysAgo: days(base?.first_met_at ?? null),
    sharedOrganizations: add.sharedOrganizations,
    sharedEvents: 0,
    sharedCompanies: 0,
    userTrust: trust ? Number(trust.value) : null,
    referralsGiven: add.referralsGiven,
    referralsSucceeded: add.referralsSucceeded,
    confirmed: true,
    inferred: false,
  };
  const evidence: Record<string, string> = {};
  const meetingEv = activities.find((a) => a.type === "one_to_one" && a.evidenceId);
  if (meetingEv?.evidenceId) evidence.meeting_depth = meetingEv.evidenceId;
  const refEv = activities.find((a) => (a.type === "referral_given" || a.type === "referral_received") && a.evidenceId);
  if (refEv?.evidenceId) evidence.referral_success = refEv.evidenceId;
  return { obs, evidence, activities };
}

/** S15 Relationship Intelligence: 점수 + 구성요소 + 근거 + 휴면 신호 + 1:1 리듬. */
export async function relationshipIntelligence(ctx: Ctx, contactId: string) {
  const userId = requireUser(ctx);
  const owned = await one<{ id: string }>("SELECT id FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [contactId, userId]);
  if (!owned) throw notFound("contact");
  const { obs, evidence, activities } = await observationsFor(userId, contactId);
  const signals = deriveRelSignals(obs);
  const result = relationshipStrength(signals, { evidence, confirmed: obs.confirmed, inferred: obs.inferred, daysSinceLastContact: obs.daysSinceLastContact });
  const stats = activityStats(activities);
  return {
    contactId,
    strength: result,
    signals,
    activity: { ...stats, lastActivityAt: stats.lastActivityAt?.toISOString() ?? null, oneToOne: oneToOneHealth(stats) },
    provenance: "ai_inferred" as const,
  };
}

/** 사용자가 관계를 교정한다(N-103: 수정은 audit 를 남기고 feature 를 재계산한다). */
export async function correctRelationship(ctx: Ctx, contactId: string, body: { userTrust?: number; relType?: string; confirmed?: boolean; label?: OutcomeLabel }) {
  const userId = requireUser(ctx);
  const rel = await one<{ id: string }>("SELECT id FROM relationships WHERE owner_user_id=$1 AND contact_id=$2", [userId, contactId]);
  if (!rel) throw notFound("relationship");
  if (body.userTrust != null && (body.userTrust < 0 || body.userTrust > 1)) throw badRequest("invalid_trust", "신뢰도는 0..1 이어야 합니다.");
  await tx(async (c) => {
    if (body.userTrust != null) {
      await c.query(
        `INSERT INTO relationship_signal_samples (owner_user_id, relationship_id, signal_type, value, model_version)
         VALUES ($1,$2,'user_trust',$3,'user-corrected')`,
        [userId, rel.id, body.userTrust],
      );
    }
    if (body.label) {
      await c.query(
        `INSERT INTO recommendation_feedback (owner_user_id, subject_type, subject_id, label) VALUES ($1,'search_result',$2,$3)`,
        [userId, contactId, body.label],
      );
    }
    await audit(c, ctx, "netintel.relationship_corrected", "contact", contactId, { userTrust: body.userTrust ?? null, label: body.label ?? null });
  });
  return relationshipIntelligence(ctx, contactId);
}

// ================================================================ N-108 Evidence

async function evidenceFor(userId: string, entityType: string, entityIds: string[], db: Db = pool()): Promise<Map<string, Evidence[]>> {
  if (!entityIds.length) return new Map();
  const rows = await q<{ id: string; entity_id: string; evidence_type: string; summary: string; confidence: string; occurred_at: Date | null; inferred: boolean }>(
    `SELECT id, entity_id, evidence_type, summary, confidence::text, occurred_at, inferred
       FROM evidence_records WHERE owner_user_id=$1 AND entity_type=$2 AND entity_id = ANY($3::uuid[])
       ORDER BY occurred_at DESC NULLS LAST LIMIT 2000`,
    [userId, entityType, entityIds],
    db,
  );
  const out = new Map<string, Evidence[]>();
  for (const r of rows) {
    const e: Evidence = {
      id: r.id,
      type: r.evidence_type as Evidence["type"],
      summary: r.summary,
      confidence: Number(r.confidence),
      occurredAt: r.occurred_at?.toISOString() ?? null,
      inferred: r.inferred,
    };
    const list = out.get(r.entity_id);
    if (list) list.push(e);
    else out.set(r.entity_id, [e]);
  }
  return out;
}

/** S19 Evidence Drawer: 추천 이유의 원천을 열어 본다. */
export async function listEvidence(ctx: Ctx, entityType: string, entityId: string) {
  const userId = requireUser(ctx);
  const map = await evidenceFor(userId, entityType, [entityId]);
  return { entityType, entityId, evidence: map.get(entityId) ?? [] };
}

export async function recordEvidence(ctx: Ctx, body: { entityType: string; entityId: string; evidenceType: Evidence["type"]; summary: string; occurredAt?: string | null; confidence?: number; inferred?: boolean; payload?: Record<string, unknown> }, db: Db = pool()) {
  const userId = requireUser(ctx);
  if (!body.summary?.trim()) throw badRequest("summary_required");
  const row = await one<{ id: string }>(
    `INSERT INTO evidence_records (owner_user_id, entity_type, entity_id, evidence_type, summary, occurred_at, confidence, inferred, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [userId, body.entityType, body.entityId, body.evidenceType, body.summary.trim().slice(0, 500), body.occurredAt ?? null, body.confidence ?? 0.7, body.inferred ?? false, JSON.stringify(body.payload ?? {})],
    db,
  );
  return { evidenceId: row!.id };
}

// ================================================================ N-015 / N-016 하이브리드 검색

export interface SearchOptions {
  query: string;
  projectId?: string | null;
  maxHops?: number;
  limit?: number;
  minConfidence?: number;
  /** 사용자가 chip 으로 고친 조건 — 다시 파싱하지 않는다 */
  intentEdits?: Partial<SearchIntent>;
  /**
   * 이미 적재한 네트워크를 재사용한다. 프로젝트 커버리지는 요구사항마다 검색을 돌리므로,
   * 이것이 없으면 요구사항 수만큼 같은 그래프를 다시 읽는다(요구사항 20개 × 5질의).
   */
  preloaded?: LoadedNetwork;
}

function factsFor(node: NodeRow, strength: number, capabilities: string[], needs: string[]): CandidateFacts {
  return {
    industries: node.industry ? [node.industry] : [],
    regions: node.region ? [node.region] : [],
    roleCategories: [node.roleCategory].filter((x): x is string => !!x),
    capabilities,
    needs,
    type: "person",
    relationshipStrength: strength,
    daysSinceLastContact: node.lastContactAt ? Math.max(0, (Date.now() - node.lastContactAt.getTime()) / 864e5) : null,
    dealsWon: 0,
    userPreference: 0,
    confidence: 1,
  };
}

/**
 * 하이브리드 검색. 패키지의 retriever plan 순서를 그대로 따른다(지침 §5, 패키지 §4):
 *   intent → hard filter → 후보 생성(SQL + 어휘유사도 + 그래프) → 근거 수집 → 경로 → privacy gate → 랭킹 → 다양성
 */
export async function search(ctx: Ctx, opts: SearchOptions) {
  const userId = requireUser(ctx);
  const raw = (opts.query ?? "").trim();
  if (raw.length < 2) throw badRequest("query_too_short", "검색어를 2자 이상 입력하세요.");
  const limit = Math.max(1, Math.min(50, opts.limit ?? 20));

  const net = opts.preloaded ?? (await loadNetwork(ctx));
  const aliases = await loadAliases(userId, net.orgId);
  let intent = parseSearchIntent(raw, { projectId: opts.projectId ?? null, aliases });
  if (opts.maxHops) intent = { ...intent, networkHopsMax: Math.max(1, Math.min(3, opts.maxHops)) };
  if (opts.intentEdits) intent = applyIntentEdits(intent, opts.intentEdits);

  const repo = new InMemoryGraphRepository(net.edges);
  const found = await repo.neighbors(net.meId, intent.networkHopsMax, 1500);
  const hopsOf = new Map(found.map((n) => [n.nodeId, n.hops]));

  const candidateIds = found.map((n) => n.nodeId).filter((id) => net.nodes.get(id)?.kind === "contact");
  const [caps, evidenceMap] = await Promise.all([capabilitiesFor(candidateIds), evidenceFor(userId, "contact", candidateIds)]);

  const results: Recommendation[] = [];
  for (const id of candidateIds) {
    const node = net.nodes.get(id)!;
    const hops = hopsOf.get(id) ?? intent.networkHopsMax;
    const decision = decisionFor(node, hops, net.meId);
    if (decision.level === "hidden") continue;

    const cap = caps.get(id) ?? { provides: [], needs: [] };
    const facts = factsFor(node, node.strength, cap.provides, cap.needs);
    const evidence = evidenceMap.get(id) ?? [];

    // 경로는 상위 후보에만 계산한다(3 hop 열거는 비싸다). 1촌은 경로가 자명하다.
    const paths: RankedPath[] = hops === 1 ? rankBusinessPaths(enumeratePaths(net.edges, net.meId, id, 1, 4), { k: 1, targetDisclosure: decision.level }) : [];

    const reco = buildRecommendation({
      identity: {
        id,
        type: "person",
        displayName: node.fullName,
        companyName: node.companyName,
        jobTitle: node.jobTitle,
        email: node.email,
        phone: node.phone,
        industry: node.industry,
        region: node.region,
      },
      facts,
      disclosure: decision,
      facets: { hops, industry: node.industry, region: node.region, hasPath: hops <= 1 || paths.length > 0 },
      evidence,
      paths,
      gate: { isSelf: false, blocked: false, deleted: false },
      intent,
      minConfidence: opts.minConfidence ?? 0.55,
    });
    if (reco) results.push(reco);
  }

  const ranked = diversify(results, limit);

  // 상위 결과에만 Top-K 대안 경로를 채운다 — SLO(P95 1.2s)를 지키기 위한 의도적 선택이다
  const maskedIds = new Set([...net.nodes.values()].filter((n) => !decisionFor(n, hopsOf.get(n.id) ?? 2, net.meId).gates.can_reveal_identity).map((n) => n.id));
  for (const r of ranked.slice(0, 10)) {
    if (r.paths.length) continue;
    const enumerated = enumeratePaths(net.edges, net.meId, r.resultId, intent.networkHopsMax, 40);
    r.paths = rankBusinessPaths(enumerated, { k: 3, maskedNodeIds: maskedIds, targetDisclosure: r.disclosure });
  }

  await audit(pool(), ctx, "netintel.search", "user", userId, { hops: intent.networkHopsMax, candidates: results.length, returned: ranked.length });
  return { parsedIntent: intent, results: ranked, total: results.length, provenance: "ai_inferred" as const };
}

async function capabilitiesFor(contactIds: string[], db: Db = pool()): Promise<Map<string, { provides: string[]; needs: string[] }>> {
  if (!contactIds.length) return new Map();
  const rows = await q<{ contact_id: string; kind: string; name: string }>(
    `SELECT cc.contact_id, cc.kind, cap.name
       FROM contact_capabilities cc JOIN capabilities cap ON cap.id = cc.capability_id
      WHERE cc.contact_id = ANY($1::uuid[]) LIMIT 20000`,
    [contactIds],
    db,
  );
  const out = new Map<string, { provides: string[]; needs: string[] }>();
  for (const r of rows) {
    const e = out.get(r.contact_id) ?? { provides: [], needs: [] };
    if (r.kind === "needs") e.needs.push(r.name);
    else e.provides.push(r.name);
    out.set(r.contact_id, e);
  }
  return out;
}

// ================================================================ N-105 Top-K 소개 경로

export async function introPaths(ctx: Ctx, opts: { targetContactId: string; maxHops?: number; k?: number }) {
  const userId = requireUser(ctx);
  const net = await loadNetwork(ctx);
  const target = net.nodes.get(opts.targetContactId);
  if (!target) throw notFound("contact");
  const maxHops = Math.max(1, Math.min(3, opts.maxHops ?? 3));
  const k = Math.max(1, Math.min(10, opts.k ?? 3));

  const repo = new InMemoryGraphRepository(net.edges);
  const found = await repo.neighbors(net.meId, maxHops, 2000);
  const hops = found.find((n) => n.nodeId === opts.targetContactId)?.hops ?? maxHops;
  const decision = decisionFor(target, hops, net.meId);
  if (decision.level === "hidden") throw forbidden("이 연락처는 네트워크 탐색에서 제외되었습니다.");

  const maskedIds = new Set(found.filter((n) => !decisionFor(net.nodes.get(n.nodeId) ?? target, n.hops, net.meId).gates.can_reveal_identity).map((n) => n.nodeId));
  const paths = rankBusinessPaths(await repo.paths(net.meId, opts.targetContactId, maxHops, 80), { k, maskedNodeIds: maskedIds, targetDisclosure: decision.level });

  // 경로의 노드를 공개 수준에 맞춰 라벨링한다. 중개자는 내가 아는 사람이므로 이름이 보인다.
  const labelled = paths.map((p) => ({
    ...p,
    nodes: p.nodeIds.map((id, i) => {
      const n = net.nodes.get(id);
      if (!n) return { id, label: "알 수 없음", masked: true, role: null };
      if (n.kind === "me") return { id, label: "나", masked: false, role: null };
      const nodeHops = i === p.nodeIds.length - 1 ? hops : 1;
      const d = decisionFor(n, nodeHops, net.meId);
      return d.gates.can_reveal_identity
        ? { id, label: n.fullName, masked: false, role: n.jobTitle, company: n.companyName }
        : { id, label: maskedLabel({ hops: nodeHops, industry: n.industry, region: n.region, roleCategory: n.roleCategory, hasPath: true }), masked: true, role: n.roleCategory };
    }),
  }));

  await audit(pool(), ctx, "netintel.intro_paths", "contact", opts.targetContactId, { hops, paths: labelled.length });
  return {
    target: {
      contactId: opts.targetContactId,
      disclosure: decision.level,
      displayName: decision.gates.can_reveal_identity ? target.fullName : null,
      maskedLabel: decision.gates.can_reveal_identity ? null : maskedLabel({ hops, industry: target.industry, region: target.region, roleCategory: target.roleCategory, hasPath: labelled.length > 0 }),
      withheldReasons: decision.reasons,
    },
    paths: labelled,
    provenance: "ai_inferred" as const,
  };
}

// ================================================================ N-022 공개 권한 설정

export async function setSharePermission(ctx: Ctx, contactId: string, body: { sharePermission?: SharePermission; discoveryOptOut?: boolean; orgShareOptIn?: boolean | null; purposeScope?: string[] }) {
  const userId = requireUser(ctx);
  const owned = await one<{ id: string }>("SELECT id FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [contactId, userId]);
  if (!owned) throw notFound("contact");
  if (body.sharePermission && !isSharePermission(body.sharePermission)) throw badRequest("invalid_share_permission");
  const row = await one<{ share_permission: string; discovery_opt_out: boolean; org_share_opt_in: boolean | null }>(
    `INSERT INTO contact_share_permissions (contact_id, share_permission, discovery_opt_out, org_share_opt_in, purpose_scope, set_by_user_id)
     VALUES ($1, COALESCE($2::text,'path_only'), COALESCE($3::boolean,false), $4::boolean, COALESCE($5::text[],'{}'), $6)
     ON CONFLICT (contact_id) DO UPDATE SET
       share_permission = COALESCE($2::text, contact_share_permissions.share_permission),
       discovery_opt_out = COALESCE($3::boolean, contact_share_permissions.discovery_opt_out),
       org_share_opt_in = CASE WHEN $7::boolean THEN $4::boolean ELSE contact_share_permissions.org_share_opt_in END,
       purpose_scope = COALESCE($5::text[], contact_share_permissions.purpose_scope),
       set_by_user_id = $6,
       updated_at = now()
     RETURNING share_permission, discovery_opt_out, org_share_opt_in`,
    [contactId, body.sharePermission ?? null, body.discoveryOptOut ?? null, body.orgShareOptIn ?? null, body.purposeScope ?? null, userId, Object.hasOwn(body, "orgShareOptIn")],
  );
  await audit(pool(), ctx, "netintel.share_permission_changed", "contact", contactId, { sharePermission: row?.share_permission, discoveryOptOut: row?.discovery_opt_out });
  return { contactId, ...row };
}

export async function getSharePermission(ctx: Ctx, contactId: string) {
  const userId = requireUser(ctx);
  const row = await one<{ share_permission: string; discovery_opt_out: boolean; org_share_opt_in: boolean | null; purpose_scope: string[] }>(
    `SELECT sp.share_permission, sp.discovery_opt_out, sp.org_share_opt_in, sp.purpose_scope
       FROM contacts c LEFT JOIN contact_share_permissions sp ON sp.contact_id = c.id
      WHERE c.id=$1 AND c.owner_user_id=$2 AND c.deleted_at IS NULL`,
    [contactId, userId],
  );
  if (!row) throw notFound("contact");
  return {
    contactId,
    sharePermission: row.share_permission ?? DEFAULT_SHARE,
    discoveryOptOut: row.discovery_opt_out ?? false,
    orgShareOptIn: row.org_share_opt_in ?? null,
    purposeScope: row.purpose_scope ?? [],
  };
}

// ================================================================ N-109 활동 기록

export async function recordActivity(ctx: Ctx, body: { contactId: string; activityType: NetworkActivity["type"]; occurredAt?: string; durationMinutes?: number | null; outcome?: NetworkActivity["outcome"]; note?: string | null; organizationId?: string | null }) {
  const userId = requireUser(ctx);
  const owned = await one<{ id: string }>("SELECT id FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [body.contactId, userId]);
  if (!owned) throw notFound("contact");
  const result = await tx(async (c) => {
    const ev = await one<{ id: string }>(
      `INSERT INTO evidence_records (owner_user_id, entity_type, entity_id, evidence_type, summary, occurred_at, confidence, inferred)
       VALUES ($1,'contact',$2,$3,$4,$5,1.0,false) RETURNING id`,
      [userId, body.contactId, body.activityType === "one_to_one" || body.activityType === "group_meeting" ? "meeting" : body.activityType.startsWith("referral") ? "referral" : "interaction", activitySummary(body), body.occurredAt ?? new Date().toISOString()],
      c,
    );
    const row = await one<{ id: string }>(
      `INSERT INTO network_activities (owner_user_id, contact_id, organization_id, activity_type, occurred_at, duration_minutes, outcome, note, evidence_id)
       VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz, now()),$6,$7,$8,$9) RETURNING id`,
      [userId, body.contactId, body.organizationId ?? null, body.activityType, body.occurredAt ?? null, body.durationMinutes ?? null, body.outcome ?? null, body.note?.slice(0, 1000) ?? null, ev!.id],
      c,
    );
    await audit(c, ctx, "netintel.activity_recorded", "contact", body.contactId, { activityType: body.activityType, outcome: body.outcome ?? null });
    return row!.id;
  });
  return { activityId: result, evidenceLinked: true };
}

function activitySummary(b: { activityType: string; durationMinutes?: number | null; outcome?: string | null }): string {
  const label: Record<string, string> = { one_to_one: "1:1 미팅", referral_given: "소개를 해 줌", referral_received: "소개를 받음", testimonial: "추천사", group_meeting: "그룹 미팅", introduction: "소개 진행", follow_up: "후속 연락" };
  const parts = [label[b.activityType] ?? b.activityType];
  if (b.durationMinutes) parts.push(`${b.durationMinutes}분`);
  if (b.outcome) parts.push(`결과: ${b.outcome}`);
  return parts.join(" · ");
}

export async function listActivities(ctx: Ctx, contactId: string) {
  const userId = requireUser(ctx);
  const rows = await q<{ id: string; activity_type: string; occurred_at: Date; duration_minutes: number | null; outcome: string | null; note: string | null; evidence_id: string | null }>(
    `SELECT id, activity_type, occurred_at, duration_minutes, outcome, note, evidence_id
       FROM network_activities WHERE owner_user_id=$1 AND contact_id=$2 ORDER BY occurred_at DESC LIMIT 200`,
    [userId, contactId],
  );
  return { contactId, activities: rows.map((r) => ({ id: r.id, activityType: r.activity_type, occurredAt: r.occurred_at.toISOString(), durationMinutes: r.duration_minutes, outcome: r.outcome, note: r.note, evidenceId: r.evidence_id })) };
}

// ================================================================ N-018 / N-019 프로젝트

export async function listProjects(ctx: Ctx) {
  const userId = requireUser(ctx);
  const rows = await q<{ id: string; name: string; description: string | null; status: string; target_regions: string[]; target_industries: string[]; deadline: Date | null; requirements_confirmed_at: Date | null; requirement_count: number; gap_count: number }>(
    `SELECT p.*, (SELECT count(*)::int FROM project_requirements r WHERE r.project_id=p.id) AS requirement_count,
            (SELECT count(*)::int FROM project_requirements r WHERE r.project_id=p.id AND r.coverage_status='gap') AS gap_count
       FROM projects p WHERE p.owner_user_id=$1 AND p.status <> 'archived' ORDER BY p.updated_at DESC LIMIT 100`,
    [userId],
  );
  return {
    projects: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status,
      targetRegions: r.target_regions,
      targetIndustries: r.target_industries,
      deadline: r.deadline ? r.deadline.toISOString().slice(0, 10) : null,
      requirementsConfirmed: r.requirements_confirmed_at != null,
      requirementCount: r.requirement_count,
      gapCount: r.gap_count,
    })),
  };
}

export async function createProject(ctx: Ctx, body: { name: string; description?: string; targetRegions?: string[]; targetIndustries?: string[]; deadline?: string | null }) {
  const userId = requireUser(ctx);
  if (!body.name?.trim()) throw badRequest("name_required", "프로젝트 이름을 입력하세요.");
  const orgId = await activeOrgId(userId);
  const row = await one<{ id: string }>(
    `INSERT INTO projects (owner_user_id, organization_id, name, description, target_regions, target_industries, deadline, status)
     VALUES ($1,$2,$3,$4,COALESCE($5::text[],'{}'),COALESCE($6::text[],'{}'),$7::date,'active') RETURNING id`,
    [userId, orgId, body.name.trim().slice(0, 200), body.description?.slice(0, 4000) ?? null, body.targetRegions ?? null, body.targetIndustries ?? null, body.deadline ?? null],
  );
  await audit(pool(), ctx, "netintel.project_created", "project", row!.id, { name: body.name.trim().slice(0, 80) });
  return { projectId: row!.id };
}

/**
 * N-018: 설명에서 Role/Need **초안**을 만든다. 초안은 accepted_at 이 null 이라 커버리지를 확정으로 쓰지 않는다.
 * 사용자가 검토·확정(`confirmRequirements`)해야 요구사항이 된다.
 */
export async function analyzeProject(ctx: Ctx, projectId: string) {
  const userId = requireUser(ctx);
  const p = await one<{ id: string; name: string; description: string | null; target_industries: string[]; target_regions: string[] }>(
    "SELECT id, name, description, target_industries, target_regions FROM projects WHERE id=$1 AND owner_user_id=$2",
    [projectId, userId],
  );
  if (!p) throw notFound("project");
  const drafts = decomposeProject({ name: p.name, description: p.description ?? "", targetIndustries: p.target_industries, targetRegions: p.target_regions });
  const created = await tx(async (c) => {
    // 기존 **초안**만 지운다. 사용자가 확정한 요구사항은 건드리지 않는다.
    await c.query("DELETE FROM project_requirements WHERE project_id=$1 AND accepted_at IS NULL AND provenance <> 'user'", [projectId]);
    const ids: string[] = [];
    for (const d of drafts) {
      const r = await one<{ id: string }>(
        `INSERT INTO project_requirements (project_id, kind, name, description, priority, industry, region, source_sentence, provenance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'rule_parsed') RETURNING id`,
        [projectId, d.kind, d.name, d.description, d.priority, d.industry, d.region, d.sourceSentence],
        c,
      );
      ids.push(r!.id);
    }
    await audit(c, ctx, "netintel.project_analyzed", "project", projectId, { drafts: ids.length });
    return ids;
  });
  return { projectId, drafts: drafts.length, requirementIds: created, needsReview: true, provenance: "rule_parsed" as const };
}

export async function confirmRequirements(ctx: Ctx, projectId: string, body: { requirementIds: string[] }) {
  const userId = requireUser(ctx);
  const p = await one<{ id: string }>("SELECT id FROM projects WHERE id=$1 AND owner_user_id=$2", [projectId, userId]);
  if (!p) throw notFound("project");
  if (!body.requirementIds?.length) throw badRequest("requirements_required", "확정할 요구사항을 선택하세요.");
  await tx(async (c) => {
    await c.query("UPDATE project_requirements SET accepted_at = now() WHERE project_id=$1 AND id = ANY($2::uuid[])", [projectId, body.requirementIds]);
    // 선택하지 않은 초안은 사용자가 거부한 것이다 — 남겨두면 커버리지를 왜곡한다
    await c.query("DELETE FROM project_requirements WHERE project_id=$1 AND accepted_at IS NULL AND provenance <> 'user'", [projectId]);
    await c.query("UPDATE projects SET requirements_confirmed_at = now(), updated_at = now() WHERE id=$1", [projectId]);
    await c.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload) VALUES ('project',$1,'network.project.requirements.confirmed',$2)`,
      [projectId, JSON.stringify({ project_id: projectId, requirement_ids: body.requirementIds })],
    );
    await audit(c, ctx, "netintel.requirements_confirmed", "project", projectId, { count: body.requirementIds.length });
  });
  return { projectId, confirmed: body.requirementIds.length };
}

export async function addRequirement(ctx: Ctx, projectId: string, body: { kind: RequirementKind; name: string; description?: string; priority?: number; industry?: string | null; region?: string | null }) {
  const userId = requireUser(ctx);
  const p = await one<{ id: string }>("SELECT id FROM projects WHERE id=$1 AND owner_user_id=$2", [projectId, userId]);
  if (!p) throw notFound("project");
  if (!body.name?.trim()) throw badRequest("name_required");
  const row = await one<{ id: string }>(
    `INSERT INTO project_requirements (project_id, kind, name, description, priority, industry, region, provenance, accepted_at)
     VALUES ($1,$2,$3,$4,COALESCE($5::smallint,3),$6,$7,'user', now()) RETURNING id`,
    [projectId, body.kind, body.name.trim().slice(0, 200), body.description?.slice(0, 1000) ?? null, body.priority ?? null, body.industry ?? null, body.region ?? null],
  );
  return { requirementId: row!.id };
}

/** N-019: 요구사항별 covered/partial/gap + Network Gap 제안. */
export async function projectCoverage(ctx: Ctx, projectId: string) {
  const userId = requireUser(ctx);
  const p = await one<{ id: string; name: string; description: string | null; target_industries: string[]; target_regions: string[]; requirements_confirmed_at: Date | null }>(
    "SELECT id, name, description, target_industries, target_regions, requirements_confirmed_at FROM projects WHERE id=$1 AND owner_user_id=$2",
    [projectId, userId],
  );
  if (!p) throw notFound("project");
  const reqs = await q<{ id: string; kind: string; name: string; description: string | null; priority: number; industry: string | null; region: string | null; min_confidence: string; source_sentence: string | null; provenance: string; accepted_at: Date | null }>(
    "SELECT id, kind, name, description, priority, industry, region, min_confidence::text, source_sentence, provenance, accepted_at FROM project_requirements WHERE project_id=$1 ORDER BY priority, created_at",
    [projectId],
  );

  const cells: ReturnType<typeof coverageFor>[] = [];
  const orgId = await activeOrgId(userId);
  // 요구사항마다 검색을 돌리지만 그래프는 한 번만 읽는다
  const net = await loadNetwork(ctx);
  for (const r of reqs) {
    // 요구사항 하나를 질의로 바꿔 같은 검색 엔진을 통과시킨다 — 커버리지와 검색이 어긋나지 않는다
    const query = [r.name, r.description, r.industry ?? p.target_industries[0], r.region ?? p.target_regions[0]].filter(Boolean).join(" ");
    let candidates: CoverageCandidate[] = [];
    try {
      const found = await search(ctx, { query, projectId, limit: 10, minConfidence: Number(r.min_confidence), preloaded: net });
      candidates = found.results.map((x) => ({
        resultId: x.resultId,
        score: x.score,
        disclosure: x.disclosure,
        hops: x.paths[0]?.hops ?? null,
        hasPath: x.paths.length > 0,
        displayName: x.displayName,
        maskedLabel: x.maskedLabel,
      }));
    } catch (e) {
      // 한 요구사항의 검색 실패가 전체 커버리지를 깨뜨리면 안 된다 — gap 으로 표시하고 계속한다
      log("warn", "netintel.coverage.search_failed", { requirementId: r.id, error: (e as Error).message });
    }
    cells.push(coverageFor({ id: r.id, kind: r.kind as RequirementKind, name: r.name, priority: r.priority }, candidates));
  }

  const summary = coverageSummary(cells);
  await tx(async (c) => {
    for (const cell of cells) {
      await c.query("UPDATE project_requirements SET coverage_status=$2, coverage_computed_at=now() WHERE id=$1", [cell.requirementId, cell.status]);
    }
  });
  const suggestions = gapSuggestions(cells, {
    hopsUsed: 3,
    hasOrgNetwork: orgId != null,
    hadRegionFilter: p.target_regions.length > 0 || reqs.some((r) => r.region),
    hadIndustryFilter: p.target_industries.length > 0 || reqs.some((r) => r.industry),
  });
  return {
    projectId,
    requirementsConfirmed: p.requirements_confirmed_at != null,
    requirements: reqs.map((r) => ({ id: r.id, kind: r.kind, name: r.name, priority: r.priority, sourceSentence: r.source_sentence, provenance: r.provenance, accepted: r.accepted_at != null })),
    coverage: cells,
    summary,
    gapSuggestions: suggestions,
  };
}

// ================================================================ N-021 기회 파이프라인

export async function listOpportunities(ctx: Ctx, opts: { projectId?: string | null } = {}) {
  const userId = requireUser(ctx);
  const rows = await q<{ id: string; project_id: string | null; project_name: string | null; requirement_id: string | null; requirement_name: string | null; target_contact_id: string | null; stage: string; stage_entered_at: Date; recommendation_score: string | null; explanation: Record<string, unknown>; introduction_id: string | null }>(
    `SELECT o.id, o.project_id, p.name AS project_name, o.requirement_id, r.name AS requirement_name,
            o.target_contact_id, o.stage, o.stage_entered_at, o.recommendation_score::text, o.explanation, o.introduction_id
       FROM opportunities o
       LEFT JOIN projects p ON p.id = o.project_id
       LEFT JOIN project_requirements r ON r.id = o.requirement_id
      WHERE o.owner_user_id=$1 AND ($2::uuid IS NULL OR o.project_id = $2) AND o.stage <> 'dismissed'
      ORDER BY o.updated_at DESC LIMIT 300`,
    [userId, opts.projectId ?? null],
  );
  const net = await loadNetwork(ctx);
  return {
    columns: OPPORTUNITY_BOARD_COLUMNS,
    opportunities: rows.map((r) => {
      const node = r.target_contact_id ? net.nodes.get(r.target_contact_id) : null;
      const d = node ? decisionFor(node, 2, net.meId) : null;
      return {
        id: r.id,
        projectId: r.project_id,
        projectName: r.project_name,
        requirementName: r.requirement_name,
        stage: r.stage,
        score: r.recommendation_score ? Number(r.recommendation_score) : null,
        explanation: r.explanation,
        introductionId: r.introduction_id,
        health: opportunityHealth(r.stage as OpportunityStage, r.stage_entered_at),
        target: node
          ? {
              contactId: node.id,
              displayName: d?.gates.can_reveal_identity ? node.fullName : null,
              maskedLabel: d?.gates.can_reveal_identity ? null : maskedLabel({ hops: 2, industry: node.industry, region: node.region, roleCategory: node.roleCategory, hasPath: true }),
            }
          : null,
      };
    }),
  };
}

export async function createOpportunity(ctx: Ctx, body: { projectId?: string | null; requirementId?: string | null; targetContactId: string; score?: number; explanation?: Record<string, unknown>; recommendedPath?: unknown[] }) {
  const userId = requireUser(ctx);
  if (!body.targetContactId) throw badRequest("target_required");
  const existing = await one<{ id: string }>(
    "SELECT id FROM opportunities WHERE owner_user_id=$1 AND target_contact_id=$2 AND COALESCE(project_id::text,'') = COALESCE($3::text,'') AND stage NOT IN ('won','lost','dismissed')",
    [userId, body.targetContactId, body.projectId ?? null],
  );
  if (existing) throw conflict("opportunity_exists", "이미 진행 중인 기회가 있습니다.", { opportunityId: existing.id });
  const row = await tx(async (c) => {
    const r = await one<{ id: string }>(
      `INSERT INTO opportunities (owner_user_id, project_id, requirement_id, target_contact_id, stage, recommendation_score, explanation, recommended_path)
       VALUES ($1,$2,$3,$4,'detected',$5,$6,$7) RETURNING id`,
      [userId, body.projectId ?? null, body.requirementId ?? null, body.targetContactId, body.score ?? null, JSON.stringify(body.explanation ?? {}), JSON.stringify(body.recommendedPath ?? [])],
      c,
    );
    await c.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload) VALUES ('opportunity',$1,'network.opportunity.detected',$2)`,
      [r!.id, JSON.stringify({ opportunity_id: r!.id, project_id: body.projectId ?? null, score: body.score ?? 0 })],
    );
    await audit(c, ctx, "netintel.opportunity_created", "opportunity", r!.id, { projectId: body.projectId ?? null });
    return r!.id;
  });
  return { opportunityId: row, stage: "detected" as const };
}

export async function advanceOpportunity(ctx: Ctx, opportunityId: string, body: { stage: OpportunityStage; note?: string }) {
  const userId = requireUser(ctx);
  const o = await one<{ id: string; stage: string }>("SELECT id, stage FROM opportunities WHERE id=$1 AND owner_user_id=$2", [opportunityId, userId]);
  if (!o) throw notFound("opportunity");
  if (!canOpportunityTransition(o.stage as OpportunityStage, body.stage)) {
    throw conflict("invalid_transition", `${o.stage} → ${body.stage} 로는 이동할 수 없습니다.`, { from: o.stage, allowed: [] });
  }
  await tx(async (c) => {
    await c.query("UPDATE opportunities SET stage=$2, stage_entered_at=now(), updated_at=now() WHERE id=$1", [opportunityId, body.stage]);
    const label = outcomeLabelFor(body.stage);
    if (label) {
      await c.query(
        `INSERT INTO recommendation_feedback (owner_user_id, subject_type, subject_id, label, score_components, note)
         SELECT $1,'opportunity',$2,$3, COALESCE(o.explanation->'scoreComponents','{}'::jsonb), $4 FROM opportunities o WHERE o.id=$2`,
        [userId, opportunityId, label, body.note?.slice(0, 500) ?? null],
      );
      await c.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload) VALUES ('opportunity',$1,'network.outcome.recorded',$2)`,
        [opportunityId, JSON.stringify({ subject_type: "opportunity", subject_id: opportunityId, label })],
      );
    }
    await audit(c, ctx, "netintel.opportunity_advanced", "opportunity", opportunityId, { from: o.stage, to: body.stage });
  });
  return { opportunityId, stage: body.stage };
}

// ================================================================ N-106 저장된 검색

export async function listSavedSearches(ctx: Ctx) {
  const userId = requireUser(ctx);
  const rows = await q<{ id: string; name: string; query: string; intent: SearchIntent; alert_enabled: boolean; alert_frequency: string; last_run_at: Date | null }>(
    "SELECT id, name, query, intent, alert_enabled, alert_frequency, last_run_at FROM saved_searches WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 100",
    [userId],
  );
  return {
    savedSearches: rows.map((r) => ({ id: r.id, name: r.name, query: r.query, intent: r.intent, alertEnabled: r.alert_enabled, alertFrequency: r.alert_frequency, lastRunAt: r.last_run_at?.toISOString() ?? null })),
  };
}

export async function saveSearch(ctx: Ctx, body: { name?: string; query: string; intent?: Partial<SearchIntent>; alertEnabled?: boolean; alertFrequency?: "daily" | "weekly" | "monthly" }) {
  const userId = requireUser(ctx);
  if (!body.query?.trim()) throw badRequest("query_required");
  const name = body.name?.trim() || body.query.trim().slice(0, 60);
  const row = await one<{ id: string }>(
    `INSERT INTO saved_searches (owner_user_id, name, query, intent, alert_enabled, alert_frequency)
     VALUES ($1,$2,$3,$4,COALESCE($5::boolean,false),COALESCE($6::text,'weekly')) RETURNING id`,
    [userId, name, body.query.trim(), JSON.stringify(body.intent ?? {}), body.alertEnabled ?? null, body.alertFrequency ?? null],
  );
  return { savedSearchId: row!.id, name };
}

export async function deleteSavedSearch(ctx: Ctx, id: string) {
  const userId = requireUser(ctx);
  const r = await one<{ id: string }>("DELETE FROM saved_searches WHERE id=$1 AND owner_user_id=$2 RETURNING id", [id, userId]);
  if (!r) throw notFound("saved search");
  return { deleted: true };
}

/** 저장된 검색을 실행하고 **새로 생긴 후보만** 알린다. 같은 결과를 매주 다시 알리지 않는다. */
export async function runSavedSearch(ctx: Ctx, id: string) {
  const userId = requireUser(ctx);
  const s = await one<{ id: string; query: string; intent: Partial<SearchIntent>; last_result_ids: string[] }>(
    "SELECT id, query, intent, last_result_ids FROM saved_searches WHERE id=$1 AND owner_user_id=$2",
    [id, userId],
  );
  if (!s) throw notFound("saved search");
  const found = await search(ctx, { query: s.query, intentEdits: Object.keys(s.intent ?? {}).length ? s.intent : undefined });
  const previous = new Set(s.last_result_ids ?? []);
  const fresh = found.results.filter((r) => !previous.has(r.resultId));
  await pool().query("UPDATE saved_searches SET last_run_at = now(), last_result_ids = $2 WHERE id = $1", [id, found.results.map((r) => r.resultId)]);
  return { ...found, newResultIds: fresh.map((r) => r.resultId), newCount: fresh.length };
}

// ================================================================ N-110 Referral Partner / ICP

export async function getIcp(ctx: Ctx) {
  const userId = requireUser(ctx);
  const row = await one<{ id: string; name: string; industries: string[]; regions: string[]; role_categories: string[]; needs: string[]; description: string | null }>(
    "SELECT id, name, industries, regions, role_categories, needs, description FROM ideal_customer_profiles WHERE owner_user_id=$1 AND is_default ORDER BY updated_at DESC LIMIT 1",
    [userId],
  );
  return {
    icp: row
      ? { id: row.id, name: row.name, industries: row.industries, regions: row.regions, roleCategories: row.role_categories, needs: row.needs, description: row.description }
      : null,
    options: { industries: INDUSTRIES.map((i) => i.name), regions: REGIONS.map((r) => r.name), roleCategories: ROLE_CATEGORIES.map((r) => r.name) },
  };
}

export async function setIcp(ctx: Ctx, body: { name?: string; industries?: string[]; regions?: string[]; roleCategories?: string[]; needs?: string[]; description?: string | null }) {
  const userId = requireUser(ctx);
  const row = await one<{ id: string }>(
    `INSERT INTO ideal_customer_profiles (owner_user_id, name, industries, regions, role_categories, needs, description, is_default)
     VALUES ($1, COALESCE($2::text,'기본 고객상'), COALESCE($3::text[],'{}'), COALESCE($4::text[],'{}'), COALESCE($5::text[],'{}'), COALESCE($6::text[],'{}'), $7::text, true)
     ON CONFLICT (owner_user_id) WHERE is_default DO UPDATE SET
       name = COALESCE($2::text, ideal_customer_profiles.name),
       industries = COALESCE($3::text[], ideal_customer_profiles.industries),
       regions = COALESCE($4::text[], ideal_customer_profiles.regions),
       role_categories = COALESCE($5::text[], ideal_customer_profiles.role_categories),
       needs = COALESCE($6::text[], ideal_customer_profiles.needs),
       description = COALESCE($7::text, ideal_customer_profiles.description),
       updated_at = now()
     RETURNING id`,
    [userId, body.name ?? null, body.industries ?? null, body.regions ?? null, body.roleCategories ?? null, body.needs ?? null, body.description ?? null],
  );
  return { icpId: row!.id };
}

/** S18: 단순 업종 일치가 아니라 **교차 소개 가능성**으로 파트너를 찾는다. */
export async function referralPartners(ctx: Ctx, limit = 20) {
  const userId = requireUser(ctx);
  const { icp } = await getIcp(ctx);
  if (!icp || (!icp.industries.length && !icp.regions.length && !icp.roleCategories.length && !icp.needs.length)) {
    return { partners: [], needsIcp: true, provenance: "ai_inferred" as const };
  }
  const myOffers = await q<{ text: string }>(
    "SELECT o.text FROM offers o JOIN profiles p ON p.id = o.profile_id WHERE p.user_id = $1 LIMIT 50",
    [userId],
  );
  const net = await loadNetwork(ctx);
  const repo = new InMemoryGraphRepository(net.edges);
  const found = await repo.neighbors(net.meId, 2, 1000);
  const hopsOf = new Map(found.map((n) => [n.nodeId, n.hops]));

  // 각 1촌 연락처의 "네트워크 분포" = 그 사람이 아는 사람들의 산업/역할
  const dist = new Map<string, { industries: Set<string>; roles: Set<string> }>();
  for (const e of net.edges) {
    const to = net.nodes.get(e.toId);
    if (!to || e.fromId === net.meId) continue;
    const d = dist.get(e.fromId) ?? { industries: new Set<string>(), roles: new Set<string>() };
    if (to.industry) d.industries.add(to.industry);
    const rc = to.roleCategory;
    if (rc) d.roles.add(rc);
    dist.set(e.fromId, d);
  }

  const candidateIds = [...new Set(found.filter((n) => (n.hops ?? 3) <= 2).map((n) => n.nodeId))].filter((id) => net.nodes.get(id)?.kind === "contact");
  const caps = await capabilitiesFor(candidateIds);
  const others = candidateIds
    .map((id) => {
      const node = net.nodes.get(id)!;
      const d = dist.get(id) ?? { industries: new Set<string>(), roles: new Set<string>() };
      const cap = caps.get(id) ?? { provides: [], needs: [] };
      return {
        id,
        icp: { industries: node.industry ? [node.industry] : [], regions: node.region ? [node.region] : [], roleCategories: [], needs: cap.needs },
        capabilities: cap.provides,
        networkIndustries: [...d.industries],
        networkRoleCategories: [...d.roles],
        strength: node.strength,
        hops: hopsOf.get(id) ?? 2,
        referralTrack: 0,
      };
    })
    .filter((o) => o.networkIndustries.length || o.capabilities.length);

  const tracks = await q<{ contact_id: string; given: number; succeeded: number }>(
    `SELECT contact_id, count(*)::int AS given, count(*) FILTER (WHERE outcome IN ('met','qualified','won'))::int AS succeeded
       FROM network_activities WHERE owner_user_id=$1 AND activity_type IN ('referral_given','referral_received') AND contact_id = ANY($2::uuid[])
      GROUP BY contact_id`,
    [userId, candidateIds],
  );
  const trackMap = new Map(tracks.map((t) => [t.contact_id, t.given ? t.succeeded / t.given : 0]));
  for (const o of others) o.referralTrack = trackMap.get(o.id) ?? 0;

  const ranked = rankReferralPartners({ icp: { industries: icp.industries, regions: icp.regions, roleCategories: icp.roleCategories, needs: icp.needs }, capabilities: myOffers.map((o) => o.text) }, others, limit);
  return {
    needsIcp: false,
    partners: ranked.map((r) => {
      const node = net.nodes.get(r.partnerId)!;
      const d = decisionFor(node, hopsOf.get(r.partnerId) ?? 2, net.meId);
      return {
        ...r,
        hops: hopsOf.get(r.partnerId) ?? 2,
        disclosure: d.level,
        displayName: d.gates.can_reveal_identity ? node.fullName : null,
        maskedLabel: d.gates.can_reveal_identity ? null : maskedLabel({ hops: hopsOf.get(r.partnerId) ?? 2, industry: node.industry, region: node.region, roleCategory: node.roleCategory, hasPath: true }),
        companyName: d.gates.can_reveal_identity ? node.companyName : null,
      };
    }),
    provenance: "ai_inferred" as const,
  };
}

/** ICP 적합도만 따로 본다(연락처 하나에 대해). */
export async function icpFitFor(ctx: Ctx, contactId: string) {
  const { icp } = await getIcp(ctx);
  if (!icp) return { contactId, fit: null, needsIcp: true };
  const net = await loadNetwork(ctx);
  const node = net.nodes.get(contactId);
  if (!node) throw notFound("contact");
  // 탐색 권한이 없는 대상은 적합도조차 계산하지 않는다 — 점수만으로도 존재를 확인시켜 주게 된다
  if (decisionFor(node, 2, net.meId).level === "hidden") throw notFound("contact");
  const caps = await capabilitiesFor([contactId]);
  const fit = icpFit(
    { industries: node.industry ? [node.industry] : [], regions: node.region ? [node.region] : [], roleCategories: [node.roleCategory].filter((x): x is string => !!x), needs: caps.get(contactId)?.needs ?? [] },
    { industries: icp.industries, regions: icp.regions, roleCategories: icp.roleCategories, needs: icp.needs },
  );
  return { contactId, fit, needsIcp: false };
}

// ================================================================ N-008 소속 이력

/** 한 연락처의 회사 소속 이력. 현재 소속과 과거 소속을 모두 보여준다(Person 360 의 Companies 탭). */
export async function listRoles(ctx: Ctx, contactId: string) {
  const userId = requireUser(ctx);
  const owned = await one<{ id: string }>("SELECT id FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [contactId, userId]);
  if (!owned) throw notFound("contact");
  const rows = await q<{ id: string; company_id: string; company: string | null; title: string | null; department: string | null; role_type: string; role_category: string | null; started_on: Date | null; ended_on: Date | null; is_current: boolean; decides_for: boolean; provenance: string; confidence: string }>(
    `SELECT r.id, r.company_id, co.name AS company, r.title, r.department, r.role_type, r.role_category,
            r.started_on, r.ended_on, r.is_current, r.decides_for, r.provenance, r.confidence::text
       FROM contact_company_roles r LEFT JOIN companies co ON co.id = r.company_id
      WHERE r.contact_id = $1
      ORDER BY r.is_current DESC, r.started_on DESC NULLS LAST, r.ended_on DESC NULLS LAST LIMIT 100`,
    [contactId],
  );
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  return {
    contactId,
    roles: rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      company: r.company,
      title: r.title,
      department: r.department,
      roleType: r.role_type,
      roleCategory: r.role_category,
      startedOn: day(r.started_on),
      endedOn: day(r.ended_on),
      isCurrent: r.is_current,
      decidesFor: r.decides_for,
      provenance: r.provenance,
      confidence: Number(r.confidence),
    })),
    roleCategoryOptions: ROLE_CATEGORIES.map((c) => c.name),
  };
}

/**
 * 소속을 추가한다. 회사는 이름으로 찾거나 새로 만든다(companies 는 전역 테이블이므로 normalized_name 으로 합친다).
 * role_category 는 사용자가 고르지 않으면 직책 텍스트에서 추론한다 — 그 값이 masked 라벨에 쓰인다.
 */
export async function addRole(ctx: Ctx, body: { contactId: string; companyName: string; title?: string | null; department?: string | null; roleType?: string; roleCategory?: string | null; startedOn?: string | null; endedOn?: string | null; isCurrent?: boolean; decidesFor?: boolean }) {
  const userId = requireUser(ctx);
  const owned = await one<{ id: string }>("SELECT id FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [body.contactId, userId]);
  if (!owned) throw notFound("contact");
  const name = body.companyName?.trim();
  if (!name) throw badRequest("company_required", "회사 이름을 입력하세요.");
  const category = body.roleCategory ?? roleCategory(body.title);
  if (body.roleCategory && !ROLE_CATEGORIES.some((c) => c.name === body.roleCategory)) throw badRequest("invalid_role_category");

  const roleId = await tx(async (c) => {
    const existing = await one<{ id: string }>("SELECT id FROM companies WHERE normalized_name = $1 LIMIT 1", [canonicalKey(name)], c);
    const companyId =
      existing?.id ??
      (await one<{ id: string }>("INSERT INTO companies (name, normalized_name) VALUES ($1,$2) RETURNING id", [name.slice(0, 160), canonicalKey(name)], c))!.id;
    // 새 현재 소속이 들어오면 기존 현재 소속을 닫는다 — is_current 가 여러 개면 역할 카테고리가 흔들린다
    if (body.isCurrent !== false) {
      await c.query("UPDATE contact_company_roles SET is_current = false, ended_on = COALESCE(ended_on, current_date) WHERE contact_id = $1 AND is_current", [body.contactId]);
    }
    const r = await one<{ id: string }>(
      `INSERT INTO contact_company_roles (contact_id, company_id, title, department, role_type, role_category, started_on, ended_on, is_current, decides_for, source, provenance)
       VALUES ($1,$2,$3,$4,COALESCE($5::text,'employee'),$6,$7::date,$8::date,COALESCE($9::boolean,true),COALESCE($10::boolean,false),'manual','user')
       RETURNING id`,
      [body.contactId, companyId, body.title?.slice(0, 160) ?? null, body.department?.slice(0, 160) ?? null, body.roleType ?? null, category, body.startedOn ?? null, body.endedOn ?? null, body.isCurrent ?? null, body.decidesFor ?? null],
      c,
    );
    // 현재 소속이면 연락처의 대표 회사도 맞춰 둔다(Person 360 헤더와 어긋나지 않게)
    if (body.isCurrent !== false) await c.query("UPDATE contacts SET company_id = $2, updated_at = now() WHERE id = $1", [body.contactId, companyId]);
    await audit(c, ctx, "netintel.role_added", "contact", body.contactId, { company: name.slice(0, 60), isCurrent: body.isCurrent !== false });
    return r!.id;
  });
  return { roleId };
}

export async function endRole(ctx: Ctx, roleId: string, body: { endedOn?: string | null }) {
  const userId = requireUser(ctx);
  const row = await one<{ id: string; contact_id: string }>(
    `SELECT r.id, r.contact_id FROM contact_company_roles r JOIN contacts c ON c.id = r.contact_id
      WHERE r.id = $1 AND c.owner_user_id = $2 AND c.deleted_at IS NULL`,
    [roleId, userId],
  );
  if (!row) throw notFound("role");
  await pool().query("UPDATE contact_company_roles SET is_current = false, ended_on = COALESCE($2::date, current_date) WHERE id = $1", [roleId, body.endedOn ?? null]);
  await audit(pool(), ctx, "netintel.role_ended", "contact", row.contact_id, { roleId });
  return { roleId, isCurrent: false };
}

// ================================================================ N-107 분류 별칭

/** 내 별칭 + 활성 조직의 별칭. 조직 별칭은 구성원 모두에게 적용된다. */
async function loadAliases(userId: string, orgId: string | null, db: Db = pool()): Promise<TaxonomyAlias[]> {
  const rows = await q<{ kind: string; alias: string; canonical_name: string }>(
    `SELECT kind, alias, canonical_name FROM taxonomy_aliases
      WHERE owner_user_id = $1 OR ($2::uuid IS NOT NULL AND organization_id = $2) LIMIT 2000`,
    [userId, orgId],
    db,
  );
  return rows.map((r) => ({ kind: r.kind as TaxonomyAlias["kind"], alias: r.alias, canonicalName: r.canonical_name }));
}

export async function listAliases(ctx: Ctx) {
  const userId = requireUser(ctx);
  const orgId = await activeOrgId(userId);
  const rows = await q<{ id: string; kind: string; alias: string; canonical_name: string; organization_id: string | null }>(
    `SELECT id, kind, alias, canonical_name, organization_id FROM taxonomy_aliases
      WHERE owner_user_id = $1 OR ($2::uuid IS NOT NULL AND organization_id = $2)
      ORDER BY kind, alias LIMIT 500`,
    [userId, orgId],
  );
  return {
    aliases: rows.map((r) => ({ id: r.id, kind: r.kind, alias: r.alias, canonicalName: r.canonical_name, scope: r.organization_id ? "organization" : "personal" })),
    options: { industry: INDUSTRIES.map((i) => i.name), region: REGIONS.map((r) => r.name), role: ROLE_CATEGORIES.map((r) => r.name) },
  };
}

export async function addAlias(ctx: Ctx, body: { kind: AliasKind; alias: string; canonicalName: string; shareWithOrg?: boolean }) {
  const userId = requireUser(ctx);
  // 사전에 없는 canonical 값을 통과시키면 추천 feature 가 조용히 어긋난다 — 도메인이 검증한다
  const v = validateAlias({ kind: body.kind, alias: body.alias, canonicalName: body.canonicalName });
  if (!v.ok) throw badRequest(`alias_${v.reason}`, v.reason === "unknown_canonical" ? "분류 사전에 없는 값입니다." : v.reason === "already_in_dictionary" ? "이미 사전에 있는 표현입니다." : "별칭이 너무 짧습니다.");
  const orgId = body.shareWithOrg ? await activeOrgId(userId) : null;
  if (body.shareWithOrg && !orgId) throw badRequest("no_active_org", "조직에 공유하려면 활성 조직이 필요합니다.");
  const row = await one<{ id: string }>(
    `INSERT INTO taxonomy_aliases (owner_user_id, organization_id, kind, alias, normalized_alias, canonical_name)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [orgId ? null : userId, orgId, body.kind, body.alias.trim().slice(0, 120), normalizeAlias(body.alias), v.canonicalName!],
  );
  await audit(pool(), ctx, "netintel.alias_added", "taxonomy_alias", row!.id, { kind: body.kind, scope: orgId ? "organization" : "personal" });
  return { aliasId: row!.id, canonicalName: v.canonicalName };
}

export async function deleteAlias(ctx: Ctx, id: string) {
  const userId = requireUser(ctx);
  const orgId = await activeOrgId(userId);
  const row = await one<{ id: string }>(
    `DELETE FROM taxonomy_aliases WHERE id=$1 AND (owner_user_id=$2 OR ($3::uuid IS NOT NULL AND organization_id=$3)) RETURNING id`,
    [id, userId, orgId],
  );
  if (!row) throw notFound("alias");
  return { deleted: true };
}

// ================================================================ N-011 분류 / N-016 피드백 / N-024 품질

export function taxonomy() {
  return {
    industries: INDUSTRIES.map((i) => ({ name: i.name, en: i.en, parent: i.parent ?? null })),
    regions: REGIONS.map((r) => ({ name: r.name, en: r.en, parent: r.parent ?? null })),
    roleCategories: ROLE_CATEGORIES.map((r) => ({ name: r.name, en: r.en })),
  };
}

export async function upsertCapability(ctx: Ctx, body: { name: string; category?: string | null }) {
  const userId = requireUser(ctx);
  if (!body.name?.trim()) throw badRequest("name_required");
  const name = body.name.trim().slice(0, 200);
  const row = await one<{ id: string }>(
    `INSERT INTO capabilities (owner_user_id, name, normalized_name, category) VALUES ($1,$2,$3,$4)
     ON CONFLICT (owner_user_id, normalized_name) WHERE owner_user_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name, category = COALESCE(EXCLUDED.category, capabilities.category) RETURNING id`,
    [userId, name, canonicalKey(name), body.category ?? null],
  );
  return { capabilityId: row!.id, name };
}

export async function linkCapability(ctx: Ctx, body: { contactId: string; capabilityId: string; kind?: "provides" | "needs"; confidence?: number; provenance?: "ocr" | "user" | "sync" | "ai_inferred" }) {
  const userId = requireUser(ctx);
  const owned = await one<{ id: string }>("SELECT id FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [body.contactId, userId]);
  if (!owned) throw notFound("contact");
  await pool().query(
    `INSERT INTO contact_capabilities (contact_id, capability_id, kind, confidence, provenance)
     VALUES ($1,$2,COALESCE($3::text,'provides'),COALESCE($4::numeric,0.7),COALESCE($5::text,'user'))
     ON CONFLICT (contact_id, capability_id, kind) DO UPDATE SET confidence = EXCLUDED.confidence, provenance = EXCLUDED.provenance`,
    [body.contactId, body.capabilityId, body.kind ?? null, body.confidence ?? null, body.provenance ?? null],
  );
  return { linked: true };
}

/** N-016 학습 라벨 기록. CTR 이 아니라 funnel 결과만 받는다(지침 §6). */
export async function recordFeedback(ctx: Ctx, body: { subjectType: "search_result" | "opportunity" | "referral_partner" | "intro_path"; subjectId: string; label: OutcomeLabel; scoreComponents?: Record<string, number>; note?: string }) {
  const userId = requireUser(ctx);
  if (!body.subjectId || !body.label) throw badRequest("label_required");
  await pool().query(
    `INSERT INTO recommendation_feedback (owner_user_id, subject_type, subject_id, label, score_components, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, body.subjectType, body.subjectId, body.label, JSON.stringify(body.scoreComponents ?? {}), body.note?.slice(0, 500) ?? null],
  );
  await audit(pool(), ctx, "netintel.feedback", body.subjectType, body.subjectId, { label: body.label });
  return { recorded: true };
}

/** N-024: 데이터 품질 큐 + projection 지연. 운영 1급 기능으로 다룬다. */
export async function dataQuality(ctx: Ctx) {
  const userId = requireUser(ctx);
  const [items, outbox, missing] = await Promise.all([
    q<{ kind: string; severity: string; n: number }>(
      "SELECT kind, severity, count(*)::int AS n FROM data_quality_items WHERE owner_user_id=$1 AND status='open' GROUP BY kind, severity ORDER BY n DESC",
      [userId],
    ),
    one<{ pending: number; oldest: Date | null }>("SELECT count(*)::int AS pending, min(created_at) AS oldest FROM outbox_events WHERE published_at IS NULL"),
    one<{ n: number }>(
      `SELECT count(*)::int AS n FROM contacts c LEFT JOIN contact_share_permissions sp ON sp.contact_id=c.id
        WHERE c.owner_user_id=$1 AND c.deleted_at IS NULL AND c.merged_into_id IS NULL AND sp.contact_id IS NULL`,
      [userId],
    ),
  ]);
  return {
    items: items.map((i) => ({ kind: i.kind, severity: i.severity, count: i.n })),
    projection: projectionLag(outbox?.pending ?? 0, outbox?.oldest ?? null),
    // 공유 범위를 한 번도 설정하지 않은 연락처는 기본값(path_only)으로 동작한다 — 사용자에게 알린다
    contactsWithoutSharePermission: missing?.n ?? 0,
  };
}

// ================================================================ 입력 스키마
//
// 라우트 핸들러는 얇은 어댑터다(지침 §아키텍처). 검증은 여기 모아 두고 라우트는 parse() 만 호출한다.

const SHARE = z.enum(["none", "path_only", "profile", "contact", "introduction"]);
const OUTCOME = z.enum(["intro_requested", "intro_approved", "introduced", "meeting_held", "qualified", "won", "lost", "wrong_relationship", "not_relevant", "privacy_blocked"]);

export const searchInput = z.object({
  query: z.string().min(2).max(500),
  projectId: z.string().uuid().nullish(),
  maxHops: z.number().int().min(1).max(3).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  // chip 수정 — 사용자가 고친 조건은 재파싱하지 않는다
  intentEdits: z
    .object({
      industries: z.array(z.string().max(100)).max(20).optional(),
      geographies: z.array(z.string().max(100)).max(20).optional(),
      roles: z.array(z.string().max(100)).max(20).optional(),
      capabilities: z.array(z.string().max(200)).max(20).optional(),
      mustHave: z.array(z.string().max(200)).max(20).optional(),
      niceToHave: z.array(z.string().max(200)).max(20).optional(),
      networkHopsMax: z.number().int().min(1).max(3).optional(),
      recencyDays: z.number().int().positive().nullable().optional(),
      targetTypes: z.array(z.enum(["person", "company", "organization"])).min(1).max(3).optional(),
    })
    .optional(),
});

export const pathsInput = z.object({
  targetContactId: z.string().uuid(),
  maxHops: z.number().int().min(1).max(3).optional(),
  k: z.number().int().min(1).max(10).optional(),
});

export const sharePermissionInput = z.object({
  sharePermission: SHARE.optional(),
  discoveryOptOut: z.boolean().optional(),
  orgShareOptIn: z.boolean().nullable().optional(),
  purposeScope: z.array(z.string().max(60)).max(20).optional(),
});

export const correctRelationshipInput = z.object({
  userTrust: z.number().min(0).max(1).optional(),
  relType: z.string().max(40).optional(),
  confirmed: z.boolean().optional(),
  label: OUTCOME.optional(),
});

export const activityInput = z.object({
  contactId: z.string().uuid(),
  activityType: z.enum(["one_to_one", "referral_given", "referral_received", "testimonial", "group_meeting", "introduction", "follow_up"]),
  occurredAt: z.string().datetime().optional(),
  durationMinutes: z.number().int().min(0).max(100000).nullish(),
  outcome: z.enum(["pending", "met", "qualified", "won", "lost", "declined"]).nullish(),
  note: z.string().max(1000).nullish(),
  organizationId: z.string().uuid().nullish(),
});

export const projectInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  targetRegions: z.array(z.string().max(60)).max(20).optional(),
  targetIndustries: z.array(z.string().max(60)).max(20).optional(),
  deadline: z.string().date().nullish(),
});

export const requirementInput = z.object({
  kind: z.enum(["role", "need"]),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  industry: z.string().max(60).nullish(),
  region: z.string().max(60).nullish(),
});

export const confirmRequirementsInput = z.object({ requirementIds: z.array(z.string().uuid()).min(1).max(50) });

export const opportunityInput = z.object({
  projectId: z.string().uuid().nullish(),
  requirementId: z.string().uuid().nullish(),
  targetContactId: z.string().uuid(),
  score: z.number().min(0).max(100).optional(),
  explanation: z.record(z.string(), z.unknown()).optional(),
  recommendedPath: z.array(z.unknown()).max(10).optional(),
});

export const advanceOpportunityInput = z.object({
  stage: z.enum(["detected", "qualified", "intro_requested", "introduced", "negotiating", "won", "lost", "dismissed"]),
  note: z.string().max(500).optional(),
});

export const savedSearchInput = z.object({
  name: z.string().max(120).optional(),
  query: z.string().min(2).max(500),
  intent: z.record(z.string(), z.unknown()).optional(),
  alertEnabled: z.boolean().optional(),
  alertFrequency: z.enum(["daily", "weekly", "monthly"]).optional(),
});

export const icpInput = z.object({
  name: z.string().max(120).optional(),
  industries: z.array(z.string().max(60)).max(30).optional(),
  regions: z.array(z.string().max(60)).max(30).optional(),
  roleCategories: z.array(z.string().max(60)).max(30).optional(),
  needs: z.array(z.string().max(200)).max(30).optional(),
  description: z.string().max(2000).nullish(),
});

export const evidenceInput = z.object({
  entityType: z.string().min(1).max(40),
  entityId: z.string().uuid(),
  evidenceType: z.enum(["business_card", "user_confirmed", "meeting", "interaction", "referral", "note", "company_data", "org_membership", "ai_inferred"]),
  summary: z.string().min(1).max(500),
  occurredAt: z.string().datetime().nullish(),
  confidence: z.number().min(0).max(1).optional(),
  inferred: z.boolean().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const feedbackInput = z.object({
  subjectType: z.enum(["search_result", "opportunity", "referral_partner", "intro_path"]),
  subjectId: z.string().uuid(),
  label: OUTCOME,
  scoreComponents: z.record(z.string(), z.number()).optional(),
  note: z.string().max(500).optional(),
});

export const capabilityInput = z.object({ name: z.string().min(1).max(200), category: z.string().max(60).nullish() });

export const linkCapabilityInput = z.object({
  contactId: z.string().uuid(),
  capabilityId: z.string().uuid(),
  kind: z.enum(["provides", "needs"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  provenance: z.enum(["ocr", "user", "sync", "ai_inferred"]).optional(),
});

export const roleInput = z.object({
  contactId: z.string().uuid(),
  companyName: z.string().min(1).max(160),
  title: z.string().max(160).nullish(),
  department: z.string().max(160).nullish(),
  roleType: z.string().max(40).optional(),
  roleCategory: z.string().max(60).nullish(),
  startedOn: z.string().date().nullish(),
  endedOn: z.string().date().nullish(),
  isCurrent: z.boolean().optional(),
  decidesFor: z.boolean().optional(),
});

export const endRoleInput = z.object({ endedOn: z.string().date().nullish() });

export const aliasInput = z.object({
  kind: z.enum(["industry", "region", "role", "capability"]),
  alias: z.string().min(2).max(120),
  canonicalName: z.string().min(1).max(120),
  shareWithOrg: z.boolean().optional(),
});
