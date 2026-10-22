"use client";
// X-009 문자명함 전송.
//  1) 상대의 종이 명함을 촬영한다 → 기기에서 OCR·구조화(F-010/F-016, /app/scan 과 같은 파서)
//     번호를 못 읽으면 "사진을 서버로 보내 다시 읽기"를 제안한다(명시 동의 필요, 설정된 서버에서만)
//  2) 번호와 이름을 확인한다 (틀린 값은 고친다 — OCR 원문에 없는 값은 만들지 않는다)
//  3) 내 명함 이미지를 캔버스로 그려 올리고, 보낼 문자 본문을 미리 본다
//  4) 보낼 길을 고른다: 내 안드로이드 폰(본인 번호) · 상용 API · 내 문자 앱
//  5) "문자 보내기"를 **직접** 누를 때만 발송한다(§2.8). 어떤 결말도 "상대가 받았다"는 뜻은 아니다.
import {
  CARD_IMG_HEIGHT,
  CARD_IMG_WIDTH,
  type CardImageStyle,
  type CardSmsSender,
  type SmsPlatform,
  buildCardSmsText,
  cardImageLayout,
  hasSmsApp,
  smsByteLength,
  smsKind,
  smsPlatform,
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
  sent: "접수됨",
  uncertain: "접수 여부 불확실",
  failed: "실패",
  manual: "문자 앱으로 넘김",
  cancelled: "취소",
};

type Channel = "gateway" | "provider" | "device";
const CHANNEL_LABEL: Record<Channel, string> = { gateway: "내 안드로이드 폰", provider: "문자 발송 API", device: "내 문자 앱" };
const CHANNEL_NOTE: Record<Channel, string> = {
  gateway: "내 번호에서 보냅니다. 내 요금제에서 문자 요금이 빠져요.",
  provider: "사전등록된 서비스 발신번호로 보냅니다. 건당 요금이 듭니다.",
  device: "본문이 채워진 내 문자 앱이 열립니다. 전송 버튼은 직접 눌러야 해요.",
};

interface Preview {
  profileId: string;
  sender: CardSmsSender;
  cardUrl: string;
  provider: string | null;
  gateway: { connected: boolean; label?: string | null; lastError?: string | null };
  channels: Channel[];
  serverOcr: boolean;
}

interface Delivery {
  id: string;
  toName: string | null;
  toPhone: string | null;
  toPhoneMasked: string;
  body: string | null;
  kind: string;
  channel: string | null;
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
  deliveryWarning?: string | null;
}

const blankCard = () => Object.fromEntries(CARD_KEYS.map((k) => [k, ""])) as Record<CardKey, string>;

