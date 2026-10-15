// Models API 로 "지금 쓸 수 있는 모델"을 찾아 계열별 최신 모델을 캐시한다.
// 선택 규칙 자체는 packages/domain/src/llmRouting.ts (순수 로직) 에 있다.
//
// 왜 조회하나: 모델 ID 를 코드에 박아 두면 더 싸고 좋은 모델이 나와도 배포를 해야 바뀐다.
// 계열별 최신 모델을 런타임에 확인하면, 새 모델이 공개된 다음 날 캐시가 만료되는 순간
// 자동으로 그쪽으로 옮겨탄다. 조회가 실패하면 계열별 pinned 모델로 조용히 되돌아간다.
import type Anthropic from "@anthropic-ai/sdk";
import { LLM_FAMILIES, type LlmEffort, type LlmTier, TIER_EFFORT, llmFamilyOf, pickLlmModel } from "@linkos/domain";
import { log } from "./platform";

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/** 계열 → 그 계열의 최신 모델 ID. */
let newestByFamily: Record<string, string | undefined> = {};
/** 모델별 지원 effort 레벨. Models API 가 안 알려주면 비워 두고 요청한 레벨을 그대로 쓴다. */
let effortLevels: Record<string, Set<string>> = {};
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;

/**
 * 카탈로그에서 뺄 모델. 새 모델이 목록에는 보이지만 이 API 키로는 못 쓰는 경우
 * (권한·리전·접근 프로그램) 400/404 가 나는데, 그때 호출부가 여기에 등록하고 다음 계열로 넘어간다.
 */
const blocked = new Set<string>();

export function blockLlmModel(modelId: string): void {
  if (!blocked.has(modelId)) {
    blocked.add(modelId);
    log("warn", "llm.model_blocked", { model: modelId });
  }
}

/** 테스트·운영 점검용. */
export function llmCatalogSnapshot(): { newestByFamily: Record<string, string | undefined>; fetchedAt: number; blocked: string[] } {
  return { newestByFamily: { ...newestByFamily }, fetchedAt, blocked: [...blocked] };
}

export function resetLlmCatalog(): void {
  newestByFamily = {};
  effortLevels = {};
  fetchedAt = 0;
  inFlight = null;
  blocked.clear();
}

async function refresh(client: Anthropic): Promise<void> {
  const newest: Record<string, { id: string; at: number }> = {};
  const levels: Record<string, Set<string>> = {};
  for await (const m of client.models.list({ limit: 100 })) {
    const family = llmFamilyOf(m.id);
    if (!family || blocked.has(m.id)) continue;
    // 모든 호출이 structured outputs 를 쓴다. 지원하지 않는 모델은 후보가 아니다.
    // capabilities 가 null 이면(구버전 응답) 판단하지 않고 후보로 둔다.
    if (m.capabilities && !m.capabilities.structured_outputs.supported) continue;
    const at = Date.parse(m.created_at);
    const prev = newest[family.name];
    if (!prev || (Number.isFinite(at) && at > prev.at)) newest[family.name] = { id: m.id, at: Number.isFinite(at) ? at : 0 };
    if (m.capabilities?.effort?.supported) {
      const e = m.capabilities.effort;
      const s = new Set<string>();
      for (const lvl of ["low", "medium", "high", "xhigh", "max"] as const) {
        if (e[lvl]?.supported) s.add(lvl);
      }
      levels[m.id] = s;
    }
  }
  newestByFamily = Object.fromEntries(Object.entries(newest).map(([k, v]) => [k, v.id]));
  effortLevels = levels;
  fetchedAt = Date.now();
  log("info", "llm.catalog_refreshed", { models: newestByFamily });
}

/** 캐시가 신선하면 아무것도 하지 않는다. 실패는 삼킨다 — pinned 로 돌아가면 되고, 기능이 멈추면 안 된다. */
async function ensureCatalog(client: Anthropic): Promise<void> {
  if (Date.now() - fetchedAt < CATALOG_TTL_MS && Object.keys(newestByFamily).length > 0) return;
  if (!inFlight) {
    inFlight = refresh(client)
      .catch((e) => {
        // 계속 실패하는 동안 매 호출마다 재시도하지 않도록 타임스탬프는 갱신한다.
        fetchedAt = Date.now();
        log("warn", "llm.catalog_failed", { error: (e as Error).message });
      })
      .finally(() => {
        inFlight = null;
      });
  }
  await inFlight;
}

export interface LlmChoice {
  model: string;
  effort: LlmEffort;
  /** 왜 이 모델이 뽑혔는지 — ai_runs / 로그에 남겨 추적할 수 있게 한다. */
  tier: LlmTier;
}

/**
 * 티어에 맞는 **가장 싼** 모델과 effort 를 고른다.
 *
 * 환경변수로 덮어쓸 수 있다(운영 중 긴급 고정용):
 *   LLM_MODEL              — 전부 이 모델로 고정
 *   LLM_MODEL_CHEAP / _STANDARD / _DEEP — 티어별 고정
 */
export async function chooseModel(client: Anthropic, tier: LlmTier): Promise<LlmChoice> {
  const wanted = TIER_EFFORT[tier];
  const override = process.env.LLM_MODEL || process.env[`LLM_MODEL_${tier.toUpperCase()}`];
  if (override) return { model: override, effort: downgradeEffort(override, wanted), tier };

  await ensureCatalog(client);
  const { model } = pickLlmModel(tier, newestByFamily, blocked);
  return { model, effort: downgradeEffort(model, wanted), tier };
}

/**
 * 모델이 요청한 effort 레벨을 지원하지 않으면 지원하는 가장 가까운 아래 레벨로 낮춘다.
 * (지원하지 않는 레벨을 보내면 400 이다. 모르는 모델이면 그대로 보낸다 — 서버가 판단한다.)
 */
function downgradeEffort(modelId: string, wanted: LlmEffort): LlmEffort {
  const levels = effortLevels[modelId];
  if (!levels || levels.size === 0 || levels.has(wanted)) return wanted;
  const order: LlmEffort[] = ["high", "medium", "low"];
  for (const lvl of order.slice(order.indexOf(wanted) + 1)) {
    if (levels.has(lvl)) return lvl;
  }
  return "low";
}

/**
 * 운영 점검(/api/v1/health)용 — 티어별로 "지금 뽑히는" 모델. 캐시만 읽고 네트워크를 타지 않는다.
 * 카탈로그를 아직 안 읽었으면 pinned 기본값이 보인다.
 */
export function llmActiveModels(): Record<LlmTier, string> {
  const tiers: LlmTier[] = ["cheap", "standard", "deep"];
  return Object.fromEntries(
    tiers.map((t) => {
      const override = process.env.LLM_MODEL || process.env[`LLM_MODEL_${t.toUpperCase()}`];
      return [t, override || pickLlmModel(t, newestByFamily, blocked).model];
    }),
  ) as Record<LlmTier, string>;
}
