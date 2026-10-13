"use client";
import { RECO_WEIGHTS } from "@linkos/domain";

// 지침 §13: 점수를 숫자만 보여주지 않는다. 어떤 요소가 얼마나 기여했는지 보여준다.
const LABEL: Record<string, string> = {
  intentFit: "조건 충족",
  capabilityFit: "역량 적합",
  pathQuality: "소개 경로 품질",
  relationshipStrength: "관계 강도",
  industryFit: "산업 적합",
  evidenceQuality: "근거 품질",
  recency: "최근성",
  geo: "지역",
  dealHistory: "거래 이력",
  userPreference: "내 선호",
};

export function ScoreBars({ components }: { components: Record<string, number> }) {
  const rows = Object.entries(RECO_WEIGHTS)
    .map(([feature, weight]) => ({ feature, weight, value: components[feature] ?? 0, contribution: (components[feature] ?? 0) * weight }))
    .sort((a, b) => b.contribution - a.contribution);
  return (
    <div className="mt-3 rounded-2xl bg-[var(--bg-sunk)] p-3">
      <p className="label">점수 구성 — 가중치 × 값</p>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.feature} className="grid grid-cols-[7.5rem_1fr_3.5rem] items-center gap-2 text-[12.5px]">
            <span className="text-[var(--fg-mute)]">{LABEL[r.feature] ?? r.feature}</span>
            <span className="h-2 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--fg)_8%,transparent)]" role="img" aria-label={`${LABEL[r.feature] ?? r.feature} ${Math.round(r.value * 100)}점`}>
              <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.round(r.value * 100)}%` }} />
            </span>
            <span className="text-right tabular-nums text-[var(--fg-mute)]">
              {Math.round(r.value * 100)} <span className="opacity-60">×{r.weight}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11.5px] text-[var(--fg-mute)]">가중치는 초기 설명가능 모델입니다. 소개·미팅·성사 결과가 쌓이면 재조정됩니다.</p>
    </div>
  );
}
