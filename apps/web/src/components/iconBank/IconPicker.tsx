"use client";
// X-008 / F-036 — accessible icon & emoji picker. Lazy-loaded (next/dynamic from GlyphButton) and loads the
// icon/emoji banks with a dynamic import, so neither ever ships on the guest landing.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ResolvedGlyph } from "@linkos/domain/cardDesign";
import type { BankEmoji, EmojiCategory } from "@linkos/domain/emojiBank";
import type { BankIcon, IconCategory } from "@linkos/domain/iconBank";
import { Glyph } from "../cardTemplates/Glyph";
import { Icon } from "../Icon";

type Banks = {
  icon: typeof import("@linkos/domain/iconBank");
  emoji: typeof import("@linkos/domain/emojiBank");
};

const RECENT_KEY = "lk_glyph_recent";
const COLS = 8;

function readRecent(): ResolvedGlyph[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const v = raw ? (JSON.parse(raw) as ResolvedGlyph[]) : [];
    return Array.isArray(v) ? v.filter((g) => g && typeof g.ref === "string").slice(0, 16) : [];
  } catch {
    return [];
  }
}
function pushRecent(g: ResolvedGlyph) {
  try {
    const next = [g, ...readRecent().filter((x) => x.ref !== g.ref)].slice(0, 16);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable (private mode) — recents are a convenience only */
  }
}

const iconGlyph = (i: BankIcon): ResolvedGlyph => ({ kind: "icon", ref: `i:${i.id}`, d: i.d, label: i.ko[0] ?? i.id });
const emojiGlyph = (e: BankEmoji): ResolvedGlyph => ({ kind: "emoji", ref: `e:${e.char}`, char: e.char, label: e.ko[0] ?? e.en[0] ?? e.char });

