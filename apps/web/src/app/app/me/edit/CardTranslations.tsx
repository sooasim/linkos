"use client";
// F-112 카드 번역 — "번역본 만들기" (en/ja). The /translate API returns a machine (AI) translation of the SAVED card's
// descriptive text; the owner reviews/edits every line here before it is attached to the card (saved with "저장").
// Names, company, e-mail, phone and other contact fields are never translated (shown locked for clarity).
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel } from "@/components/Page";
import { api } from "@/lib/client";
import { CARD_TRANSLATION_LANGS, type CardTranslation, type CardTranslationLang, type CardTranslations, TRANSLATABLE_FIELDS, type TranslatedText, availableTranslations, draftFromApi } from "@/lib/cardTranslation";

const LANG_LABEL: Record<CardTranslationLang, string> = { en: "영어 (English)", ja: "일본어 (日本語)" };
const FIELD_LABEL: Record<(typeof TRANSLATABLE_FIELDS)[number], string> = { jobTitle: "직책", headline: "한 줄 소개", bioShort: "소개" };

interface Source {
  name: string;
  company: string | null;
  jobTitle: string | null;
  headline: string | null;
  bioShort: string | null;
  offers: string[];
  needs: string[];
  contactCount: number;
}

interface Review {
  lang: CardTranslationLang;
  draft: Pick<CardTranslation, "fields" | "offers" | "needs">;
  translated: boolean;
  model: string | null;
  notice: string;
}

function Row({ label, src, value, onChange, multiline }: { label: string; src: string; value: string; onChange: (v: string) => void; multiline?: boolean }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <span className="mb-1 block text-[12.5px] text-[var(--fg-mute)]">원문 · {src}</span>
      {multiline ? (
        <textarea className="field min-h-20" value={value} maxLength={400} onChange={(e) => onChange(e.target.value)} aria-label={`${label} 번역`} />
      ) : (
        <input className="field" value={value} maxLength={200} onChange={(e) => onChange(e.target.value)} aria-label={`${label} 번역`} />
      )}
    </label>
  );
}

