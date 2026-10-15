// LLM 모델 선택 정책 (순수 로직 — I/O 없음).
//
// 목표 두 가지를 동시에 만족시킨다.
//   1) 작업 성격에 맞는 급의 모델을 쓴다 (요약·파싱은 싼 모델, 사람이 읽을 글은 좋은 모델).
//   2) 새 모델이 나오면 **손대지 않아도 가장 싼 선택지로 자동으로 옮겨탄다.**
//
// 2번을 모델 ID 목록을 하드코딩해서 달성할 수는 없다. 대신 지금까지 세대가 바뀌어도
// 유지돼 온 두 가지 규칙에만 의존한다.
//   - 계열 간 가격 순서: haiku < sonnet < opus < fable
//   - 한 계열 안에서는 최신 모델이 (같거나) 더 싸다
//     (haiku 4.5 $1/$5 → haiku 5.5 $0.10/$0.50, opus 5 $5/$25 → opus 5.5 $4/$20)
// 그래서 라우터는 "조건을 만족하는 가장 싼 계열"을 고르고, 그 계열 안에서 실제 모델 ID 는
// Models API 가 알려주는 최신 것을 쓴다(services/api/src/lib/llmModels.ts 가 조회한다).
// 여기(도메인)에는 I/O 가 없는 정책과 표만 둔다.

export type LlmTier = "cheap" | "standard" | "deep";
export type LlmEffort = "low" | "medium" | "high";

export interface LlmFamily {
  name: string;
  /** 싼 것부터 0,1,2… — 티어의 최소 요구 급을 비교할 때 쓴다. */
  rank: number;
  /** 공개가 USD / 1M 토큰 (2026-10 기준, Anthropic 1st-party). */
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Models API 를 못 읽었을 때 쓸 안전한 기본 모델. */
  pinned: string;
}

const HAIKU: LlmFamily = { name: "haiku", rank: 0, inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5, pinned: "claude-haiku-5-5" };
const SONNET: LlmFamily = { name: "sonnet", rank: 1, inputUsdPerMTok: 2, outputUsdPerMTok: 10, pinned: "claude-sonnet-5-5" };
const OPUS: LlmFamily = { name: "opus", rank: 2, inputUsdPerMTok: 4, outputUsdPerMTok: 20, pinned: "claude-opus-5-5" };
const FABLE: LlmFamily = { name: "fable", rank: 3, inputUsdPerMTok: 10, outputUsdPerMTok: 50, pinned: "claude-fable-5-1" };

export const LLM_FAMILIES: readonly LlmFamily[] = [HAIKU, SONNET, OPUS, FABLE];

/**
 * 티어별 **최소** 계열. 라우터는 이 급 이상인 계열 중 가장 싼 것을 고른다.
 * 지금 값으로는 cheap→haiku, standard→sonnet, deep→opus 지만, 더 싼 계열이 생기면
 * 같은 규칙이 자동으로 그쪽을 고른다.
 */
export const TIER_MIN_RANK: Record<LlmTier, number> = { cheap: 0, standard: 1, deep: 2 };

/** 티어별 추론 effort. 모델이 해당 레벨을 지원하지 않으면 호출부가 낮춘다. */
export const TIER_EFFORT: Record<LlmTier, LlmEffort> = { cheap: "low", standard: "medium", deep: "high" };

/**
 * 호출 종류 → 티어. "상황에 맞게"의 실체가 이 표다.
 *
 * cheap    — 출력이 짧고 사실 추출/요약이라 싼 모델로 충분하다.
 * standard — 사용자가 그대로 읽거나 상대에게 전달되는 글, 또는 긴 입력을 정확히 다뤄야 하는 것.
 * deep     — 지금은 없다. 더 어려운 작업이 생기면 여기에 넣는다.
 */
export const LLM_KIND_TIER: Record<string, LlmTier> = {
  // 짧은 요약·파싱
  profile_summary: "cheap", // 카드 데이터 → 2문장 소개
  room_summary: "cheap", // Connection Room 현황 요약
  schedule_hint: "cheap", // "다음 주 화요일 오후" → 후보 시각
  // 사람이 읽는 글 / 정확도가 중요한 변환
  followup_draft: "standard", // 상대에게 보낼 메일 초안
  intro_draft: "standard", // 소개 메시지 초안 (동의 기반, 관계가 걸린다)
  translate: "standard", // 프로필 번역 — 오역이 그대로 명함에 박힌다
  adaptive_card: "standard", // 상대별 Living Card 구성
  meeting_extract: "standard", // 긴 전사 → 할 일/결정 추출
};

/** 등록되지 않은 kind 는 안전한 쪽(standard)으로 떨어뜨린다. */
export function tierForKind(kind: string): LlmTier {
  return LLM_KIND_TIER[kind] ?? "standard";
}

/** 모델 ID 에서 계열을 뽑는다. 모르는 모델이면 null (라우팅 후보에서 제외된다). */
export function llmFamilyOf(modelId: string): LlmFamily | null {
  const m = /^claude-([a-z]+)-/.exec(modelId);
  if (!m) return null;
  return LLM_FAMILIES.find((f) => f.name === m[1]) ?? null;
}

/**
 * 티어가 쓸 수 있는 계열을 **싼 순서로** 돌려준다.
 * 첫 번째가 1순위이고, 그 계열에 쓸 수 있는 모델이 없으면 다음으로 넘어간다.
 */
export function familiesForTier(tier: LlmTier): LlmFamily[] {
  const min = TIER_MIN_RANK[tier];
  return LLM_FAMILIES.filter((f) => f.rank >= min).sort(
    (a, b) => blendedCost(a) - blendedCost(b) || a.rank - b.rank,
  );
}

/**
 * 계열 비교용 단가. LINKOS 의 LLM 호출은 입력이 길고(명함·전사·노트) 출력은 구조화 JSON 이라
 * 짧다 — 대략 4:1 로 보고 가중 평균한다. 계열 간 순서를 정하는 용도라 정밀할 필요는 없다.
 */
export function blendedCost(f: LlmFamily): number {
  return (f.inputUsdPerMTok * 4 + f.outputUsdPerMTok) / 5;
}

/**
 * 순수 선택 함수. `newestByFamily` 는 Models API 로 찾은 계열별 최신 모델 ID
 * (없으면 pinned 로 떨어진다), `blocked` 는 API 가 거부해서 쓰면 안 되는 ID.
 */
export function pickLlmModel(
  tier: LlmTier,
  newestByFamily: Readonly<Record<string, string | undefined>> = {},
  blocked: ReadonlySet<string> = new Set(),
): { model: string; family: LlmFamily } {
  const families = familiesForTier(tier);
  for (const f of families) {
    const candidate = newestByFamily[f.name];
    if (candidate && !blocked.has(candidate)) return { model: candidate, family: f };
    if (!blocked.has(f.pinned)) return { model: f.pinned, family: f };
  }
  // 모든 후보가 막힌 극단적인 경우. 여기까지 오면 어느 쪽을 골라도 실패할 가능성이 높지만,
  // 호출부가 모델 없이 진행할 수는 없으므로 가장 검증된 기본값을 돌려준다.
  return { model: OPUS.pinned, family: OPUS };
}

/**
 * F-187 비용 계량용 rateKey. 계열마다 단가가 50배까지 차이 나서 하나의 평균값으로는
 * 싼 모델로 라우팅한 효과가 보고서에 드러나지 않는다.
 */
export function llmRateKey(modelId: string, io: "input" | "output"): string {
  const f = llmFamilyOf(modelId);
  return f ? `llm.${io}_token.${f.name}` : `llm.${io}_token`;
}