export default function IconPicker({ title, value, allowEmoji = true, onPick, onClose }: { title: string; value: string | null; allowEmoji?: boolean; onPick: (g: ResolvedGlyph | null) => void; onClose: () => void }) {
  const [banks, setBanks] = useState<Banks | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<"icons" | "emoji">(value?.startsWith("e:") && allowEmoji ? "emoji" : "icons");
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<ResolvedGlyph[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    let alive = true;
    Promise.all([import("@linkos/domain/iconBank"), import("@linkos/domain/emojiBank")])
      .then(([icon, emoji]) => alive && setBanks({ icon, emoji }))
      .catch(() => alive && setFailed(true));
    setRecent(readRecent().filter((g) => allowEmoji || g.kind === "icon"));
    searchRef.current?.focus();
    return () => {
      alive = false;
    };
  }, [allowEmoji]);

  const items: ResolvedGlyph[] = useMemo(() => {
    if (!banks) return [];
    if (tab === "icons") return banks.icon.searchIcons(query, (cat as IconCategory) || null).map(iconGlyph);
    return banks.emoji.searchEmoji(query, (cat as EmojiCategory) || null).map(emojiGlyph);
  }, [banks, tab, query, cat]);

  useEffect(() => setActive(0), [tab, query, cat]);

  const cats: [string, string][] = banks
    ? tab === "icons"
      ? banks.icon.ICON_CATEGORIES.map((c) => [c, banks.icon.ICON_CATEGORY_LABEL[c].ko])
      : banks.emoji.EMOJI_CATEGORIES.map((c) => [c, banks.emoji.EMOJI_CATEGORY_LABEL[c].ko])
    : [];

  const choose = (g: ResolvedGlyph | null) => {
    if (g) pushRecent(g);
    onPick(g);
    onClose();
  };

  const focusIdx = (i: number) => {
    const n = Math.max(0, Math.min(items.length - 1, i));
    setActive(n);
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-idx="${n}"]`)?.focus();
  };
  const onGridKey = (e: React.KeyboardEvent) => {
    const map: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS };
    if (e.key in map) {
      e.preventDefault();
      focusIdx(active + map[e.key]!);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusIdx(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusIdx(items.length - 1);
    }
  };
  const onDialogKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
    if (e.key === "Tab" && dialogRef.current) {
      // keep focus inside the dialog
      const f = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input'));
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[color-mix(in_srgb,var(--fg)_28%,transparent)] sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} onKeyDown={onDialogKey} className="surface safe-bottom flex max-h-[82dvh] w-full max-w-[520px] flex-col gap-3 rounded-b-none bg-[var(--bg-elev)] p-4 shadow-2xl sm:rounded-b-[22px]" data-testid="icon-picker">
        <div className="flex items-center justify-between gap-2">
          <h2 id={`${id}-t`} className="text-[16px] font-semibold">{title}</h2>
          <button type="button" className="grid size-10 place-items-center rounded-full text-[var(--fg-mute)]" aria-label="닫기" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>
        {allowEmoji && (
          <div role="tablist" aria-label="종류" className="flex rounded-full bg-[var(--bg-sunk)] p-1">
            {(
              [
                ["icons", "아이콘"],
                ["emoji", "이모지"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setCat(null); }} className={`flex-1 rounded-full py-2 text-[14px] font-semibold ${tab === k ? "bg-[var(--bg-elev)] text-[var(--fg)] shadow-sm" : "text-[var(--fg-mute)]"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        <input ref={searchRef} className="field" type="search" placeholder="검색 (예: 전화, coffee, 한옥)" aria-label={tab === "icons" ? "아이콘 검색" : "이모지 검색"} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); focusIdx(0); } }} />
        <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1" role="group" aria-label="카테고리">
          <button type="button" aria-pressed={cat === null} onClick={() => setCat(null)} className={`chip shrink-0 ${cat === null ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>전체</button>
          {cats.map(([c, label]) => (
            <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(cat === c ? null : c)} className={`chip shrink-0 ${cat === c ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
              {label}
            </button>
          ))}
        </div>
        {recent.length > 0 && !query && !cat && (
          <div>
            <p className="label !mb-1">최근 사용</p>
            <div className="flex flex-wrap gap-1">
              {recent.map((g) => (
                <button key={g.ref} type="button" aria-label={`${g.label} 선택`} className="grid size-10 place-items-center rounded-xl hover:bg-[var(--bg-sunk)]" onClick={() => choose(g)}>
                  <Glyph glyph={g} size={22} />
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="min-h-[180px] overflow-y-auto">
          {failed ? (
            <p role="alert" className="p-4 text-[14px] text-[var(--fg-mute)]">아이콘을 불러오지 못했어요. 연결을 확인하세요.</p>
          ) : !banks ? (
            <p role="status" className="p-4 text-[14px] text-[var(--fg-mute)]">불러오는 중…</p>
          ) : items.length === 0 ? (
            <p role="status" className="p-4 text-[14px] text-[var(--fg-mute)]">‘{query}’ 결과가 없어요.</p>
          ) : (
            <div ref={gridRef} role="listbox" aria-label={tab === "icons" ? "아이콘 목록" : "이모지 목록"} onKeyDown={onGridKey} className="grid grid-cols-8 gap-1" data-testid="glyph-grid">
              {items.map((g, i) => (
                <button
                  key={g.ref}
                  type="button"
                  role="option"
                  aria-selected={value === g.ref}
                  aria-label={g.label}
                  title={g.label}
                  data-idx={i}
                  data-ref={g.ref}
                  tabIndex={i === active ? 0 : -1}
                  onFocus={() => setActive(i)}
                  onClick={() => choose(g)}
                  className={`grid aspect-square place-items-center rounded-xl text-[var(--fg)] outline-offset-1 hover:bg-[var(--bg-sunk)] ${value === g.ref ? "bg-[var(--accent-soft)] ring-2 ring-[var(--accent)]" : ""}`}
                >
                  <Glyph glyph={g} size={22} />
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="sr-only" role="status" aria-live="polite">{banks ? `${items.length}개` : ""}</p>
        {value && (
          <button type="button" className="btn btn-ghost w-full" onClick={() => choose(null)}>
            <Icon name="trash" size={16} /> 아이콘 없애기
          </button>
        )}
      </div>
    </div>
  );
}
