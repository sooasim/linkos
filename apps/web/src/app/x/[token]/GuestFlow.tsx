"use client";
// UX-005~UX-008: 수신 → "내 명함도 보내기" → 촬영/직접입력 → 검토·동의 → 교환 완료 → (그 다음에) Claim
import Link from "next/link";
import { GUEST_MESSAGES, LOCALES, LOCALE_NAMES, type Locale, fmt } from "@linkos/domain";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { type OcrLineOut, CardScanner } from "@/components/CardScanner";
import { celebrate } from "@/components/Fx";
import { Icon, Logo } from "@/components/Icon";
import { LivingCard } from "@/components/LivingCard";
import { CARD_KEYS, type CardKey, type ReviewedCard, ReviewFields, initialFromParsed } from "@/components/ReviewFields";
import { api } from "@/lib/client";

type Landing = {
  sessionId: string;
  state: string;
  acceptsReply: boolean;
  isGroup: boolean;
  placeLabel: string | null;
  expiresAt: string;
  sender: { name: string; company: string | null; jobTitle: string | null; headline: string | null; bioShort: string | null; keywords: string[]; theme: string; fields: { type: string; label: string | null; value: string }[]; offers: string[]; needs: string[]; deep: Record<string, unknown> | null; hiddenFields: number };
};

type Step = "view" | "capture" | "review" | "sending" | "done";

const emptyCard = () => Object.fromEntries(CARD_KEYS.map((k) => [k, ""])) as Record<CardKey, string>;

