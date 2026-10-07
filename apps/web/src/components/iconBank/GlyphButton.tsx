"use client";
// F-021 / F-036 — small trigger that opens the (lazy) IconPicker. Only this button ships with the editor;
// the picker and its icon/emoji banks load on first open.
import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import type { ResolvedGlyph } from "@linkos/domain/cardDesign";
import { Glyph } from "../cardTemplates/Glyph";
import { Icon } from "../Icon";

const IconPicker = dynamic(() => import("./IconPicker"), { ssr: false });

export function GlyphButton({ label, value, onChange, allowEmoji = true, compact = false, testId }: { label: string; value: ResolvedGlyph | null; onChange: (g: ResolvedGlyph | null) => void; allowEmoji?: boolean; compact?: boolean; testId?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => btn.current?.focus());
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={value ? `${label}: ${value.label} (변경)` : `${label} 선택`}
        onClick={() => setOpen(true)}
        data-testid={testId}
        className={`inline-grid shrink-0 place-items-center rounded-xl border border-dashed border-[var(--line-strong)] text-[var(--fg-mute)] transition hover:border-[var(--accent)] hover:text-[var(--fg)] ${compact ? "size-9" : "size-11"} ${value ? "border-solid !text-[var(--fg)]" : ""}`}
      >
        {value ? <Glyph glyph={value} size={compact ? 17 : 20} /> : <Icon name="plus" size={compact ? 14 : 16} />}
      </button>
      {open && <IconPicker title={label} value={value?.ref ?? null} allowEmoji={allowEmoji} onPick={onChange} onClose={close} />}
    </>
  );
}
