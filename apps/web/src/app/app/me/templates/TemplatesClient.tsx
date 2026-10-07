"use client";
// X-008 full-screen gallery: pick → instant preview → 적용 (PUT /profiles/{id}/template, Idempotency-Key via api())
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CardTemplateOptions } from "@linkos/domain/cardDesign";
import { cleanOptions, designFromState, initialDesignState } from "@/components/cardTemplates/designState";
import { TemplateStudio } from "@/components/cardTemplates/TemplateStudio";
import { Icon } from "@/components/Icon";
import { type CardData, CardFace } from "@/components/LivingCard";
import { api } from "@/lib/client";

export function TemplatesClient({ profileId, version, options, card }: { profileId: string; version: number; options: CardTemplateOptions; card: CardData & { industries?: string[] } }) {
  const router = useRouter();
  const [state, setState] = useState(() => initialDesignState(card.design, options));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const design = designFromState(state);
  const preview: CardData = { ...card, design };

  const apply = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api(`/profiles/${profileId}/template`, { method: "PUT", body: { templateId: state.template?.id ?? null, templateOptions: cleanOptions(state, card.keywords ?? []), version }, offline: false });
      setMsg({ ok: true, text: "적용했어요. 이제 교환하는 상대에게 이 디자인으로 보여요." });
      router.push("/app/me");
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6">
      <div className="order-2">
        <TemplateStudio profile={{ ...card, keywords: card.keywords ?? [], industries: card.industries ?? [] }} state={state} onChange={setState} full />
      </div>
      <aside className="order-1 sm:sticky sm:top-4 sm:z-10 sm:-mx-2 sm:rounded-[28px] sm:bg-[var(--glass)] sm:p-3 sm:backdrop-blur-xl" aria-label="미리보기">
        <div className="mx-auto max-w-md">
        <p className="eyebrow mb-3">미리보기 · 상대에게 보이는 모습</p>
        <CardFace card={preview} />
        <p className="mt-3 text-[13px] text-[var(--fg-mute)]" aria-live="polite" data-testid="template-current">
          {state.template ? `${state.template.name.ko} · ${state.template.name.en}` : "기본 테마"}
        </p>
        </div>
      </aside>
      <div className="order-3 fixed inset-x-0 bottom-24 z-30 px-5 lg:static lg:px-0">
        <div className="mx-auto max-w-3xl lg:mx-0">
          {msg && (
            <p role={msg.ok ? "status" : "alert"} className={`mb-2 rounded-2xl px-4 py-2 text-[14px] ${msg.ok ? "bg-[var(--accent-soft)]" : "bg-[var(--color-ember)]/10 text-[var(--color-ember)]"}`}>
              {msg.text}
            </p>
          )}
          <button type="button" onClick={apply} disabled={saving} className="btn btn-signal btn-lg w-full shadow-2xl lg:w-auto" data-testid="apply-template">
            <Icon name="check" size={18} /> {saving ? "적용 중…" : "이 디자인 적용"}
          </button>
        </div>
      </div>
    </div>
  );
}
