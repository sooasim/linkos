"use client";
// X-009 문자명함 전송.
//  1) 상대의 종이 명함을 촬영한다 → 기기에서 OCR·구조화(F-010/F-016, /app/scan 과 같은 파서)
//  2) 번호와 이름을 확인한다 (틀린 값은 고친다 — OCR 원문에 없는 값은 만들지 않는다)
//  3) 내 명함 이미지를 캔버스로 그려 올리고, 보낼 문자 본문을 미리 본다
//  4) "문자 보내기"를 **직접** 누를 때만 발송한다(§2.8). 게이트웨이가 없으면 내 문자 앱이 열린다.
import {
  CARD_IMG_HEIGHT,
  CARD_IMG_WIDTH,
  type CardImageStyle,
  type CardSmsSender,
  buildCardSmsText,
  cardImageLayout,
  smsByteLength,
  smsKind,
} from "@linkos/domain";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CardScanner, type OcrLineOut, type ScanExtra } from "@/components/CardScanner";
import { Icon } from "@/components/Icon";
import { CARD_KEYS, type CardKey, type ReviewedCard, ReviewFields, initialFromParsed } from "@/components/ReviewFields";
import { canvasMeasure, drawOps, ensureCardFonts } from "@/lib/bgOps";
import { api, uid, upload } from "@/lib/client";

const STYLE_LABEL: Record<CardImageStyle, string> = { pastel: "파스텔", ink: "다크" };
/** 미리보기용 자리표시자. 실제 링크(/s/{32자 토큰})와 길이를 맞춰 바이트 수가 과소평가되지 않게 한다. */
const LINK_PLACEHOLDER = "https://linkos.app/s/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const KIND_LABEL: Record<string, string> = { sms: "단문(SMS)", lms: "장문(LMS)", mms: "그림문자(MMS)" };
const STATUS_LABEL: Record<string, string> = {
  draft: "초안",
  sending: "보내는 중",
  sent: "발송",
  failed: "실패",
  manual: "문자 앱으로 보냄",
  cancelled: "취소",
};

interface Preview {
  profileId: string;
  sender: CardSmsSender;
  cardUrl: string;
  provider: string | null;
  canSend: boolean;
}

interface Delivery {
  id: string;
  toName: string | null;
  toPhone: string;
  body: string;
  kind: string;
  status: string;
  provider: string | null;
  error: string | null;
  link: string | null;
  smsLink: string | null;
  withImage: boolean;
  openedAt: string | null;
  savedAt: string | null;
  openCount: number;
  createdAt: string;
}

const blankCard = () => Object.fromEntries(CARD_KEYS.map((k) => [k, ""])) as Record<CardKey, string>;

