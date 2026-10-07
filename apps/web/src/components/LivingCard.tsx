"use client";
import { CARD_MESSAGES, type Locale, fmt, toVCard } from "@linkos/domain";
import type { ResolvedCardDesign } from "@linkos/domain/cardDesign";
import { useState } from "react";
import { Glyph } from "./cardTemplates/Glyph";
import { TemplateCard } from "./cardTemplates/TemplateCard";
import { useTilt } from "./cardTemplates/useTilt";
import { Icon, type IconName } from "./Icon";

export interface CardData {
  name: string;
  company?: string | null;
  jobTitle?: string | null;
  headline?: string | null;
  bioShort?: string | null;
  keywords?: string[];
  theme?: string;
  /** F-021: server-resolved template + icons (null/absent → classic theme card) */
  design?: ResolvedCardDesign | null;
  fields?: { type: string; label?: string | null; value: string; visibility?: string }[];
  offers?: string[];
  needs?: string[];
  deep?: Record<string, any> | null;
  hiddenFields?: number;
}

const FIELD_ICON: Record<string, IconName> = { email: "mail", phone: "phone", mobile: "phone", website: "globe", address: "pin", booking: "calendar" };

function hrefFor(type: string, value: string): string | null {
  if (type === "email") return `mailto:${value}`;
  if (type === "phone" || type === "mobile") return `tel:${value.replace(/[^\d+]/g, "")}`;
  if (type === "website" || type === "booking") return /^https?:\/\//.test(value) ? value : `https://${value}`;
  if (type === "linkedin") return value.startsWith("http") ? value : `https://${value}`;
  return null;
}

/** The physical-feeling card object with pointer tilt + sheen. 3초 카드 (F-022). F-021: a chosen template renders via TemplateCard. */
export function CardFace({ card, size = "lg", interactive = true }: { card: CardData; size?: "sm" | "lg"; interactive?: boolean }) {
  if (card.design?.template) return <TemplateCard card={card} design={card.design} size={size} interactive={interactive} />;
  return <ThemeCardFace card={card} size={size} interactive={interactive} />;
}

