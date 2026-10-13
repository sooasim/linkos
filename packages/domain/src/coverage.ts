// N-018 프로젝트 Role/Need 분해 · N-019 커버리지 매트릭스와 Network Gap.
// 지침: docs/NETWORK_INTELLIGENCE.md §11.
//
// 분해 결과는 **초안**이다. 사용자 검토 전에 요구사항으로 확정하지 않는다(AI 가 사실을 확정하지 않는다는 원칙).
// Gap 은 외부 공개 데이터를 무단 결합해 채우지 않는다 — 사용자 승인에 따른 경로만 제시한다.

import { extractNeedStatements } from "./graph";
import { findIndustries, findRegions, findRoles } from "./taxonomy";

export const REQUIREMENT_KINDS = ["role", "need"] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export interface RequirementDraft {
  kind: RequirementKind;
  /** role 이면 역할 카테고리, need 이면 짧은 제목 */
  name: string;
  description: string;
  /** 1 = 가장 급함 */
  priority: number;
  industry: string | null;
  region: string | null;
  /** 이 초안을 만든 **원문 문장**. 지어내지 않았음을 화면에서 보여줄 수 있게 보존한다 */
  sourceSentence: string;
  provenance: "rule_parsed";
}

export interface DecomposeInput {
  name: string;
  description: string;
  targetIndustries?: string[];
  targetRegions?: string[];
}

/**
 * 프로젝트 설명에서 Role/Need 초안을 뽑는다. 규칙 기반이므로 LLM 없이 동작하고,
 * LLM 분해가 schema validation 에 실패했을 때의 fallback 이기도 하다.
 *
 * Need 는 `extractNeedStatements()`(F-099)로 "필요/찾고/모집" 같은 단서가 실제로 있는 문장만 쓴다.
 * Role 은 역할 분류 사전에 걸린 문장만 쓴다. 단서가 없으면 아무것도 만들지 않는다.
 */
export function decomposeProject(input: DecomposeInput): RequirementDraft[] {
  const text = `${input.name}\n${input.description}`.trim();
  const defIndustry = input.targetIndustries?.[0] ?? null;
  const defRegion = input.targetRegions?.[0] ?? null;
  const out: RequirementDraft[] = [];
  const seen = new Set<string>();

  const sentences = text
    .split(/(?<=[.!?。])\s+|\r?\n/)
    .map((s) => s.replace(/^[-*•\s]+/, "").trim())
    .filter((s) => s.length >= 4);

  for (const s of sentences) {
    for (const role of findRoles(s)) {
      const key = `role:${role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: "role",
        name: role,
        description: s.slice(0, 300),
        priority: /(반드시|필수|시급|급함|핵심)/.test(s) ? 1 : 3,
        industry: findIndustries(s)[0] ?? defIndustry,
        region: findRegions(s)[0] ?? defRegion,
        sourceSentence: s.slice(0, 300),
        provenance: "rule_parsed",
      });
    }
  }

  for (const s of extractNeedStatements(text)) {
    const key = `need:${s.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: "need",
      name: s.slice(0, 60),
      description: s.slice(0, 300),
      priority: /(반드시|필수|시급|급함|핵심)/.test(s) ? 1 : 3,
      industry: findIndustries(s)[0] ?? defIndustry,
      region: findRegions(s)[0] ?? defRegion,
      sourceSentence: s.slice(0, 300),
      provenance: "rule_parsed",
    });
  }

  return out.sort((a, b) => a.priority - b.priority).slice(0, 20);
}

// ---------- 커버리지 ----------

