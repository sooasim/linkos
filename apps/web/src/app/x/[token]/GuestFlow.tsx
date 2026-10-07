"use client";
// UX-005~UX-008: 수신 → "내 명함도 보내기" → 촬영/직접입력 → 검토·동의 → 교환 완료 → (그 다음에) Claim
import Link from "next/link";
import { useState } from "react";
import { type OcrLineOut, CardScanner } from "@/components/CardScanner";
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

export function GuestFlow({ token, landing, signedIn, viewerCard }: { token: string; landing: Landing; signedIn: boolean; viewerCard: Record<string, string> | null }) {
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
    } catch (e) {
      setError((e as Error).message);
      setStep("review");
    }
  };

  return (
    <main className="stage-ink grain relative min-h-dvh overflow-x-clip">
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[var(--color-signal)] opacity-[0.07] blur-3xl" />
      <div className="relative mx-auto flex min-h-dvh w-full max-w-[520px] flex-col px-5 pb-40 pt-5">
        <header className="flex items-center justify-between">
          <Logo />
          {step !== "view" && step !== "done" && (
            <button onClick={() => setStep(step === "review" && !viewerCard ? "capture" : "view")} className="btn btn-ghost !min-h-10 !px-3 text-[14px]" aria-label="뒤로">
              <Icon name="back" size={16} /> 뒤로
            </button>
          )}
        </header>

        {step === "view" && (
          <section className="mt-6 animate-rise" aria-labelledby="sender-heading">
            <p className="eyebrow">{landing.placeLabel ? `${landing.placeLabel}에서 · ` : ""}명함이 도착했어요</p>
            <h1 id="sender-heading" className="display mt-2 text-[44px]">
              {first}님의 <em className="text-[var(--color-signal)]">Living Card</em>
            </h1>
            <div className="mt-6">
              <LivingCard card={landing.sender} />
            </div>
            {!landing.acceptsReply && <p className="mt-6 rounded-2xl border border-[var(--line)] p-4 text-[14px] text-[var(--fg-mute)]">이 링크로는 이미 교환이 완료되었어요. 카드는 계속 볼 수 있습니다.</p>}
          </section>
        )}

        {step === "capture" && (
          <section className="mt-6 animate-rise">
            <p className="eyebrow">Step 1 / 2</p>
            <h1 className="display mt-2 text-[44px]">
              내 명함을 <em>찍어주세요</em>
            </h1>
            <p className="mt-3 text-[15px] text-[var(--fg-mute)]">가입 없이 {first}님께 바로 보낼 수 있어요. 10초면 충분합니다.</p>
            <div className="mt-6">
              <CardScanner onLines={onLines} onManual={() => { setInitial(emptyCard()); setConf({}); setOcrLines(null); setStep("review"); }} />
            </div>
          </section>
        )}

        {(step === "review" || step === "sending") && (
          <section className="mt-6 animate-rise">
            <p className="eyebrow">{viewerCard ? "내 명함으로 교환" : "Step 2 / 2"}</p>
            <h1 className="display mt-2 text-[44px]">
              보낼 내용을 <em>확인</em>
            </h1>
            <p className="mt-3 text-[15px] text-[var(--fg-mute)]">체크한 항목만 {first}님에게 전달됩니다.</p>
            <div className="mt-5">
              <ReviewFields key={JSON.stringify(initial)} initial={initial} confidence={conf} selectable onChange={setReviewed} />
            </div>
            <details className="surface mt-3 p-4">
              <summary className="cursor-pointer text-[14px] font-semibold">한 줄 메시지 · Offer/Need (선택)</summary>
              <div className="mt-3 space-y-3">
                <input className="field" placeholder={`${first}님께 남길 한마디`} value={extra.message} onChange={(e) => setExtra({ ...extra, message: e.target.value })} maxLength={200} />
                <input className="field" placeholder="내가 줄 수 있는 것 (Offer)" value={extra.offer} onChange={(e) => setExtra({ ...extra, offer: e.target.value })} maxLength={200} />
                <input className="field" placeholder="지금 필요한 것 (Need)" value={extra.need} onChange={(e) => setExtra({ ...extra, need: e.target.value })} maxLength={200} />
              </div>
            </details>
            <label className="mt-4 flex items-start gap-3 rounded-2xl border border-[var(--line)] p-4 text-[14px] leading-relaxed">
              <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--color-signal)]" checked={consent} onChange={(e) => setConsent(e.target.checked)} name="consent" />
              <span>
                선택한 항목을 <b>{landing.sender.name}</b>님에게 보내는 데 동의합니다. 교환 기록은 <Link href="/legal/privacy" className="underline">개인정보 처리방침</Link>에 따라 보관됩니다.
              </span>
            </label>
            {error && <p role="alert" className="mt-3 rounded-2xl bg-[var(--color-ember)]/15 px-4 py-3 text-[14px] text-[var(--color-ember)]">{error}</p>}
          </section>
        )}

        {step === "done" && (
          <section className="mt-10 animate-rise text-center" aria-live="polite">
            <div className="relative mx-auto grid size-24 place-items-center">
              <span className="absolute inset-0 rounded-full bg-[var(--color-signal)] animate-pulse-ring" />
              <span className="relative grid size-24 place-items-center rounded-full bg-[var(--color-signal)] text-[var(--color-ink)]">
                <Icon name="check" size={44} strokeWidth={2.4} />
              </span>
            </div>
            <h1 className="display mt-8 text-[52px]">
              교환 <em className="text-[var(--color-signal)]">완료</em>
            </h1>
            <p className="mt-3 text-[16px] text-[var(--fg-mute)]">{first}님에게 내 명함이 전달됐어요.</p>

            {result?.claimToken ? (
              <div className="surface mt-8 p-5 text-left">
                <p className="eyebrow">다음 단계 · 선택</p>
                <h2 className="mt-2 text-[22px] font-semibold leading-snug">방금 만든 내 디지털 명함을 소유하시겠어요?</h2>
                <p className="mt-2 text-[14px] text-[var(--fg-mute)]">가입하면 {first}님 명함이 내 주소록에 저장되고, 방금 입력한 정보로 Living Card가 자동 완성됩니다.</p>
                <Link href="/claim" className="btn btn-signal btn-lg mt-5 w-full" data-testid="claim-cta">
                  내 카드 소유하기 <Icon name="arrow" size={18} />
                </Link>
              </div>
            ) : (
              <Link href="/app" className="btn btn-signal btn-lg mt-8 w-full">
                내 인맥에서 보기
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
                <Icon name="exchange" size={20} /> 내 명함도 보내기
              </button>
            )}
            {step === "view" && !landing.acceptsReply && (
              <Link href="/" className="btn btn-ghost btn-lg w-full">
                나도 LINKOS 시작하기
              </Link>
            )}
            {(step === "review" || step === "sending") && (
              <button onClick={send} disabled={!consent || !reviewed?.card.fullName || step === "sending"} className="btn btn-signal btn-lg w-full" data-testid="send-cta">
                {step === "sending" ? "보내는 중…" : `${first}님께 보내기`}
              </button>
            )}
            <p className="mt-2 text-center text-[12px] text-[var(--fg-mute)]">{signedIn ? "로그인 상태 — 양쪽 주소록에 바로 저장돼요" : "가입 없이 교환 · 언제든 삭제 요청 가능"}</p>
          </div>
        </div>
      )}
    </main>
  );
}
