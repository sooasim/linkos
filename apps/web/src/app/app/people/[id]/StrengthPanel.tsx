"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

const BAND: Record<string, string> = { strong: "강함", medium: "보통", weak: "약함" };

// F-074 관계 강도 — score with its contributing factors (explainable)
export function StrengthPanel({ id }: { id: string }) {
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    api(`/contacts/${id}/strength`).then(setS).catch(() => undefined);
  }, [id]);
  if (!s) return null;
  return (
    <details className="surface mt-4 p-4">
      <summary className="flex cursor-pointer items-center justify-between gap-2">
        <span className="eyebrow">관계 강도</span>
        <span className="font-semibold">{BAND[s.band]} · <span className="num">{Math.round(s.score * 100)}</span></span>
      </summary>
      <ul className="mt-3 space-y-1.5 text-[13.5px]">
        {s.factors.map((f: any) => (
          <li key={f.kind} className="flex items-center gap-2">
            <span className="h-1.5 rounded-full bg-[var(--fg)]" style={{ width: `${Math.max(4, f.contribution * 200)}px` }} aria-hidden />
            <span className="flex-1">{f.text}</span>
            <span className="num text-[var(--fg-mute)]">+{Math.round(f.contribution * 100)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-[var(--fg-mute)]">최근 접촉·빈도·미팅·메모·후속·상호 연결로 계산합니다(규칙 기반).</p>
    </details>
  );
}
