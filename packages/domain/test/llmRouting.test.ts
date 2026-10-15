// LLM 모델 선택 정책 — 작업 성격별 급 + "새 모델이 나와도 가장 싼 쪽으로 자동 이동"
import { describe, expect, it } from "vitest";
import {
  LLM_FAMILIES,
  LLM_KIND_TIER,
  TIER_EFFORT,
  blendedCost,
  familiesForTier,
  llmFamilyOf,
  llmRateKey,
  pickLlmModel,
  tierForKind,
} from "../src/llmRouting";
import { DEFAULT_COST_RATES, estimateCostMicros } from "../src/plans";

describe("llmRouting — 계열 표", () => {
  it("계열은 싼 순서(haiku < sonnet < opus < fable)로 정렬돼 있다", () => {
    const byRank = [...LLM_FAMILIES].sort((a, b) => a.rank - b.rank);
    expect(byRank.map((f) => f.name)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    // rank 순서와 실제 가격 순서가 어긋나면 라우터가 비싼 쪽을 "가장 싸다"고 고른다.
    const costs = byRank.map(blendedCost);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
    expect(new Set(costs).size).toBe(costs.length); // 같은 값이 없어야 순서가 분명하다
  });

  it("모델 ID 에서 계열을 읽는다", () => {
    expect(llmFamilyOf("claude-haiku-5-5")?.name).toBe("haiku");
    expect(llmFamilyOf("claude-opus-5-5")?.name).toBe("opus");
    expect(llmFamilyOf("gpt-4")).toBeNull();
    expect(llmFamilyOf("claude-unknownfamily-9")).toBeNull();
  });
});

describe("llmRouting — 티어별 선택", () => {
  it("cheap 은 가장 싼 계열, standard 는 sonnet 이상, deep 은 opus 이상을 쓴다", () => {
    expect(pickLlmModel("cheap").family.name).toBe("haiku");
    expect(pickLlmModel("standard").family.name).toBe("sonnet");
    expect(pickLlmModel("deep").family.name).toBe("opus");
  });

  it("카탈로그가 비어 있으면 계열별 pinned 모델로 떨어진다", () => {
    expect(pickLlmModel("cheap").model).toBe("claude-haiku-5-5");
    expect(pickLlmModel("standard").model).toBe("claude-sonnet-5-5");
  });

  // 이 테스트가 사용자 요구("차후 모델이 바뀌어도 제일 싼 AI 로 자동 연결")의 핵심이다.
  it("계열에 더 새 모델이 생기면 코드 수정 없이 그 모델을 쓴다", () => {
    const catalog = { haiku: "claude-haiku-7", sonnet: "claude-sonnet-7", opus: "claude-opus-7" };
    expect(pickLlmModel("cheap", catalog).model).toBe("claude-haiku-7");
    expect(pickLlmModel("standard", catalog).model).toBe("claude-sonnet-7");
    expect(pickLlmModel("deep", catalog).model).toBe("claude-opus-7");
  });

  it("고른 모델을 쓸 수 없으면(blocked) 같은 계열의 pinned → 다음으로 비싼 계열 순으로 넘어간다", () => {
    const catalog = { haiku: "claude-haiku-7", sonnet: "claude-sonnet-7" };
    // 새 haiku 가 막히면 같은 계열의 안전한 모델로
    expect(pickLlmModel("cheap", catalog, new Set(["claude-haiku-7"])).model).toBe("claude-haiku-5-5");
    // haiku 계열이 통째로 막히면 그 다음으로 싼 계열로 올라간다
    const noHaiku = new Set(["claude-haiku-7", "claude-haiku-5-5"]);
    expect(pickLlmModel("cheap", catalog, noHaiku).family.name).toBe("sonnet");
  });

  it("모든 후보가 막혀도 모델을 하나는 돌려준다(기능이 멈추지 않는다)", () => {
    const all = new Set(LLM_FAMILIES.map((f) => f.pinned));
    expect(pickLlmModel("cheap", {}, all).model).toBeTruthy();
  });

  it("티어가 쓸 수 있는 계열은 싼 순서로 나온다", () => {
    expect(familiesForTier("standard").map((f) => f.name)).toEqual(["sonnet", "opus", "fable"]);
  });
});

describe("llmRouting — 호출 종류별 배정", () => {
  it("짧은 요약·파싱은 cheap, 사람이 읽는 글은 standard 다", () => {
    expect(tierForKind("profile_summary")).toBe("cheap");
    expect(tierForKind("schedule_hint")).toBe("cheap");
    expect(tierForKind("room_summary")).toBe("cheap");
    expect(tierForKind("followup_draft")).toBe("standard");
    expect(tierForKind("intro_draft")).toBe("standard");
    expect(tierForKind("translate")).toBe("standard");
  });

  it("모르는 kind 는 안전하게 standard 로 떨어진다", () => {
    expect(tierForKind("something_new")).toBe("standard");
  });

  it("배정된 모든 kind 는 유효한 티어를 가리킨다", () => {
    for (const tier of Object.values(LLM_KIND_TIER)) expect(TIER_EFFORT[tier]).toBeTruthy();
  });
});

describe("llmRouting — 비용 계량 (F-187)", () => {
  it("계열별 요율이 전부 등록돼 있다", () => {
    for (const f of LLM_FAMILIES) {
      expect(DEFAULT_COST_RATES[`llm.input_token.${f.name}`]).toBe(f.inputUsdPerMTok);
      expect(DEFAULT_COST_RATES[`llm.output_token.${f.name}`]).toBe(f.outputUsdPerMTok);
    }
  });

  it("싼 모델로 라우팅하면 추정 비용도 싸게 잡힌다", () => {
    const haiku = estimateCostMicros(llmRateKey("claude-haiku-5-5", "input"), 1_000_000);
    const opus = estimateCostMicros(llmRateKey("claude-opus-5-5", "input"), 1_000_000);
    expect(haiku).toBeLessThan(opus);
    expect(haiku).toBe(100_000); // $0.10 = 100,000 micro-USD
  });

  it("계열을 모르는 모델은 보수적인 기본 요율을 쓴다(0원 처리하지 않는다)", () => {
    const key = llmRateKey("some-other-provider-model", "input");
    expect(key).toBe("llm.input_token");
    expect(estimateCostMicros(key, 1_000_000)).toBeGreaterThan(0);
  });
});
