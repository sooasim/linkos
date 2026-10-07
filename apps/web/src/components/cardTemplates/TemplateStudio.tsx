"use client";
// F-021 — template step shared by the card editor ("템플릿" tab) and the full-screen gallery (/app/me/templates):
// lazy gallery + accent override within the template palette + monogram + logo icon.
import dynamic from "next/dynamic";
import { GlyphButton } from "../iconBank/GlyphButton";
import { type DesignState, withGlyph } from "./designState";
import type { GalleryProfile } from "./TemplateGallery";

const TemplateGallery = dynamic(() => import("./TemplateGallery"), {
  ssr: false,
  loading: () => (
    <p role="status" className="surface p-6 text-center text-[14px] text-[var(--fg-mute)]">
      템플릿 50종을 불러오는 중…
    </p>
  ),
});

export function TemplateStudio({ profile, state, onChange, full = false }: { profile: GalleryProfile; state: DesignState; onChange: (s: DesignState) => void; full?: boolean }) {
  const tpl = state.template;
  const accent = state.options.accent ?? tpl?.accentOptions[0] ?? null;
  const icon = state.options.icon ? (state.glyphs[state.options.icon] ?? null) : null;
  return (
    <div className="space-y-6">
      <section className="surface space-y-4 p-4" aria-labelledby="tpl-custom-h">
        <h3 id="tpl-custom-h" className="eyebrow">꾸미기{tpl ? ` · ${tpl.name.ko}` : " · 기본 테마"}</h3>
        {tpl && (
          <div>
            <span className="label" id="tpl-accent-l">포인트 컬러 (템플릿 팔레트 안에서)</span>
            <div role="radiogroup" aria-labelledby="tpl-accent-l" className="flex flex-wrap gap-2">
              {tpl.accentOptions.map((a, i) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={accent?.toUpperCase() === a.toUpperCase()}
                  aria-label={`포인트 컬러 ${i === 0 ? "기본" : i + 1} ${a}`}
                  onClick={() => onChange({ ...state, options: { ...state.options, accent: i === 0 ? undefined : a } })}
                  className={`size-10 rounded-full border border-[var(--line-strong)] ring-offset-2 ring-offset-[var(--bg-elev)] transition ${accent?.toUpperCase() === a.toUpperCase() ? "ring-2 ring-[var(--fg)]" : ""}`}
                  style={{ background: a }}
                  data-testid={`accent-${i}`}
                />
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-4">
          <label className="w-36">
            <span className="label">모노그램 · 이니셜</span>
            <input className="field" maxLength={3} placeholder={profile.name ? Array.from(profile.name.trim())[0] : "홍"} value={state.options.monogram ?? ""} onChange={(e) => onChange({ ...state, options: { ...state.options, monogram: e.target.value || undefined } })} />
          </label>
          <div>
            <span className="label">로고 아이콘</span>
            <GlyphButton label="카드 로고 아이콘" value={icon} testId="logo-icon" onChange={(g) => onChange({ ...withGlyph(state, g), options: { ...state.options, icon: g?.ref } })} />
          </div>
        </div>
      </section>
      <TemplateGallery
        profile={profile}
        full={full}
        selectedId={tpl?.id ?? null}
        onSelect={(t) => {
          // keep the accent only if the new template's palette allows it
          const keep = t && state.options.accent && t.accentOptions.some((a) => a.toUpperCase() === state.options.accent!.toUpperCase());
          onChange({ ...state, template: t, options: { ...state.options, accent: keep ? state.options.accent : undefined } });
        }}
      />
    </div>
  );
}
