"use client";
// F-036 Action Card 설정 + F-032 AI Adaptive Card (제안 → 소유자 확인)
import { useEffect, useState } from "react";
import type { ResolvedGlyph } from "@linkos/domain/cardDesign";
import { GlyphButton } from "@/components/iconBank/GlyphButton";
import { AiLabel } from "@/components/Page";
import { api } from "@/lib/client";

type Cta = { enabled: boolean; icon?: string | null };
type Ctas = { booking: Cta & { url?: string | null }; quote: Cta; proposal: Cta; nda: Cta };
type CtaKind = keyof Ctas;
const LABEL: Record<keyof Ctas, string> = { booking: "미팅 예약", quote: "견적 요청", proposal: "제안 요청", nda: "NDA 요청" };
const AUD_KO: Record<string, string> = { investor: "투자자", customer: "고객", partner: "파트너", recruiting: "채용", general: "일반" };

export function CardIntel({ profileId, hasVariants }: { profileId: string; hasVariants: boolean }) {
  const [ctas, setCtas] = useState<Ctas | null>(null);
  const [glyphs, setGlyphs] = useState<Partial<Record<CtaKind, ResolvedGlyph | null>>>({});
  const [saved, setSaved] = useState(false);
  const [ctx, setCtx] = useState("");
  const [sug, setSug] = useState<{ audience: string; highlights: string[]; reasons: string[]; provenance: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api<Ctas & { glyphs?: Partial<Record<CtaKind, ResolvedGlyph | null>> }>(`/profiles/${profileId}/actions`)
      .then(({ glyphs: g, ...c }) => {
        setCtas(c);
        setGlyphs(g ?? {});
      })
      .catch(() => setCtas(null));
  }, [profileId]);

  const saveCtas = async (next: Ctas) => {
    setCtas(next);
    setSaved(false);
    try {
      await api(`/profiles/${profileId}/actions`, { method: "PUT", body: { ...next, booking: { enabled: next.booking.enabled, url: next.booking.url || null, icon: next.booking.icon ?? null } } });
      setSaved(true);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const suggest = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setSug(await api(`/profiles/${profileId}/adaptive`, { body: { context: ctx || undefined } }));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (makeDefault: boolean) => {
    if (!sug) return;
    await api(`/profiles/${profileId}/adaptive/confirm`, { body: { audience: sug.audience, highlights: sug.highlights, makeDefault } });
    setMsg(makeDefault ? "기본 변형으로 설정하고 강조 순서를 저장했어요." : "강조 순서를 저장했어요.");
    setSug(null);
  };

  return (
    <>
      <section className="space-y-3" aria-labelledby="cta-h">
        <h2 id="cta-h" className="eyebrow">Action Card · 요청 버튼</h2>
        <p className="text-[13.5px] text-[var(--fg-mute)]">켜둔 버튼은 내 카드를 받은 사람이 로그인 없이 누를 수 있어요. 요청은 알림함으로 와요.</p>
        {ctas &&
          (Object.keys(LABEL) as (keyof Ctas)[]).map((k) => (
            <div key={k} className="surface flex flex-wrap items-center gap-3 p-3">
              <GlyphButton
                compact
                label={`${LABEL[k]} 버튼 아이콘`}
                value={glyphs[k] ?? null}
                onChange={(g) => {
                  setGlyphs({ ...glyphs, [k]: g });
                  void saveCtas({ ...ctas, [k]: { ...ctas[k], icon: g?.ref ?? null } });
                }}
              />
              <label className="flex items-center gap-3 text-[15px]">
                <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={ctas[k].enabled} onChange={(e) => saveCtas({ ...ctas, [k]: { ...ctas[k], enabled: e.target.checked } })} />
                {LABEL[k]}
              </label>
              {k === "booking" && ctas.booking.enabled && (
                <input
                  className="field !min-h-10 flex-1 !py-1"
                  type="url"
                  placeholder="https:// 예약 링크 (없으면 요청 폼)"
                  aria-label="예약 링크"
                  defaultValue={ctas.booking.url ?? ""}
                  onBlur={(e) => saveCtas({ ...ctas, booking: { enabled: true, url: e.target.value.trim() || null } })}
                />
              )}
            </div>
          ))}
        {saved && <p className="text-[12.5px] text-[var(--fg-mute)]" role="status">저장됨</p>}
      </section>

      {hasVariants && (
        <section className="space-y-3" aria-labelledby="adp-h">
          <h2 id="adp-h" className="eyebrow">Adaptive Card · 상대 맞춤 추천</h2>
          <div className="flex gap-2">
            <input className="field" placeholder="상대 맥락 (예: 시리즈B 검토 중인 VC 심사역)" aria-label="상대 맥락" value={ctx} onChange={(e) => setCtx(e.target.value)} maxLength={500} />
            <button type="button" className="btn btn-ghost shrink-0" disabled={busy} onClick={suggest}>{busy ? "분석 중…" : "추천"}</button>
          </div>
          {sug && (
            <div className="surface space-y-2 p-4">
              <p className="flex items-center gap-2 text-[15px]"><AiLabel>{sug.provenance === "ai" ? "AI 추론" : "규칙 추천"}</AiLabel> <b>{AUD_KO[sug.audience] ?? sug.audience}</b> 변형 추천</p>
              <ol className="list-decimal pl-5 text-[14px]">{sug.highlights.slice(0, 5).map((h) => <li key={h}>{h}</li>)}</ol>
              {sug.reasons.map((r) => <p key={r} className="text-[12.5px] text-[var(--fg-mute)]">{r}</p>)}
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="button" className="btn btn-signal" onClick={() => confirm(false)}>강조 순서 적용</button>
                <button type="button" className="btn btn-ghost" onClick={() => confirm(true)}>기본 변형으로도 설정</button>
                <button type="button" className="btn btn-ghost" onClick={() => setSug(null)}>무시</button>
              </div>
            </div>
          )}
        </section>
      )}
      {msg && <p className="text-[13px] text-[var(--fg-mute)]" role="status">{msg}</p>}
    </>
  );
}
