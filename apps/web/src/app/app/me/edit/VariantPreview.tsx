"use client";
// F-031 상대별 보기 미리보기 — GET /profiles/{id}/variant?audience=… 로 저장된 변형을 고르고,
// F-034 필드 ACL(public < business < trusted < partner)을 filterFieldsByAudience 로 적용해 상대가 보게 될 카드를 그대로 그린다.
import { type Audience, filterFieldsByAudience, hiddenFieldCount } from "@linkos/domain";
import { useEffect, useState } from "react";
import { CardFace, type CardData } from "@/components/LivingCard";
import { api } from "@/lib/client";

type Vis = "public" | "business" | "trusted" | "partner" | "private";
type Field = { type: string; label?: string | null; value: string; visibility: Vis };
interface VariantResult {
  audience: string | null;
  reason: "explicit" | "event" | "industry" | "title" | "default" | "none" | string;
  content: { headline?: string; bioShort?: string } | null;
  highlights: string[];
}

const AUDIENCES = [
  ["investor", "투자자"],
  ["customer", "고객"],
  ["partner", "파트너"],
  ["recruiting", "채용"],
] as const;
const LEVELS: [Exclude<Audience, "owner">, string, string][] = [
  ["public", "공개", "링크만 받은 사람"],
  ["business", "비즈니스", "교환한 상대(기본)"],
  ["trusted", "신뢰", "승인한 사람"],
  ["partner", "파트너", "파트너로 지정한 사람"],
];
const FIELD_LABEL: Record<string, string> = { email: "이메일", mobile: "휴대폰", phone: "전화", website: "웹사이트", address: "주소", linkedin: "LinkedIn", booking: "예약 링크", kakao: "카카오톡", other: "기타" };
const REASON: Record<string, string> = {
  explicit: "이 상대용 변형이 적용돼요",
  default: "이 상대용 변형이 없어 기본 변형이 적용돼요",
  none: "저장된 변형이 없어 기본 카드가 보여요",
};

export function VariantPreview({ profileId, card, fields, dirty }: { profileId: string; card: CardData; fields: Field[]; dirty: boolean }) {
  const [audience, setAudience] = useState<string>("investor");
  const [level, setLevel] = useState<Exclude<Audience, "owner">>("business");
  const [res, setRes] = useState<VariantResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setErr(null);
    api<VariantResult>(`/profiles/${profileId}/variant?audience=${encodeURIComponent(audience)}`)
      .then((r) => live && setRes(r))
      .catch((e) => live && (setRes(null), setErr((e as Error).message)));
    return () => {
      live = false;
    };
  }, [profileId, audience]);

  const filled = fields.filter((f) => f.value.trim());
  const visible = filterFieldsByAudience(filled, level);
  const offers = card.offers ?? [];
  const order = res?.highlights ?? [];
  const orderedOffers = order.length ? [...order.filter((h) => offers.includes(h)), ...offers.filter((o) => !order.includes(o))] : offers;
  const preview: CardData = {
    ...card,
    headline: res?.content?.headline || card.headline,
    bioShort: res?.content?.bioShort || card.bioShort,
    fields: visible,
    offers: orderedOffers,
    hiddenFields: hiddenFieldCount(filled, level),
  };
  const audienceLabel = AUDIENCES.find(([a]) => a === audience)?.[1] ?? audience;

  return (
    <section className="space-y-3" aria-labelledby="variant-preview-title" data-testid="variant-preview">
      <h2 id="variant-preview-title" className="eyebrow">상대별 보기 미리보기</h2>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="미리볼 상대">
        {AUDIENCES.map(([a, l]) => (
          <button key={a} type="button" role="radio" aria-checked={audience === a} onClick={() => setAudience(a)} className={`chip ${audience === a ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
            {l}
          </button>
        ))}
      </div>
      <label className="block text-[13px]">
        <span className="label">상대의 공개범위 단계</span>
        <select className="field !min-h-10 !py-1.5 !text-[14px]" value={level} onChange={(e) => setLevel(e.target.value as Exclude<Audience, "owner">)}>
          {LEVELS.map(([v, l, hint]) => <option key={v} value={v}>{l} · {hint}</option>)}
        </select>
      </label>
      <CardFace card={preview} size="sm" interactive={false} />
      <ul className="space-y-1 text-[13px]" aria-label="이 상대에게 보이는 연락처">
        {visible.map((f, i) => (
          <li key={`${f.type}-${i}`} className="flex gap-2">
            <span className="w-16 shrink-0 text-[var(--fg-mute)]">{FIELD_LABEL[f.type] ?? f.label ?? f.type}</span>
            <span className="min-w-0 truncate">{f.value}</span>
          </li>
        ))}
        {visible.length === 0 && <li className="text-[var(--fg-mute)]">이 단계에서는 연락처가 보이지 않아요.</li>}
      </ul>
      <p className="text-[12.5px] text-[var(--fg-mute)]" role="status">
        {err ? <span className="text-[var(--color-ember)]">미리보기를 불러오지 못했어요: {err}</span> : res ? `${audienceLabel}: ${REASON[res.reason] ?? "기본 카드가 보여요"}` : "불러오는 중…"}
        {" · "}연락처 {visible.length}개 표시{preview.hiddenFields ? ` · ${preview.hiddenFields}개 숨김` : ""}
      </p>
      {dirty && <p className="text-[12px] text-[var(--fg-mute)]">변형 문구는 저장된 내용 기준이에요. 방금 고친 한 줄은 저장 후 반영됩니다.</p>}
    </section>
  );
}
