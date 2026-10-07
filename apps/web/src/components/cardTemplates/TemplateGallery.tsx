"use client";
// X-008 — template gallery: category chips, ko/en search, "추천 템플릿" (suggestTemplates), live mini previews of the
// user's own card. Loaded with next/dynamic (it imports the 50-template catalog) and previews mount lazily when
// scrolled into view, so 50 cards stay fast.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedCardDesign } from "@linkos/domain/cardDesign";
import { type CardTemplate, CARD_TEMPLATES, TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_LABEL, type TemplateCategory, searchTemplates, suggestTemplates } from "@linkos/domain/cardTemplates";
import { Icon } from "../Icon";
import { TemplateCard, type TemplateCardData } from "./TemplateCard";

export interface GalleryProfile extends TemplateCardData {
  industries?: string[];
  bioShort?: string | null;
}

function LazyMount({ children, minHeight }: { children: React.ReactNode; minHeight: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ minHeight: shown ? undefined : minHeight }} className="tc-lazy">
      {shown ? children : <div aria-hidden className="h-full w-full rounded-[14px] bg-[var(--bg-sunk)]" style={{ minHeight }} />}
    </div>
  );
}

const plainDesign = (template: CardTemplate): ResolvedCardDesign => ({ template, accent: null, monogram: null, icon: null, fieldIcons: {}, keywordBadges: {}, sectionIcons: {} });

function Tile({ tpl, card, selected, onSelect, testPrefix = "template" }: { tpl: CardTemplate; card: TemplateCardData; selected: boolean; onSelect: (t: CardTemplate) => void; testPrefix?: string }) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${tpl.name.ko} (${tpl.name.en}) · ${TEMPLATE_CATEGORY_LABEL[tpl.category].ko}`}
        onClick={() => onSelect(tpl)}
        data-testid={`${testPrefix}-${tpl.id}`}
        className={`group block w-full rounded-[18px] p-2 text-left transition hover:bg-[var(--bg-sunk)] ${selected ? "bg-[var(--accent-soft)] ring-2 ring-[var(--accent)]" : ""}`}
      >
        <LazyMount minHeight={tpl.orientation === "portrait" ? 150 : 96}>
          <TemplateCard card={card} design={plainDesign(tpl)} size="sm" interactive={false} preview />
        </LazyMount>
        <span className="mt-2 flex items-center justify-between gap-2 px-1">
          <span className="min-w-0 truncate text-[13.5px] font-semibold">{tpl.name.ko}</span>
          {selected ? <Icon name="check" size={16} className="shrink-0 text-[var(--accent-text)]" /> : <span className="shrink-0 text-[11.5px] text-[var(--fg-mute)]">{TEMPLATE_CATEGORY_LABEL[tpl.category].ko}</span>}
        </span>
      </button>
    </li>
  );
}

export default function TemplateGallery({ profile, selectedId, onSelect, full = false }: { profile: GalleryProfile; selectedId: string | null; onSelect: (t: CardTemplate | null) => void; full?: boolean }) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<TemplateCategory | null>(null);
  const card: TemplateCardData = {
    name: profile.name || "홍길동",
    company: profile.company || "LINKOS",
    jobTitle: profile.jobTitle || "대표",
    headline: profile.headline,
    keywords: profile.keywords,
    fields: profile.fields?.length ? profile.fields : [{ type: "email", value: "hello@linkos.app" }, { type: "mobile", value: "010-0000-0000" }],
  };
  const suggestions = useMemo(
    () => suggestTemplates({ industries: profile.industries, keywords: profile.keywords, jobTitle: profile.jobTitle, headline: profile.headline, company: profile.company, bioShort: profile.bioShort }, 6),
    [profile.industries, profile.keywords, profile.jobTitle, profile.headline, profile.company, profile.bioShort],
  );
  const list = useMemo(() => searchTemplates(query, cat), [query, cat]);
  const grid = full ? "grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]" : "grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]";

  return (
    <div className="space-y-4" data-testid="template-gallery">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <span className="sr-only">템플릿 검색</span>
          <Icon name="search" size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--fg-mute)]" />
          <input className="field !pl-10" type="search" placeholder="스타일·업종 검색 (예: 골드, 법률, minimal)" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button type="button" className={`btn btn-ghost shrink-0 ${selectedId === null ? "ring-2 ring-[var(--accent)]" : ""}`} aria-pressed={selectedId === null} onClick={() => onSelect(null)} data-testid="template-none">
          기본 테마 사용
        </button>
      </div>
      <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="템플릿 카테고리">
        <button type="button" aria-pressed={cat === null} onClick={() => setCat(null)} className={`chip shrink-0 ${cat === null ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
          전체 {CARD_TEMPLATES.length}
        </button>
        {TEMPLATE_CATEGORIES.map((c) => (
          <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(cat === c ? null : c)} className={`chip shrink-0 ${cat === c ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
            {TEMPLATE_CATEGORY_LABEL[c].ko}
          </button>
        ))}
      </div>

      {!query && !cat && (
        <section aria-labelledby="tpl-rec-h" className="space-y-2">
          <h3 id="tpl-rec-h" className="eyebrow flex items-center gap-1.5">
            <Icon name="spark" size={14} /> 추천 템플릿
          </h3>
          <p className="text-[12.5px] text-[var(--fg-mute)]">{suggestions[0]?.score ? "산업·키워드·직책을 바탕으로 골랐어요 (규칙 기반)." : "프로필에 산업이나 키워드를 넣으면 더 잘 맞는 템플릿을 추천해요."}</p>
          <ul className={`grid gap-2 ${grid}`} data-testid="template-suggestions">
            {suggestions.map((s) => (
              <Tile key={s.template.id} tpl={s.template} card={card} selected={selectedId === s.template.id} onSelect={onSelect} testPrefix="suggested" />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="tpl-all-h" className="space-y-2">
        <h3 id="tpl-all-h" className="eyebrow">{cat ? TEMPLATE_CATEGORY_LABEL[cat].ko : "모든 템플릿"} · {list.length}</h3>
        {list.length === 0 ? (
          <p role="status" className="text-[14px] text-[var(--fg-mute)]">‘{query}’에 맞는 템플릿이 없어요.</p>
        ) : (
          <ul className={`grid gap-2 ${grid}`}>
            {list.map((tpl) => (
              <Tile key={tpl.id} tpl={tpl} card={card} selected={selectedId === tpl.id} onSelect={onSelect} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