export function GuestFlow({ token, landing, signedIn, viewerCard, locale = "ko" }: { token: string; landing: Landing; signedIn: boolean; viewerCard: Record<string, string> | null; locale?: Locale }) {
  const m = GUEST_MESSAGES[locale];
  const router = useRouter();
  const setLocale = (l: string) => {
    document.cookie = `lk_lang=${l}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };
  const [step, setStep] = useState<Step>("view");
  const [initial, setInitial] = useState<Record<CardKey, string>>(emptyCard());
  const [conf, setConf] = useState<Partial<Record<CardKey, number>>>({});
  const [ocrLines, setOcrLines] = useState<OcrLineOut[] | null>(null);
  const [reviewed, setReviewed] = useState<ReviewedCard | null>(null);
  const [consent, setConsent] = useState(false);
  const [extra, setExtra] = useState({ message: "", offer: "", need: "" });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ claimToken: string | null } | null>(null);
  const first = landing.sender.name.split(" ")[0] ?? landing.sender.name;

  const startReply = () => {
    if (viewerCard) {
      setInitial({ ...emptyCard(), ...viewerCard } as Record<CardKey, string>);
      setConf({});
      setStep("review");
    } else setStep("capture");
  };

  const onLines = async (lines: OcrLineOut[]) => {
    setOcrLines(lines);
    try {
      const parsed = await api<{ fields: { key: string; value: string; confidence: number }[] }>("/capture/parse", { body: { lines: lines.map((l) => ({ text: l.text, confidence: l.confidence })) } });
      const { card, conf } = initialFromParsed(parsed.fields);
      setInitial(card);
      setConf(conf);
    } catch {
      setInitial(emptyCard());
    }
    setStep("review");
  };

  const send = async () => {
    if (!reviewed) return;
    setError(null);
    setStep("sending");
    try {
      const r = await api<{ claimToken: string | null }>(`/exchange/sessions/${encodeURIComponent(token)}/reply`, {
        body: {
          card: Object.fromEntries(Object.entries(reviewed.card).map(([k, v]) => [k, v || null])),
          sharedFields: reviewed.shared,
          consent: { exchange: true },
          provenance: reviewed.provenance,
          ocr: ocrLines ? { lines: ocrLines.slice(0, 80).map((l) => ({ text: l.text, confidence: l.confidence })) } : undefined,
          message: extra.message || undefined,
          offer: extra.offer || undefined,
          need: extra.need || undefined,
        },
      });
      if (r.claimToken) {
        try {
          localStorage.setItem("lk_claim", r.claimToken);
        } catch {
          /* private mode */
        }
      }
      setResult(r);
      setStep("done");
      celebrate();
    } catch (e) {
      setError((e as Error).message);
      setStep("review");
    }
  };

  return (
    <main lang={locale} className="stage-aurora grain relative min-h-dvh overflow-x-clip">
            <div className="relative mx-auto flex min-h-dvh w-full max-w-[520px] flex-col px-5 pb-40 pt-5">
        <header className="flex items-center justify-between">
          <Logo />
          {step === "view" && (
            <label className="relative">
              <span className="sr-only">{m.language}</span>
              <select value={locale} onChange={(e) => setLocale(e.target.value)} className="chip cursor-pointer appearance-none !bg-[var(--glass)] !pr-3 backdrop-blur" data-testid="lang-select">
                {LOCALES.map((l) => (
                  <option key={l} value={l}>{LOCALE_NAMES[l]}</option>
                ))}
              </select>
            </label>
          )}
          {step !== "view" && step !== "done" && (
            <button onClick={() => setStep(step === "review" && !viewerCard ? "capture" : "view")} className="btn btn-ghost !min-h-10 !px-3 text-[14px]" aria-label={m.back}>
              <Icon name="back" size={16} /> {m.back}
            </button>
          )}
        </header>

        {step === "view" && (
          <section className="mt-6 animate-rise" aria-labelledby="sender-heading">
            <p className="eyebrow">{landing.placeLabel ? fmt(m.arrivedAt, { place: landing.placeLabel }) : m.arrived}</p>
            <h1 id="sender-heading" className="display mt-2 text-[44px]">
              {fmt(m.senderCard, { name: first })} <em>Living Card</em>
            </h1>
            <div className="mt-6">
              <LivingCard card={landing.sender} />
            </div>
            {!landing.acceptsReply && <p className="mt-6 rounded-2xl border border-[var(--line)] p-4 text-[14px] text-[var(--fg-mute)]">{m.alreadyExchanged}</p>}
          </section>
        )}

        {step === "capture" && (
          <section className="mt-6 animate-rise">
            <p className="eyebrow">Step 1 / 2</p>
            <h1 className="display mt-2 text-[44px]">
              {m.captureTitle} <em>{m.captureEm}</em>
            </h1>
            <p className="mt-3 text-[15px] text-[var(--fg-mute)]">{fmt(m.captureBody, { name: first })}</p>
            <div className="mt-6">
              <CardScanner onLines={onLines} onManual={() => { setInitial(emptyCard()); setConf({}); setOcrLines(null); setStep("review"); }} />
            </div>
          </section>
        )}

        {(step === "review" || step === "sending") && (
          <section className="mt-6 animate-rise">
            <p className="eyebrow">{viewerCard ? m.reviewEyebrowSigned : "Step 2 / 2"}</p>
            <h1 className="display mt-2 text-[44px]">
              {m.reviewTitle} <em>{m.reviewEm}</em>
            </h1>
            <p className="mt-3 text-[15px] text-[var(--fg-mute)]">{fmt(m.reviewBody, { name: first })}</p>
            <div className="mt-5">
              <ReviewFields key={JSON.stringify(initial)} initial={initial} confidence={conf} selectable onChange={setReviewed} />
            </div>
            <details className="surface mt-3 p-4">
              <summary className="cursor-pointer text-[14px] font-semibold">{m.extraSummary}</summary>
              <div className="mt-3 space-y-3">
                <input className="field" placeholder={fmt(m.messagePh, { name: first })} value={extra.message} onChange={(e) => setExtra({ ...extra, message: e.target.value })} maxLength={200} />
                <input className="field" placeholder={m.offerPh} value={extra.offer} onChange={(e) => setExtra({ ...extra, offer: e.target.value })} maxLength={200} />
                <input className="field" placeholder={m.needPh} value={extra.need} onChange={(e) => setExtra({ ...extra, need: e.target.value })} maxLength={200} />
              </div>
            </details>
            <label className="mt-4 flex items-start gap-3 rounded-2xl border border-[var(--line)] p-4 text-[14px] leading-relaxed">
              <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--accent)]" checked={consent} onChange={(e) => setConsent(e.target.checked)} name="consent" />
              <span>
                {m.consentA} <b>{landing.sender.name}</b>{m.consentB} <Link href="/legal/privacy" className="underline">{m.privacy}</Link>{m.consentC}
              </span>
            </label>
            {error && <p role="alert" className="mt-3 rounded-2xl bg-[var(--color-ember)]/15 px-4 py-3 text-[14px] text-[var(--color-ember)]">{error}</p>}
          </section>
        )}

        {step === "done" && (
          <section className="mt-10 animate-rise text-center" aria-live="polite">
            <div className="relative mx-auto grid size-24 place-items-center">
              <span className="absolute inset-0 rounded-full bg-[var(--color-iris-2)]/40 animate-pulse-ring" />
              <span className="relative grid size-24 place-items-center rounded-full bg-gradient-to-br from-[#8f7bff] to-[#f08fb4] text-white shadow-[0_20px_40px_-16px_rgba(108,92,231,.7)]">
                <Icon name="check" size={44} strokeWidth={2.4} />
              </span>
            </div>
            <h1 className="display mt-8 text-[52px]">
              {m.doneTitle} <em>{m.doneEm}</em>
            </h1>
            <p className="mt-3 text-[16px] text-[var(--fg-mute)]">{fmt(m.doneBody, { name: first })}</p>

            {result?.claimToken ? (
              <div className="surface mt-8 p-5 text-left">
                <p className="eyebrow">{m.nextStep}</p>
                <h2 className="mt-2 text-[22px] font-semibold leading-snug">{m.claimTitle}</h2>
                <p className="mt-2 text-[14px] text-[var(--fg-mute)]">{fmt(m.claimBody, { name: first })}</p>
                <Link href="/claim" className="btn btn-signal btn-lg mt-5 w-full" data-testid="claim-cta">
                  {m.claimCta} <Icon name="arrow" size={18} />
                </Link>
              </div>
            ) : (
              <Link href="/app" className="btn btn-signal btn-lg mt-8 w-full">
                {m.openNetwork}
              </Link>
            )}
          </section>
        )}
      </div>

      {(step === "view" || step === "review" || step === "sending") && (
        <div className="fixed inset-x-0 bottom-0 z-20 bg-gradient-to-t from-[var(--bg)] via-[var(--bg)]/95 to-transparent px-5 pt-10 safe-bottom">
          <div className="mx-auto w-full max-w-[520px]">
            {step === "view" && landing.acceptsReply && (
              <button onClick={startReply} className="btn btn-signal btn-lg w-full" data-testid="reply-cta">
                <Icon name="exchange" size={20} /> {m.replyCta}
              </button>
            )}
            {step === "view" && !landing.acceptsReply && (
              <Link href="/" className="btn btn-ghost btn-lg w-full">
                {m.startLinkos}
              </Link>
            )}
            {(step === "review" || step === "sending") && (
              <button onClick={send} disabled={!consent || !reviewed?.card.fullName || step === "sending"} className="btn btn-signal btn-lg w-full" data-testid="send-cta">
                {step === "sending" ? m.sending : fmt(m.sendTo, { name: first })}
              </button>
            )}
            <p className="mt-2 text-center text-[12px] text-[var(--fg-mute)]">{signedIn ? m.footSigned : m.footGuest}</p>
          </div>
        </div>
      )}
    </main>
  );
}