export function CardTranslations({ profileId, source, dirty, value, onChange }: { profileId: string | null; source: Source; dirty: boolean; value: CardTranslations; onChange: (v: CardTranslations) => void }) {
  const [busy, setBusy] = useState<CardTranslationLang | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const have = availableTranslations(value);

  const make = async (lang: CardTranslationLang) => {
    if (!profileId) return;
    setBusy(lang);
    setError(null);
    try {
      const r = await api<{ items: Record<string, string>; translated: boolean; model: string | null; notice: string }>("/translate", { body: { target: lang, profileId } });
      setReview({ lang, draft: draftFromApi(source, r.items), translated: r.translated, model: r.model, notice: r.notice });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const edit = (lang: CardTranslationLang) => {
    const t = value[lang];
    if (t) setReview({ lang, draft: { fields: t.fields, offers: t.offers, needs: t.needs }, translated: t.provenance === "ai_inferred", model: t.model ?? null, notice: "" });
  };

  const apply = () => {
    if (!review) return;
    const clean = (xs: TranslatedText[]) => xs.filter((x) => x.text.trim()).map((x) => ({ src: x.src, text: x.text.trim() }));
    const fields = Object.fromEntries(Object.entries(review.draft.fields).filter(([, x]) => x && x.text.trim()).map(([k, x]) => [k, { src: x!.src, text: x!.text.trim() }]));
    onChange({
      ...value,
      [review.lang]: { fields, offers: clean(review.draft.offers), needs: clean(review.draft.needs), provenance: review.translated ? "ai_inferred" : "user", model: review.model, reviewedAt: new Date().toISOString() } satisfies CardTranslation,
    });
    setReview(null);
  };

  const remove = (lang: CardTranslationLang) => {
    const next = { ...value };
    delete next[lang];
    onChange(next);
  };

  const setField = (k: (typeof TRANSLATABLE_FIELDS)[number], text: string) =>
    setReview((r) => (r ? { ...r, draft: { ...r.draft, fields: { ...r.draft.fields, [k]: { src: r.draft.fields[k]!.src, text } } } } : r));
  const setList = (key: "offers" | "needs", i: number, text: string) =>
    setReview((r) => (r ? { ...r, draft: { ...r.draft, [key]: r.draft[key].map((x, j) => (j === i ? { ...x, text } : x)) } } : r));

  return (
    <section className="space-y-3" aria-labelledby="card-translations-title" data-testid="card-translations">
      <h2 id="card-translations-title" className="eyebrow">번역본 · 해외 상대용</h2>
      <p className="text-[13.5px] text-[var(--fg-mute)]">직책·소개·Offer/Need만 번역해요. 이름·회사·이메일·전화는 번역하지 않고 원문 그대로 보여줍니다. 번역은 AI가 만들고, 확인한 내용만 카드에 붙어요.</p>

      {have.length > 0 && (
        <ul className="space-y-2">
          {have.map((l) => (
            <li key={l} className="surface flex flex-wrap items-center gap-2 p-3 text-[14px]" data-testid={`translation-${l}`}>
              <span className="font-semibold">{LANG_LABEL[l]}</span>
              {value[l]!.provenance === "ai_inferred" ? <AiLabel>AI 번역 · 검토함</AiLabel> : <span className="chip">직접 입력</span>}
              <span className="ml-auto flex gap-2">
                <button type="button" className="btn btn-ghost !min-h-9 !px-3 text-[13px]" onClick={() => edit(l)}>검토·수정</button>
                <button type="button" className="btn btn-ghost !min-h-9 !px-3 text-[13px]" aria-label={`${LANG_LABEL[l]} 번역본 삭제`} onClick={() => remove(l)}><Icon name="trash" size={15} /></button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {!profileId ? (
        <p className="text-[13px] text-[var(--fg-mute)]">카드를 먼저 저장하면 번역본을 만들 수 있어요.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {CARD_TRANSLATION_LANGS.map((l) => (
            <button key={l} type="button" className="btn btn-ghost !min-h-10 text-[14px]" disabled={busy !== null} onClick={() => make(l)} data-testid={`translate-${l}`}>
              <Icon name="globe" size={16} /> {busy === l ? "번역 중…" : `${LANG_LABEL[l]} 번역본 만들기`}
            </button>
          ))}
        </div>
      )}
      {dirty && profileId && <p className="text-[12.5px] text-[var(--fg-mute)]">저장된 카드 내용을 번역해요. 방금 고친 내용은 저장한 뒤 다시 번역하세요.</p>}
      {error && <p role="alert" className="text-[13.5px] text-[var(--color-ember)]">{error}</p>}

      {review && (
        <div className="surface space-y-4 p-4" role="region" aria-label={`${LANG_LABEL[review.lang]} 번역 검토`} data-testid="translation-review">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[15px] font-semibold">{LANG_LABEL[review.lang]} 번역 검토</p>
            {review.translated ? <AiLabel>AI 번역 · 확인 필요</AiLabel> : <span className="chip">번역 불가 · 원문</span>}
          </div>
          {review.notice && <p className="text-[13px] text-[var(--fg-mute)]" role="status">{review.notice}</p>}

          <dl className="grid gap-2 rounded-2xl bg-[var(--bg-sunk)] p-3 text-[13.5px] sm:grid-cols-2" aria-label="번역하지 않는 항목">
            {[["이름", source.name], ["회사", source.company ?? "—"]].map(([k, v]) => (
              <div key={k} className="flex items-center gap-1.5">
                <Icon name="lock" size={13} className="shrink-0 text-[var(--fg-mute)]" />
                <dt className="text-[var(--fg-mute)]">{k}</dt>
                <dd className="font-medium" data-testid={k === "이름" ? "locked-name" : undefined}>{v}</dd>
              </div>
            ))}
            <p className="text-[12px] text-[var(--fg-mute)] sm:col-span-2">이름·회사·연락처 {source.contactCount}개 항목은 번역하지 않아요.</p>
          </dl>

          {TRANSLATABLE_FIELDS.map((k) => {
            const x = review.draft.fields[k];
            return x ? <Row key={k} label={FIELD_LABEL[k]} src={x.src} value={x.text} multiline={k === "bioShort"} onChange={(v) => setField(k, v)} /> : null;
          })}
          {(["offers", "needs"] as const).map((key) =>
            review.draft[key].map((x, i) => <Row key={`${key}-${i}`} label={`${key === "offers" ? "Offer" : "Need"} ${i + 1}`} src={x.src} value={x.text} onChange={(v) => setList(key, i, v)} />),
          )}
          {Object.keys(review.draft.fields).length === 0 && review.draft.offers.length === 0 && review.draft.needs.length === 0 && (
            <p className="text-[13.5px] text-[var(--fg-mute)]">번역할 직책·소개·Offer/Need가 아직 없어요.</p>
          )}

          <div className="flex gap-2">
            <button type="button" className="btn btn-signal" onClick={apply} data-testid="translation-apply">확인하고 번역본 추가</button>
            <button type="button" className="btn btn-ghost" onClick={() => setReview(null)}>취소</button>
          </div>
          <p className="text-[12px] text-[var(--fg-mute)]">추가한 번역본은 아래 “저장”을 눌러야 카드에 반영돼요.</p>
        </div>
      )}
    </section>
  );
}
