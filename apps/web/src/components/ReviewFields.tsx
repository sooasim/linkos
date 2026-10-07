"use client";
// F-017 신뢰도 표시, F-018 저신뢰 검토, F-058 전송 필드 명시 — 수정은 틀린 항목만.
import { useEffect, useState } from "react";

export const CARD_KEYS = ["fullName", "company", "jobTitle", "department", "email", "phone", "address", "website"] as const;
export type CardKey = (typeof CARD_KEYS)[number];

export const KEY_LABEL: Record<CardKey, string> = {
  fullName: "이름",
  company: "회사",
  jobTitle: "직책",
  department: "부서",
  email: "이메일",
  phone: "전화",
  address: "주소",
  website: "웹사이트",
};

export interface ParsedField {
  key: string;
  value: string;
  confidence: number;
  needsReview?: boolean;
}

export interface ReviewedCard {
  card: Record<CardKey, string>;
  provenance: Record<string, { source: "ocr" | "user"; confidence?: number }>;
  shared: CardKey[];
}

function mapKey(k: string): CardKey | null {
  if (k === "mobile" || k === "phone") return "phone";
  return (CARD_KEYS as readonly string[]).includes(k) ? (k as CardKey) : null;
}

export function initialFromParsed(fields: ParsedField[]) {
  const card = Object.fromEntries(CARD_KEYS.map((k) => [k, ""])) as Record<CardKey, string>;
  const conf: Partial<Record<CardKey, number>> = {};
  // prefer mobile over landline for "phone"
  const sorted = [...fields].sort((a, b) => (a.key === "mobile" ? -1 : b.key === "mobile" ? 1 : 0));
  for (const f of sorted) {
    const k = mapKey(f.key);
    if (k && !card[k]) {
      card[k] = f.value;
      conf[k] = f.confidence;
    }
  }
  return { card, conf };
}

export function ReviewFields({
  initial,
  confidence = {},
  threshold = 0.75,
  selectable = false,
  defaultShared = ["fullName", "company", "jobTitle", "email", "phone"],
  onChange,
}: {
  initial: Record<CardKey, string>;
  confidence?: Partial<Record<CardKey, number>>;
  threshold?: number;
  selectable?: boolean;
  defaultShared?: CardKey[];
  onChange: (r: ReviewedCard) => void;
}) {
  const [card, setCard] = useState(initial);
  const [edited, setEdited] = useState<Set<CardKey>>(new Set());
  const [shared, setShared] = useState<Set<CardKey>>(new Set(defaultShared.filter((k) => initial[k] || k === "fullName")));

  const emit = (c: typeof card, e: Set<CardKey>, s: Set<CardKey>) => {
    const provenance: ReviewedCard["provenance"] = {};
    for (const k of CARD_KEYS) {
      if (!c[k]) continue;
      provenance[k] = confidence[k] !== undefined && !e.has(k) ? { source: "ocr", confidence: confidence[k] } : { source: "user" };
    }
    onChange({ card: c, provenance, shared: CARD_KEYS.filter((k) => s.has(k) && c[k]) });
  };

  useEffect(() => emit(card, edited, shared), []); // eslint-disable-line react-hooks/exhaustive-deps

  const lowCount = CARD_KEYS.filter((k) => card[k] && confidence[k] !== undefined && confidence[k]! < threshold && !edited.has(k)).length;

  return (
    <div className="space-y-2.5">
      {lowCount > 0 && (
        <p className="rounded-2xl bg-[var(--color-ember)]/10 px-4 py-2.5 text-[13.5px] font-medium text-[var(--color-ember)]">확인이 필요한 항목 {lowCount}개만 살펴봐 주세요.</p>
      )}
      {CARD_KEYS.map((k) => {
        const c = confidence[k];
        const low = c !== undefined && c < threshold && !edited.has(k) && !!card[k];
        return (
          <div key={k} className={`surface flex items-center gap-3 px-3 py-2 ${low ? "!border-[var(--color-ember)]" : ""}`}>
            {selectable && (
              <input
                type="checkbox"
                aria-label={`${KEY_LABEL[k]} 보내기`}
                className="size-5 shrink-0 accent-[var(--color-ink)]"
                checked={shared.has(k)}
                disabled={k === "fullName" || !card[k]}
                onChange={(e) => {
                  const s = new Set(shared);
                  if (e.target.checked) s.add(k);
                  else s.delete(k);
                  setShared(s);
                  emit(card, edited, s);
                }}
              />
            )}
            <label className="min-w-0 flex-1">
              <span className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-mute)]">
                {KEY_LABEL[k]}
                {c !== undefined && card[k] && !edited.has(k) && (
                  <span className={`num normal-case tracking-normal ${low ? "text-[var(--color-ember)]" : ""}`} title="인식 신뢰도">
                    OCR {Math.round(c * 100)}%
                  </span>
                )}
                {edited.has(k) && <span className="normal-case tracking-normal">직접 수정</span>}
              </span>
              <input
                className="w-full bg-transparent py-1 text-[16px] font-medium outline-none placeholder:text-[var(--fg-mute)]/60"
                value={card[k]}
                placeholder={k === "fullName" ? "필수" : "—"}
                inputMode={k === "phone" ? "tel" : k === "email" ? "email" : undefined}
                name={k}
                onChange={(e) => {
                  const nc = { ...card, [k]: e.target.value };
                  const ne = new Set(edited).add(k);
                  const ns = new Set(shared);
                  if (e.target.value && selectable && defaultShared.includes(k)) ns.add(k);
                  setCard(nc);
                  setEdited(ne);
                  setShared(ns);
                  emit(nc, ne, ns);
                }}
              />
            </label>
          </div>
        );
      })}
    </div>
  );
}