export const COVERAGE_STATUSES = ["covered", "partial", "gap"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** covered 로 인정하는 기준. 점수만 높고 경로가 없으면 covered 가 아니다. */
export const COVERED_MIN_SCORE = 60;

export interface CoverageCandidate {
  resultId: string;
  /** 0..100 */
  score: number;
  disclosure: "full" | "masked" | "intro_only";
  /** 소개 경로의 촌수. 경로가 없으면 null */
  hops: number | null;
  hasPath: boolean;
  /** masked 후보는 null */
  displayName: string | null;
  maskedLabel: string | null;
}

export interface CoverageCell {
  requirementId: string;
  kind: RequirementKind;
  name: string;
  priority: number;
  status: CoverageStatus;
  candidateCount: number;
  bestScore: number;
  topCandidates: CoverageCandidate[];
  reasons: string[];
}

/**
 * 요구사항 하나의 충족도를 판정한다.
 *  covered — 점수 기준을 넘고 **닿을 수 있는** 후보가 있다.
 *  partial — 후보는 있지만 점수가 낮거나 소개 경로가 없다.
 *  gap     — 후보가 없다.
 */
export function coverageFor(req: { id: string; kind: RequirementKind; name: string; priority: number }, candidates: CoverageCandidate[]): CoverageCell {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const reachable = sorted.filter((c) => c.hasPath && c.score >= COVERED_MIN_SCORE);
  const status: CoverageStatus = reachable.length ? "covered" : sorted.length ? "partial" : "gap";
  const reasons: string[] = [];
  if (status === "covered") {
    reasons.push(`기준(${COVERED_MIN_SCORE}점)을 넘고 소개 경로가 있는 후보 ${reachable.length}명`);
    const masked = reachable.filter((c) => c.disclosure === "masked").length;
    if (masked) reasons.push(`그중 ${masked}명은 신원 비공개 — 소개 승인 후 공개됩니다`);
  } else if (status === "partial") {
    if (!sorted.some((c) => c.hasPath)) reasons.push("후보는 있으나 소개 경로를 찾지 못했습니다");
    if (best && best.score < COVERED_MIN_SCORE) reasons.push(`가장 높은 적합도 ${Math.round(best.score)}점 — 기준 ${COVERED_MIN_SCORE}점 미달`);
  } else {
    reasons.push("네트워크에서 조건을 만족하는 후보를 찾지 못했습니다");
  }
  return {
    requirementId: req.id,
    kind: req.kind,
    name: req.name,
    priority: req.priority,
    status,
    candidateCount: sorted.length,
    bestScore: best ? Math.round(best.score * 10) / 10 : 0,
    topCandidates: sorted.slice(0, 5),
    reasons,
  };
}

export interface CoverageSummary {
  total: number;
  covered: number;
  partial: number;
  gap: number;
  /** 우선순위 가중 커버리지 0..1 — priority 1 요구사항의 gap 이 더 크게 깎인다 */
  coverageRate: number;
  /** priority ≤ 2 인데 gap 인 항목. 프로젝트 진행의 실제 블로커다 */
  criticalGaps: { requirementId: string; name: string; priority: number }[];
}

export function coverageSummary(cells: CoverageCell[]): CoverageSummary {
  const weight = (p: number): number => Math.max(1, 6 - Math.max(1, Math.min(5, p))); // p1 → 5, p5 → 1
  const credit: Record<CoverageStatus, number> = { covered: 1, partial: 0.5, gap: 0 };
  const totalWeight = cells.reduce((a, c) => a + weight(c.priority), 0);
  const earned = cells.reduce((a, c) => a + weight(c.priority) * credit[c.status], 0);
  return {
    total: cells.length,
    covered: cells.filter((c) => c.status === "covered").length,
    partial: cells.filter((c) => c.status === "partial").length,
    gap: cells.filter((c) => c.status === "gap").length,
    coverageRate: totalWeight ? Math.round((earned / totalWeight) * 1000) / 1000 : 0,
    criticalGaps: cells.filter((c) => c.status === "gap" && c.priority <= 2).map((c) => ({ requirementId: c.requirementId, name: c.name, priority: c.priority })),
  };
}

// ---------- Network Gap (N-019) ----------

export const GAP_ACTIONS = ["ask_org_network", "search_wider_hops", "relax_region", "relax_industry", "recruit_partner", "external_provider"] as const;
export type GapAction = (typeof GAP_ACTIONS)[number];

export interface GapSuggestion {
  requirementId: string;
  name: string;
  action: GapAction;
  text: string;
  /** 사용자 승인이 필요한 행동인가. external_provider 는 반드시 true */
  requiresApproval: boolean;
}

const GAP_TEXT: Record<GapAction, string> = {
  ask_org_network: "같은 조직 멤버의 네트워크에 공유 동의를 요청해 탐색 범위를 넓힙니다",
  search_wider_hops: "촌수 제한을 3촌까지 넓혀 다시 탐색합니다",
  relax_region: "지역 조건을 인접 지역까지 완화해 다시 탐색합니다",
  relax_industry: "산업 조건을 상위 분류까지 완화해 다시 탐색합니다",
  recruit_partner: "이 역할을 맡을 파트너를 공개 모집합니다",
  external_provider: "계약된 외부 기업정보 provider 로 후보를 보강합니다",
};

/**
 * gap 을 메울 수 있는 다음 행동을 제시한다. 어떤 제안도 **자동 실행되지 않는다** —
 * 외부 provider 조회는 사용자 승인이 필수다(§11, §17).
 */
export function gapSuggestions(cells: CoverageCell[], context: { hopsUsed: number; hasOrgNetwork: boolean; hadRegionFilter: boolean; hadIndustryFilter: boolean }): GapSuggestion[] {
  const out: GapSuggestion[] = [];
  for (const c of cells.filter((x) => x.status === "gap" || x.status === "partial")) {
    const actions: GapAction[] = [];
    if (context.hopsUsed < 3) actions.push("search_wider_hops");
    if (context.hadRegionFilter) actions.push("relax_region");
    if (context.hadIndustryFilter) actions.push("relax_industry");
    if (context.hasOrgNetwork) actions.push("ask_org_network");
    actions.push("recruit_partner", "external_provider");
    for (const action of actions) {
      out.push({ requirementId: c.requirementId, name: c.name, action, text: GAP_TEXT[action], requiresApproval: action === "external_provider" || action === "ask_org_network" });
    }
  }
  return out;
}