export function CardSmsFlow() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [step, setStep] = useState<"scan" | "review" | "compose" | "done">("scan");
  const [platform, setPlatform] = useState<SmsPlatform>("unknown");
  const [onPhone, setOnPhone] = useState(true);
  const [initial, setInitial] = useState<Record<CardKey, string>>(blankCard());
  const [conf, setConf] = useState<Partial<Record<CardKey, number>>>({});
  const [reviewed, setReviewed] = useState<ReviewedCard | null>(null);
  const [businessCardId, setBusinessCardId] = useState<string | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [engine, setEngine] = useState<string>("기기");
  const [place, setPlace] = useState("");
  const [note, setNote] = useState("");
  const [style, setStyle] = useState<CardImageStyle>("pastel");
  const [withImage, setWithImage] = useState(true);
  const [saveContact, setSaveContact] = useState(true);
  const [consent, setConsent] = useState(false);
  const [channel, setChannel] = useState<Channel>("device");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [sent, setSent] = useState<Delivery | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [history, setHistory] = useState<Delivery[]>([]);
  const [gwOpen, setGwOpen] = useState(false);
  const [gwUser, setGwUser] = useState("");
  const [gwPass, setGwPass] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);

  const loadHistory = useCallback(() => {
    api<{ deliveries: Delivery[] }>("/card-sms").then((r) => setHistory(r.deliveries)).catch(() => undefined);
  }, []);

  const loadPreview = useCallback(() => {
    api<Preview>("/card-sms?preview=1")
      .then((p) => {
        setPreview(p);
        setChannel(p.channels[0] ?? "device");
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    setPlatform(smsPlatform(navigator.userAgent));
    setOnPhone(hasSmsApp(navigator.userAgent));
    loadPreview();
    loadHistory();
  }, [loadPreview, loadHistory]);

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

  const applyFields = (fields: { key: string; value: string; confidence: number }[]) => {
    const { card, conf } = initialFromParsed(fields);
    setInitial(card);
    setConf(conf);
    return card;
  };

  const onLines = async (lines: OcrLineOut[], _p: string, extra?: ScanExtra) => {
    setError(null);
    setPhoto(extra?.jpeg ?? null);
    try {
      const job = await api<{ id: string | null; fields: { key: string; value: string; confidence: number }[] }>("/capture/cards", {
        body: { side: "front", kind: "card", engine: "tesseract.js", lines },
        offline: false,
      });
      setBusinessCardId(job.id);
      setEngine("기기");
      const card = applyFields(job.fields);
      setStep("review");
      if (!card.phone) {
        setNotice(
          preview?.serverOcr && extra?.jpeg
            ? "이 사진에서 전화번호를 찾지 못했어요. 번호를 직접 입력하거나, 아래 ‘서버에서 다시 읽기’를 써 보세요."
            : "이 사진에서 전화번호를 찾지 못했어요. 번호를 직접 입력해 주세요.",
        );
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 기기 OCR 이 실패했을 때의 두 번째 시도 — 사진이 서버로 올라간다는 동의를 버튼 문구에 명시한다. */
  const retryOnServer = async () => {
    if (!photo) return;
    setBusy("ocr");
    setError(null);
    setNotice(null);
    try {
      const job = await upload<{ id: string; fields: { key: string; value: string; confidence: number }[]; engine: string }>(
        "/capture/ocr?consent=1",
        photo,
        { filename: "card.jpg", idempotencyKey: uid() },
      );
      setBusinessCardId(job.id);
      setEngine("서버");
      const card = applyFields(job.fields);
      setNotice(card.phone ? "서버에서 다시 읽었어요. 번호가 맞는지 꼭 확인해 주세요." : "서버에서도 전화번호를 찾지 못했어요. 직접 입력해 주세요.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const manual = () => {
    setInitial(blankCard());
    setConf({});
    setBusinessCardId(null);
    setPhoto(null);
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

  const copy = async (what: "body" | "phone", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("복사가 지원되지 않는 환경이에요. 아래 본문을 직접 선택해 복사해 주세요.");
    }
  };

  const send = async () => {
    if (!reviewed) return;
    setBusy("sending");
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      // 그림문자는 상용 API 경로에서만 보낼 수 있다(내 폰 게이트웨이·문자 앱은 본문만).
      const imageUseful = withImage && channel === "provider";
      let imageObjectId: string | null = null;
      if (imageUseful) {
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
          platform,
          consent: "card_handed",
        },
      });
      if (draft.deliveryWarning) setWarning(draft.deliveryWarning);
      const result = await api<Delivery & { gateway: boolean; uncertain?: boolean; imageDropped?: boolean }>(`/card-sms/${draft.id}/send`, {
        idempotencyKey: uid(),
        body: { approved: true, via: channel, platform },
      });
      setSent(result);
      if (result.status === "manual") {
        setNotice("문자 앱을 열어 전송 버튼을 직접 눌러 주세요. 본문이 비어 있으면 아래 ‘본문 복사’를 쓰세요.");
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

  const connectGateway = async () => {
    setBusy("gateway");
    setError(null);
    try {
      const r = await api<{ message: string }>("/card-sms/gateway", { method: "PUT", body: { username: gwUser.trim(), password: gwPass, label: null } });
      setGwPass("");
      setNotice(r.message);
      loadPreview();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const disconnectGateway = async () => {
    setBusy("gateway");
    try {
      await api("/card-sms/gateway", { method: "DELETE" });
      setNotice("내 폰 연결을 끊었어요.");
      loadPreview();
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
    setPhoto(null);
    setPlace("");
    setNote("");
    setConsent(false);
    setSent(null);
    setNotice(null);
    setWarning(null);
    setError(null);
  };

  // 미리보기는 서버가 쓰는 것과 **같은 도메인 함수**로 만든다(문구가 갈라지지 않게).
  // 저장 링크는 발송 요청에서 처음 만들어지므로 자리표시자를 넣고, 길이는 실제 토큰 길이로 보정한다.
  const imageGoesOut = withImage && channel === "provider";
  const bodyPreview =
    preview && reviewed
      ? buildCardSmsText(preview.sender, LINK_PLACEHOLDER, {
          recipientName: reviewed.card.fullName || null,
          placeLabel: place || null,
          note: note || null,
          withImage: imageGoesOut,
          locale: "ko",
        })
      : "";
  const bytes = smsByteLength(bodyPreview);
  const kind = smsKind(bodyPreview, imageGoesOut);

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
          <p className="text-[14px] text-[var(--fg-mute)]">
            문자는 여기 적힌 번호로 갑니다. 흐리게 찍힌 숫자는 꼭 눈으로 확인해 주세요. ({engine} 인식)
          </p>
          <ReviewFields key={JSON.stringify(initial)} initial={initial} confidence={conf} threshold={0.75} onChange={setReviewed} />
          {preview?.serverOcr && photo && (
            <button type="button" onClick={retryOnServer} disabled={busy === "ocr"} className="btn btn-ghost w-full" data-testid="card-sms-server-ocr">
              <Icon name="scan" size={18} /> {busy === "ocr" ? "서버에서 읽는 중…" : "서버에서 다시 읽기 (사진이 서버·외부 OCR로 전송됩니다)"}
            </button>
          )}
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

            {/* 보낼 길 — 받는 사람에게 보이는 발신번호가 달라지므로 사용자가 고른다 */}
            <fieldset>
              <legend className="label">보낼 방법</legend>
              <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label="보낼 방법">
                {preview.channels.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={channel === c} onClick={() => setChannel(c)} className={`chip ${channel === c ? "!bg-[var(--accent-soft)] !text-[var(--accent-text)]" : ""}`} data-testid={`card-sms-channel-${c}`}>
                    {CHANNEL_LABEL[c]}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[12.5px] text-[var(--fg-mute)]">{CHANNEL_NOTE[channel]}</p>
            </fieldset>

            <label className="flex items-center gap-3 text-[15px]">
              <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={withImage} onChange={(e) => setWithImage(e.target.checked)} data-testid="card-sms-with-image" />
              내 명함 이미지 함께 보내기 (그림문자)
            </label>
            {withImage && channel !== "provider" && (
              <p className="text-[12.5px] text-[var(--fg-mute)]">
                {CHANNEL_LABEL[channel]} 경로는 이미지를 함께 보낼 수 없어요. 본문만 가고, 상대가 링크를 열면 명함 이미지가 보입니다.
              </p>
            )}
            {imageGoesOut && (
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
            <span>상대가 명함을 직접 건네며 연락에 동의했습니다. 광고·홍보 목적이 아니라 내 명함을 전달하는 1회성 문자입니다.</span>
          </label>

          {channel === "device" && !onPhone && (
            <p className="rounded-2xl bg-[var(--color-butter)] px-4 py-3 text-[13px] text-[var(--color-ink)]">
              데스크톱에는 문자 앱이 없을 수 있어요. 휴대전화에서 이 페이지를 열면 바로 보낼 수 있습니다.
            </p>
          )}
          {warning && <p role="status" className="rounded-2xl bg-[var(--color-butter)] px-4 py-3 text-[13px] text-[var(--color-ink)]">{warning}</p>}

          <div className="flex gap-2">
            <button onClick={send} disabled={!consent || busy === "sending"} className="btn btn-signal btn-lg flex-1" data-testid="card-sms-send">
              <Icon name="message" size={19} /> {busy === "sending" ? "보내는 중…" : channel === "device" ? "문자 앱 열기" : "문자 보내기"}
            </button>
            <button onClick={() => setStep("review")} className="btn btn-ghost btn-lg">뒤로</button>
          </div>
        </section>
      )}

      {step === "done" && sent && (
        <section className="space-y-4 animate-rise" aria-labelledby="done-h" data-confetti>
          <h2 id="done-h" className="text-[18px] font-semibold">
            {sent.status === "sent" ? "문자를 접수했어요" : sent.status === "uncertain" ? "접수 여부를 확인해 주세요" : "문자 앱에서 보내 주세요"}
          </h2>
          <div className="surface space-y-3 p-4">
            <p className="text-[14px]">
              {sent.toName ? `${sent.toName}님(` : ""}
              <span className="num">{sent.toPhone ?? sent.toPhoneMasked}</span>
              {sent.toName ? ")" : ""} · {KIND_LABEL[sent.kind] ?? sent.kind}
              {sent.channel ? ` · ${CHANNEL_LABEL[sent.channel as Channel] ?? sent.channel}` : ""}
              {sent.withImage ? " · 명함 이미지 포함" : ""}
            </p>
            <p className="text-[12.5px] text-[var(--fg-mute)]">
              {sent.status === "sent"
                ? "접수는 통신사 발송·도착을 보장하지 않습니다. 상대가 링크를 열면 아래 목록의 상태가 바뀝니다."
                : sent.status === "uncertain"
                  ? "요청은 나갔지만 응답을 받지 못했어요. 이미 도착했을 수 있으니 휴대폰 문자함을 먼저 확인하고, 안 갔다면 다시 만들어 보내세요."
                  : "문자 앱이 열린 것은 발송이 아닙니다. 전송 버튼을 직접 눌러 주세요."}
            </p>
            {sent.link && (
              <p className="break-all text-[13px] text-[var(--fg-mute)]">
                저장 링크 <span className="num">{sent.link.replace(/^https?:\/\//, "")}</span>
              </p>
            )}
            {sent.smsLink && sent.status === "manual" && (
              <a href={sent.smsLink} className="btn btn-ink w-full" data-testid="card-sms-deeplink">
                <Icon name="message" size={18} /> 내 문자 앱 열기
              </a>
            )}
            {sent.body && (
              <>
                <pre className="whitespace-pre-wrap rounded-2xl bg-[var(--bg-sunk)] p-3 text-[13px]" data-testid="card-sms-sent-body">{sent.body}</pre>
                {/* 본문 자동 입력은 iOS 에서 보장되지 않는다 — 항상 복사 폴백을 둔다 */}
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => copy("body", sent.body!)} className="btn btn-ghost" data-testid="card-sms-copy-body">
                    <Icon name="copy" size={18} /> {copied === "body" ? "복사했어요" : "본문 복사"}
                  </button>
                  <button type="button" onClick={() => copy("phone", sent.toPhone ?? "")} disabled={!sent.toPhone} className="btn btn-ghost" data-testid="card-sms-copy-phone">
                    <Icon name="copy" size={18} /> {copied === "phone" ? "복사했어요" : "번호 복사"}
                  </button>
                </div>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={restart} className="btn btn-signal btn-lg flex-1">다음 명함 보내기</button>
            <Link href="/app/people" className="btn btn-ghost btn-lg">인맥 보기</Link>
          </div>
        </section>
      )}

      {/* 내 폰으로 보내기 설정 — 상용 API 가 없어도 본인 번호로 보낼 수 있는 길 */}
      {preview && (
        <details className="surface p-4" open={gwOpen} onToggle={(e) => setGwOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer text-[15px] font-semibold">
            내 안드로이드 폰으로 보내기 {preview.gateway.connected ? <span className="text-[13px] font-normal text-[var(--fg-mute)]">· 연결됨</span> : <span className="text-[13px] font-normal text-[var(--fg-mute)]">· 연결 안 됨</span>}
          </summary>
          <div className="mt-3 space-y-3 text-[13.5px]">
            <p className="text-[var(--fg-mute)]">
              안드로이드 폰에 공식 <a href="https://github.com/capcom6/android-sms-gateway" target="_blank" rel="noopener noreferrer" className="underline">Android SMS Gateway</a> 앱을 설치하고 Cloud Server 모드를 켜면, 거기 표시된 사용자명·비밀번호로 <b>내 번호에서</b> 문자를 보낼 수 있어요. 앱은 공식 배포본을 직접 설치하세요 — 이 서비스는 앱을 포함하지 않습니다.
            </p>
            {preview.gateway.connected ? (
              <>
                <p>인증정보가 암호화되어 저장돼 있습니다{preview.gateway.label ? ` (${preview.gateway.label})` : ""}. 실제 발송은 휴대폰 앱이 실행 중이고 네트워크가 연결된 동안에만 성공합니다.</p>
                {preview.gateway.lastError && <p className="text-[var(--color-ember)]">최근 오류: {preview.gateway.lastError}</p>}
                <button type="button" onClick={disconnectGateway} disabled={busy === "gateway"} className="btn btn-ghost">연결 끊기</button>
              </>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <label>
                  <span className="label">API Username</span>
                  <input className="field" value={gwUser} onChange={(e) => setGwUser(e.target.value)} autoComplete="off" />
                </label>
                <label>
                  <span className="label">API Password</span>
                  <input className="field" type="password" value={gwPass} onChange={(e) => setGwPass(e.target.value)} autoComplete="new-password" />
                </label>
                <button type="button" onClick={connectGateway} disabled={!gwUser.trim() || !gwPass || busy === "gateway"} className="btn btn-ink sm:col-span-2" data-testid="card-sms-gateway-save">
                  {busy === "gateway" ? "확인 중…" : "연결하고 확인"}
                </button>
              </div>
            )}
          </div>
        </details>
      )}

      {history.length > 0 && (
        <section className="space-y-2" aria-labelledby="hist-h">
          <h2 id="hist-h" className="eyebrow">보낸 문자 명함</h2>
          <ul className="space-y-2">
            {history.map((d) => (
              <li key={d.id} className="surface flex items-center justify-between gap-3 p-3 text-[13.5px]">
                <div className="min-w-0">
                  <p className="truncate font-semibold">
                    {d.toName ?? <span className="num">{d.toPhoneMasked}</span>} <span className="font-normal text-[var(--fg-mute)]">· {STATUS_LABEL[d.status] ?? d.status}</span>
                  </p>
                  <p className="text-[12.5px] text-[var(--fg-mute)]">
                    <span className="num">{d.toPhoneMasked}</span> · {d.savedAt ? "연락처에 저장됨" : d.openedAt ? `링크 열어봄 (${d.openCount}회)` : "아직 열어보지 않음"}
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