function ThemeCardFace({ card, size, interactive }: { card: CardData; size: "sm" | "lg"; interactive: boolean }) {
  const { ref, onPointerMove, onPointerLeave } = useTilt<HTMLDivElement>(interactive);
  const theme = card.theme ?? "ink";
  const big = size === "lg";
  const design = card.design;
  return (
    <div
      ref={ref}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className={`card-object theme-${theme} grain ${big ? "aspect-[1.62/1] w-full p-6 sm:p-7" : "aspect-[1.62/1] w-full p-4"}`}
      data-testid="card-face"
    >
      <div className="sheen" />
      <div className="relative z-[2] flex h-full flex-col justify-between">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={`truncate font-medium opacity-70 ${big ? "text-[13px]" : "text-[11px]"}`}>{card.company ?? " "}</p>
          </div>
          {design?.icon ? (
            <Glyph glyph={design.icon} size={big ? 30 : 22} className="opacity-90" />
          ) : (
            <svg width={big ? 30 : 22} height={big ? 30 : 22} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0 opacity-80">
              <rect x="3" y="8" width="17" height="12" rx="3.5" fill="none" stroke="currentColor" strokeWidth="2" transform="rotate(-12 11.5 14)" />
              <rect x="12" y="12" width="17" height="12" rx="3.5" fill="currentColor" opacity=".9" transform="rotate(8 20.5 18)" />
            </svg>
          )}
        </div>
        <div>
          <h2 className={`display ${big ? "text-[44px] sm:text-[52px]" : "text-[28px]"} leading-[0.95]`}>{card.name}</h2>
          <p className={`mt-1.5 font-medium opacity-80 ${big ? "text-[15px]" : "text-[12px]"}`}>{[card.jobTitle, card.headline].filter(Boolean).join(" · ") || " "}</p>
          {card.keywords?.length ? (
            <div className={`mt-3 flex flex-wrap gap-1.5 ${big ? "" : "hidden"}`}>
              {card.keywords.slice(0, 3).map((k) => (
                <span key={k} className="inline-flex items-center gap-1 rounded-full border border-current/25 px-2.5 py-0.5 text-[12px] font-medium opacity-85">
                  {design?.keywordBadges[k] ? <Glyph glyph={design.keywordBadges[k]} size={13} /> : "#"}
                  {k}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Progressive disclosure: 3초 → 30초 → 딥 프로필 (F-022, F-023, F-024) + Action Card (F-036). */
export function LivingCard({ card, showActions = true, locale = "ko" }: { card: CardData; showActions?: boolean; locale?: Locale }) {
  const L = CARD_MESSAGES[locale];
  const [tab, setTab] = useState<"3s" | "30s" | "deep">("3s");
  const fields = card.fields ?? [];
  const saveVCard = () => {
    const f = (t: string) => fields.find((x) => x.type === t)?.value ?? null;
    const blob = new Blob([toVCard({ fullName: card.name, company: card.company, jobTitle: card.jobTitle, email: f("email"), phone: f("mobile") ?? f("phone"), website: f("website"), address: f("address") })], { type: "text/vcard" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${card.name}.vcf`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const deep = card.deep ?? {};
  const deepSections = (
    [
      ["projects", L.projects, (deep.projects ?? []).map((p: any) => (p.status ? `${p.title} · ${p.status}` : p.title))],
      ["achievements", L.achievements, deep.achievements ?? []],
      ["services", L.services, deep.services ?? []],
      ["assets", L.assets, deep.assets ?? []],
      ["network", L.network, deep.network ?? []],
      ["interests", L.interests, deep.interests ?? []],
      ["languages", L.languages, deep.languages ?? []],
      ["certifications", L.certifications, deep.certifications ?? []],
    ] as [string, string, string[]][]
  ).filter(([, , v]) => v.length);
  const glyphs = card.design;

  return (
    <div className="space-y-4">
      <CardFace card={card} />
      <div role="tablist" aria-label={L.tabDepth} className="surface flex p-1">
        {(
          [
            ["3s", L.tab3],
            ["30s", L.tab30],
            ["deep", L.tabDeep],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`flex-1 rounded-[16px] py-2.5 text-[14px] font-semibold transition ${tab === k ? "bg-[var(--fg)] text-[var(--bg)]" : "text-[var(--fg-mute)]"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "3s" && (
        <div className="space-y-2 animate-fade">
          {fields.length === 0 && <p className="text-sm text-[var(--fg-mute)]">{L.noFields}</p>}
          {fields.map((f, i) => {
            const href = hrefFor(f.type, f.value);
            const inner = (
              <>
                <span className="grid size-10 place-items-center rounded-full bg-[color-mix(in_srgb,var(--fg)_7%,transparent)]">
                  {glyphs?.fieldIcons[f.type] ? <Glyph glyph={glyphs.fieldIcons[f.type]!} size={18} /> : <Icon name={FIELD_ICON[f.type] ?? "link"} size={18} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] uppercase tracking-[0.14em] text-[var(--fg-mute)]">{f.label || f.type}</span>
                  <span className="block truncate text-[15px] font-medium">{f.value}</span>
                </span>
                {href && <Icon name="arrow" size={16} className="opacity-50" />}
              </>
            );
            return href ? (
              <a key={i} href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" className="surface flex items-center gap-3 px-3 py-2.5 transition hover:border-[var(--line-strong)]">
                {inner}
              </a>
            ) : (
              <div key={i} className="surface flex items-center gap-3 px-3 py-2.5">
                {inner}
              </div>
            );
          })}
          {card.hiddenFields ? (
            <p className="flex items-center gap-2 px-1 pt-1 text-[13px] text-[var(--fg-mute)]">
              <Icon name="lock" size={14} /> {fmt(L.hidden, { n: card.hiddenFields })}
            </p>
          ) : null}
          {showActions && (
            <button onClick={saveVCard} className="btn btn-ghost mt-2 w-full">
              <Icon name="download" size={18} /> {L.saveVcard}
            </button>
          )}
        </div>
      )}

      {tab === "30s" && (
        <div className="space-y-4 animate-fade">
          {card.bioShort && <p className="text-[16px] leading-relaxed">{card.bioShort}</p>}
          <OfferNeed offers={card.offers ?? []} needs={card.needs ?? []} locale={locale} />
        </div>
      )}

      {tab === "deep" && (
        <div className="space-y-3 animate-fade">
          {deepSections.length === 0 && <p className="text-sm text-[var(--fg-mute)]">{L.noDeep}</p>}
          {deepSections.map(([key, title, items]) => (
            <section key={key} className="surface p-4">
              <h4 className="eyebrow mb-2 flex items-center gap-1.5">
                {glyphs?.sectionIcons[key] ? <Glyph glyph={glyphs.sectionIcons[key]!} size={15} /> : null}
                {title}
              </h4>
              <ul className="space-y-1.5 text-[15px]">
                {items.map((x, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[var(--fg)] opacity-40" />
                    {x}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export function OfferNeed({ offers, needs, locale = "ko" }: { offers: string[]; needs: string[]; locale?: Locale }) {
  const L = CARD_MESSAGES[locale];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-[22px] bg-[var(--color-signal)] p-4 text-[var(--color-ink)]">
        <p className="eyebrow !text-[var(--color-ink)]/70">{L.offer}</p>
        <ul className="mt-2 space-y-1.5">
          {offers.length ? offers.map((o) => <li key={o} className="text-[15px] font-medium leading-snug">{o}</li>) : <li className="text-sm opacity-60">—</li>}
        </ul>
      </div>
      <div className="rounded-[22px] border border-[var(--line-strong)] p-4">
        <p className="eyebrow">{L.need}</p>
        <ul className="mt-2 space-y-1.5">
          {needs.length ? needs.map((n) => <li key={n} className="text-[15px] font-medium leading-snug">{n}</li>) : <li className="text-sm opacity-60">—</li>}
        </ul>
      </div>
    </div>
  );
}