export function CardSmsFlow() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [step, setStep] = useState<"scan" | "review" | "compose" | "done">("scan");
  const [initial, setInitial] = useState<Record<CardKey, string>>(blankCard());
  const [conf, setConf] = useState<Partial<Record<CardKey, number>>>({});
  const [reviewed, setReviewed] = useState<ReviewedCard | null>(null);
  const [businessCardId, setBusinessCardId] = useState<string | null>(null);
  const [place, setPlace] = useState("");
  const [note, setNote] = useState("");
  const [style, setStyle] = useState<CardImageStyle>("pastel");
  const [withImage, setWithImage] = useState(true);
  const [saveContact, setSaveContact] = useState(true);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sent, setSent] = useState<Delivery | null>(null);
  const [history, setHistory] = useState<Delivery[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);

  const loadHistory = useCallback(() => {
    api<{ deliveries: Delivery[] }>("/card-sms").then((r) => setHistory(r.deliveries)).catch(() => undefined);
  }, []);

  useEffect(() => {
    api<Preview>("/card-sms?preview=1").then(setPreview).catch((e) => setError((e as Error).message));
    loadHistory();
  }, [loadHistory]);

  // 내 명함 이미지 미리보기 — 레이아웃은 도메인(순수 함수)이 계산하고 여기서는 그리기만 한다.
  const render = useCallback(
    async (target: HTMLCanvasElement, scale: number) => {
      if (!preview) return;
      await ensureCardFonts();
      target.width = CARD_IMG_WIDTH * scale;
      target.height = CARD_IMG_HEIGHT * scale;
      const ctx = target.getContext("2d");
      if (!ctx) return;
      ctx.scale(scale, scale);
      drawOps(ctx, cardImageLayout(preview.sender, preview.cardUrl, style, canvasMeasure(ctx)), {
        width: CARD_IMG_WIDTH,
        height: CARD_IMG_HEIGHT,
        maxTextWidth: CARD_IMG_WIDTH - 160,
      });
    },
    [preview, style],
  );

  useEffect(() => {
    if (canvas.current && step === "compose") void render(canvas.current, 0.5);
  }, [render, step]);

  const onLines = async (lines: OcrLineOut[], _p: string, _extra?: ScanExtra) => {
    setError(null);
    try {
      const job = await api<{ id: string | null; fields: { key: string; value: string; confidence: number }[] }>("/capture/cards", {
        body: { side: "front", kind: "card", engine: "tesseract.js", lines },
        offline: false,
      });
      setBusinessCardId(job.id);
      const { card, conf } = initialFromParsed(job.fields);
      setInitial(card);
      setConf(conf);
      setStep("review");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const manual = () => {
    setInitial(blankCard());
    setConf({});
    setBusinessCardId(null);
    setStep("review");
  };

  const toCompose = () => {
    setError(null);
    if (!reviewed?.card.phone?.trim()) {
      setError("상대 휴대폰 번호가 필요해요. 명함의 번호가 잘못 읽혔다면 직접 고쳐 주세요.");
      return;
    }
    setStep("compose");
  };

  /** 캔버스 → PNG → 업로드. 실패하면 이미지 없이 본문만 보낸다(발송 자체를 막지 않는다). */
  const uploadImage = async (): Promise<string | null> => {
    const c = document.createElement("canvas");
    await render(c, 1);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
    if (!blob) return null;
    const r = await upload<{ objectId: string }>("/card-sms/image", blob, { filename: "my-card.png", idempotencyKey: uid() });
    return r.objectId;
  };

  const send = async () => {
    if (!reviewed) return;
    setBusy("sending");
    setError(null);
    setNotice(null);
    try {
      let imageObjectId: string | null = null;
      if (withImage) {
        try {
          imageObjectId = await uploadImage();
        } catch (e) {
          setNotice(`명함 이미지를 올리지 못해 본문만 보냅니다. (${(e as Error).message})`);
        }
      }
      let contactId: string | null = null;
      if (saveContact) {
        const c = reviewed.card;
        const body = {
          ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v || null])),
          fullName: c.fullName || c.phone,
          source: businessCardId ? "scan" : "manual",
          provenance: reviewed.provenance,
          businessCardId,
          encounter: place ? { placeLabel: place } : undefined,
        };
        contactId = (await api<{ contactId: string }>("/contacts", { idempotencyKey: uid(), body })).contactId;
      }
      const draft = await api<Delivery>("/card-sms", {
        idempotencyKey: uid(),
        body: {
          recipient: { fullName: reviewed.card.fullName || null, phone: reviewed.card.phone },
          contactId,
          businessCardId,
          imageObjectId,
          placeLabel: place || null,
          note: note || null,
          consent: "card_handed",
        },
      });
      const result = await api<Delivery & { gateway: boolean; imageDropped?: boolean }>(`/card-sms/${draft.id}/send`, {
        idempotencyKey: uid(),
        body: { approved: true },
      });
      setSent(result);
      if (!result.gateway && result.smsLink) {
        setNotice("이 서버에는 문자 발송 게이트웨이가 연결돼 있지 않아요. 아래 버튼으로 내 문자 앱에서 바로 보낼 수 있어요.");
      } else if (result.imageDropped) {
        setNotice("명함 이미지가 거부돼 본문만 발송됐어요. 링크를 열면 이미지가 보입니다.");
      }
      setStep("done");
      loadHistory();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restart = () => {
    setStep("scan");
    setInitial(blankCard());
    setConf({});
    setReviewed(null);
    setBusinessCardId(null);
    setPlace("");
    setNote("");
    setConsent(false);
    setSent(null);
    setNotice(null);
    setError(null);
  };

  // 미리보기는 서버가 쓰는 것과 **같은 도메인 함수**로 만든다(문구가 갈라지지 않게).
  // 저장 링크는 발송 요청에서 처음 만들어지므로 자리표시자를 넣고, 길이는 실제 토큰 길이로 보정한다.
  const bodyPreview =
    preview && reviewed
      ? buildCardSmsText(preview.sender, LINK_PLACEHOLDER, {
          recipientName: reviewed.card.fullName || null,
          placeLabel: place || null,
          note: note || null,
          withImage,
          locale: "ko",
        })
      : "";
  const bytes = smsByteLength(bodyPreview);
  const kind = smsKind(bodyPreview, withImage);

  return (
    <div className="space-y-5">
      {error && <p role="alert" className="rounded-2xl bg-[var(--color-ember)]/15 px-4 py-3 text-[14px] text-[var(--color-ember)]">{error}</p>}
      {notice && <p role="status" className="rounded-2xl bg-[var(--bg-elev)] px-4 py-3 text-[13.5px]">{notice}</p>}

      {step === "scan" && (
        <section className="space-y-4 animate-rise" aria-labelledby="scan-h">
          <h2 id="scan-h" className="text-[18px] font-semibold">1. 상대 명함을 촬영하세요</h2>
          <p className="text-[14px] text-[var(--fg-mute)]">
            사진은 이 기기 안에서만 인식합니다. 읽은 텍스트와 신뢰도만 서버로 가고, 원본 사진은 올라가지 않아요.
          </p>
          <CardScanner onLines={onLines} onManual={manual} />
        </section>
      )}

      {step === "review" && (
        <section className="space-y-4 animate-rise" aria-labelledby="review-h">
          <h2 id="review-h" className="text-[18px] font-semibold">2. 번호가 맞는지 확인하세요</h2>
          <p className="text-[14px] text-[var(--fg-mute)]">문자는 여기 적힌 번호로 갑니다. 흐리게 찍힌 숫자는 꼭 눈으로 확인해 주세요.</p>
          <ReviewFields key={JSON.stringify(initial)} initial={initial} confidence={conf} threshold={0.75} onChange={setReviewed} />
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="label">만난 곳</span>
              <input className="field" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="예: 스타트업 밋업" />
            </label>
            <label className="flex items-end gap-3 text-[15px]">
              <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={saveContact} onChange={(e) => setSaveContact(e.target.checked)} />
              이 명함을 내 인맥에도 저장
            </label>
          </div>
          <div className="flex gap-2">
            <button onClick={toCompose} disabled={!reviewed?.card.phone?.trim()} className="btn btn-signal btn-lg flex-1" data-testid="card-sms-next">
              다음 · 보낼 내용 보기
            </button>
            <button onClick={restart} className="btn btn-ghost btn-lg">다시</button>
          </div>
        </section>
      )}

      {step === "compose" && preview && (
        <section className="space-y-4 animate-rise" aria-labelledby="compose-h">
          <h2 id="compose-h" className="text-[18px] font-semibold">3. 이렇게 보냅니다</h2>
          <div className="surface space-y-3 p-4">
            <p className="text-[13px] text-[var(--fg-mute)]">
              받는 사람 <span className="num font-semibold text-[var(--fg)]">{reviewed?.card.phone}</span>
              {reviewed?.card.fullName ? ` · ${reviewed.card.fullName}` : ""}
            </p>
            <label className="flex items-center gap-3 text-[15px]">
              <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={withImage} onChange={(e) => setWithImage(e.target.checked)} data-testid="card-sms-with-image" />
              내 명함 이미지 함께 보내기 (그림문자)
            </label>
            {withImage && (
              <>
                <div className="flex gap-2" role="radiogroup" aria-label="명함 이미지 스타일">
                  {(Object.keys(STYLE_LABEL) as CardImageStyle[]).map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={style === s} onClick={() => setStyle(s)} className={`chip ${style === s ? "!bg-[var(--accent-soft)] !text-[var(--accent-text)]" : ""}`}>
                      {STYLE_LABEL[s]}
                    </button>
                  ))}
                </div>
                <canvas ref={canvas} aria-label="문자로 보낼 내 명함 이미지 미리보기" role="img" className="w-full rounded-[18px] border border-[var(--line)]" data-testid="card-sms-image-preview" />
              </>
            )}
            <label>
              <span className="label">인사말 (비우면 기본 문구)</span>
              <input className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="오늘 말씀 나눠 반가웠습니다." />
            </label>
            <div>
              <p className="label">문자 본문</p>
              <pre className="mt-1 whitespace-pre-wrap rounded-2xl bg-[var(--bg-sunk)] p-3 text-[13.5px]" data-testid="card-sms-body">{bodyPreview}</pre>
              <p className="mt-1 text-[12.5px] text-[var(--fg-mute)]">
                {KIND_LABEL[kind]} · 약 {bytes}바이트 · 저장 링크는 보낼 때 만들어져 마지막 줄에 들어갑니다.
              </p>
            </div>
          </div>

          <label className="flex items-start gap-3 text-[14px]">
            <input type="checkbox" className="mt-0.5 size-5 accent-[var(--color-ink)]" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="card-sms-consent" />
            <span>
              상대가 명함을 직접 건네며 연락에 동의했습니다. 광고·홍보 목적이 아니라 내 명함을 전달하는 1회성 문자입니다.
            </span>
          </label>

          {!preview.canSend && (
            <p className="rounded-2xl bg-[var(--color-butter)] px-4 py-3 text-[13px] text-[var(--color-ink)]">
              이 서버에는 문자 발송 게이트웨이(Solapi·Twilio)가 연결돼 있지 않아요. 보내기를 누르면 링크와 본문이 채워진 내 문자 앱이 열립니다.
            </p>
          )}

          <div className="flex gap-2">
            <button onClick={send} disabled={!consent || busy === "sending"} className="btn btn-signal btn-lg flex-1" data-testid="card-sms-send">
              <Icon name="message" size={19} /> {busy === "sending" ? "보내는 중…" : preview.canSend ? "문자 보내기" : "문자 앱으로 보내기"}
            </button>
            <button onClick={() => setStep("review")} className="btn btn-ghost btn-lg">뒤로</button>
          </div>
        </section>
      )}

      {step === "done" && sent && (
        <section className="space-y-4 animate-rise" aria-labelledby="done-h" data-confetti>
          <h2 id="done-h" className="text-[18px] font-semibold">
            {sent.status === "sent" ? "문자를 보냈어요" : "문자 앱에서 보내 주세요"}
          </h2>
          <div className="surface space-y-3 p-4">
            <p className="text-[14px]">
              {sent.toName ? `${sent.toName}님(` : ""}
              <span className="num">{sent.toPhone}</span>
              {sent.toName ? ")" : ""} · {KIND_LABEL[sent.kind] ?? sent.kind}
              {sent.withImage ? " · 명함 이미지 포함" : ""}
            </p>
            {sent.link && (
              <p className="break-all text-[13px] text-[var(--fg-mute)]">
                저장 링크 <span className="num">{sent.link.replace(/^https?:\/\//, "")}</span>
              </p>
            )}
            {sent.smsLink && sent.status !== "sent" && (
              <a href={sent.smsLink} className="btn btn-ink w-full" data-testid="card-sms-deeplink">
                <Icon name="message" size={18} /> 내 문자 앱 열기
              </a>
            )}
            <pre className="whitespace-pre-wrap rounded-2xl bg-[var(--bg-sunk)] p-3 text-[13px]">{sent.body}</pre>
          </div>
          <div className="flex gap-2">
            <button onClick={restart} className="btn btn-signal btn-lg flex-1">다음 명함 보내기</button>
            <Link href="/app/people" className="btn btn-ghost btn-lg">인맥 보기</Link>
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="space-y-2" aria-labelledby="hist-h">
          <h2 id="hist-h" className="eyebrow">보낸 문자 명함</h2>
          <ul className="space-y-2">
            {history.map((d) => (
              <li key={d.id} className="surface flex items-center justify-between gap-3 p-3 text-[13.5px]">
                <div className="min-w-0">
                  <p className="truncate font-semibold">
                    {d.toName ?? d.toPhone} <span className="font-normal text-[var(--fg-mute)]">· {STATUS_LABEL[d.status] ?? d.status}</span>
                  </p>
                  <p className="text-[12.5px] text-[var(--fg-mute)]">
                    {d.savedAt ? "연락처에 저장됨" : d.openedAt ? `링크 열어봄 (${d.openCount}회)` : "아직 열어보지 않음"}
                    {d.error ? ` · ${d.error}` : ""}
                  </p>
                </div>
                {d.link && (
                  <a href={d.link} target="_blank" rel="noopener noreferrer" className="btn btn-ghost !min-h-9 shrink-0 text-[13px]">
                    링크 보기
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
