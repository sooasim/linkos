// X-009 문자 명함 전송 — 상대의 종이 명함을 촬영해, 거기서 읽은 번호로 내 명함(이미지 + 기본정보 + 저장 링크)을 문자로 보낸다.
// Pure functions only (no I/O). 본문에 들어가는 값은 전부 보내는 사람 본인의 Living Card 에서 오고, 없는 값은 만들지 않는다(§2.6).
import { type BgOp, displayUrl, estimateTextWidth, fitFontSize } from "./shareKit";

export type CardSmsLocale = "ko" | "en";

/** 국내 이동통신 기준: 단문(SMS) 90바이트, 장문(LMS)·그림(MMS) 2,000바이트 — EUC-KR 바이트로 센다. */
export const SMS_BYTE_LIMIT = 90;
export const LMS_BYTE_LIMIT = 2000;

/**
 * EUC-KR 기준 바이트 길이. 국내 통신사는 문자를 EUC-KR 로 세기 때문에 한글·한자·전각은 2바이트다.
 * BMP 밖 문자(이모지)는 EUC-KR 로 아예 표현되지 않아 통신사마다 처리가 다르므로, 가장 불리한 4바이트로 센다
 * (= 본문에 이모지를 넣으면 길이 경고가 먼저 뜬다).
 */
export function smsByteLength(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp > 0xffff ? 4 : 2;
  }
  return n;
}

export type SmsKind = "sms" | "lms" | "mms" | "too_long";

/** 길이(와 이미지 유무)로 결정되는 발송 종류. 사용자에게 "장문으로 갑니다"를 미리 보여주기 위한 값. */
export function smsKind(text: string, withImage = false): SmsKind {
  const bytes = smsByteLength(text);
  if (bytes > LMS_BYTE_LIMIT) return "too_long";
  if (withImage) return "mms";
  return bytes <= SMS_BYTE_LIMIT ? "sms" : "lms";
}

export interface CardSmsSender {
  name: string;
  company?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
}

export interface CardSmsTextOptions {
  /** 종이 명함에서 읽은 받는 사람 이름 — 있으면 첫 줄에서 부른다 */
  recipientName?: string | null;
  /** 만난 곳(Encounter) — 사용자가 적었을 때만 넣는다 */
  placeLabel?: string | null;
  /** 사용자가 직접 쓴 인사말 — 있으면 자동 인사말을 대신한다(지어낸 문장이 아니라 본인 문장) */
  note?: string | null;
  /** 명함 이미지가 함께 가는지(MMS) — 문구가 달라진다 */
  withImage?: boolean;
  locale?: CardSmsLocale;
}

const T = {
  ko: {
    head: (name: string) => `[명함] ${name}`,
    greetingPlace: (to: string | null, place: string) => (to ? `${to}님, ${place}에서 인사드렸습니다.` : `${place}에서 인사드렸습니다.`),
    greeting: (to: string | null) => (to ? `${to}님, 반갑습니다.` : "반갑습니다."),
    image: "제 명함 이미지를 함께 보냅니다.",
    save: (link: string) => `연락처 저장(구글 연락처·휴대폰 주소록): ${link}`,
  },
  en: {
    head: (name: string) => `[Card] ${name}`,
    greetingPlace: (to: string | null, place: string) => (to ? `${to}, great meeting you at ${place}.` : `Great meeting you at ${place}.`),
    greeting: (to: string | null) => (to ? `${to}, great to meet you.` : "Great to meet you."),
    image: "My card image is attached.",
    save: (link: string) => `Save to contacts (Google Contacts / phone): ${link}`,
  },
} as const satisfies Record<CardSmsLocale, Record<string, unknown>>;

/**
 * 문자 본문. 순서는 수신자가 훑는 순서 그대로 — 누가 보냈는지, 어디서 만났는지, 연락처, 저장 링크.
 * 전화·이메일은 **보내는 사람 본인의 카드에 있는 값만** 들어가고, 비어 있으면 그 줄 자체가 없다.
 */
export function buildCardSmsText(me: CardSmsSender, link: string, opts: CardSmsTextOptions = {}): string {
  const t = T[opts.locale ?? "ko"];
  const to = opts.recipientName?.trim() || null;
  const place = opts.placeLabel?.trim() || null;
  const note = opts.note?.trim() || null;
  const role = [me.jobTitle, me.company].filter((v) => v?.trim()).join(" · ");
  const lines = [
    t.head(me.name),
    note ?? (place ? t.greetingPlace(to, place) : t.greeting(to)),
    role || null,
    me.phone?.trim() || null,
    me.email?.trim() || null,
    me.website?.trim() || null,
    opts.withImage ? t.image : null,
    t.save(link),
  ];
  return lines.filter((l): l is string => Boolean(l)).join("\n");
}

/**
 * 사용자의 문자 앱을 본문이 채워진 상태로 여는 링크 — 발송 게이트웨이가 없을 때의 폴백.
 * `?&body=` 는 iOS(`&body=`)와 Android(`?body=`) 양쪽에서 동작하는 형태다.
 */
export function smsDeepLink(phone: string, body: string): string {
  return `sms:${phone.replace(/[^\d+]/g, "")}?&body=${encodeURIComponent(body)}`;
}

/** 구글 연락처(웹) — .vcf 를 내려받은 뒤 "가져오기"로 넣을 때 쓰는 입구. 자동 등록 링크는 존재하지 않는다. */
export const GOOGLE_CONTACTS_URL = "https://contacts.google.com/";

/** 다운로드 파일명. 한글 이름은 그대로 두면 기기마다 깨지므로 ASCII 가 없으면 고정 이름을 쓴다. */
export function vcardFileName(name: string): string {
  const ascii = name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${ascii.length >= 2 ? ascii.slice(0, 40) : "contact"}.vcf`;
}

// ---------------------------------------------------------------- 명함 이미지 (문자에 실어 보내는 PNG)

/** 문자 미리보기에서 잘리지 않는 가로형 비율(≈1.59:1, 실제 명함 90×55mm 과 비슷하다). */
export const CARD_IMG_WIDTH = 1080;
export const CARD_IMG_HEIGHT = 680;
export type CardImageStyle = "pastel" | "ink";

/**
 * 문자로 보낼 명함 이미지의 레이아웃(순수 계산). 그리기는 캔버스(클라이언트)가 한다 — X-002 가상 배경과 같은 구조.
 * 색은 Porcelain & Pastel 토큰 값을 리터럴로 적는다(PNG 에는 CSS 변수가 없다).
 */
export function cardImageLayout(me: CardSmsSender, link: string, style: CardImageStyle = "pastel", measure?: (t: string, s: number) => number): BgOp[] {
  const pastel = style === "pastel";
  const ink = pastel ? "#1B1B24" : "#F4F3FA";
  const mute = pastel ? "#6A6A7C" : "#A3A2B8";
  const accent = pastel ? "#5B4BD6" : "#B8ADFF";
  const ops: BgOp[] = [
    { kind: "fill", color: pastel ? "#FCFCFE" : "#0F0F17" },
    {
      kind: "gradient",
      x0: 0,
      y0: 0,
      x1: CARD_IMG_WIDTH,
      y1: CARD_IMG_HEIGHT,
      stops: pastel
        ? ([[0, "#ECE8FF"], [0.6, "#FCFCFE"], [1, "#DCF5EA"]] as [number, string][])
        : ([[0, "#1A1A28"], [1, "#0F0F17"]] as [number, string][]),
    },
    { kind: "blob", x: 980, y: 90, r: 300, color: pastel ? "rgba(253,230,239,0.9)" : "rgba(165,151,255,0.20)" },
    { kind: "blob", x: 110, y: 640, r: 260, color: pastel ? "rgba(220,235,255,0.9)" : "rgba(220,245,234,0.08)" },
  ];
  const left = 88;
  const maxW = CARD_IMG_WIDTH - left * 2;
  const nameSize = fitFontSize(me.name, 104, 52, maxW, measure);
  ops.push({ kind: "text", text: me.name, x: left, y: 236, size: nameSize, weight: 400, color: ink, font: "serif", align: "left" });
  let y = 236 + Math.round(nameSize * 0.52);
  const role = [me.jobTitle, me.company].filter((v) => v?.trim()).join(" · ");
  if (role) {
    const s = fitFontSize(role, 40, 22, maxW, measure);
    y += Math.round(s * 1.5);
    ops.push({ kind: "text", text: role, x: left, y, size: s, weight: 600, color: mute, font: "sans", align: "left" });
  }
  for (const value of [me.phone, me.email, me.website]) {
    const v = value?.trim();
    if (!v) continue;
    const s = fitFontSize(v, 34, 20, maxW, measure);
    y += Math.round(s * 1.6);
    ops.push({ kind: "text", text: v, x: left, y, size: s, weight: 400, color: ink, font: "sans", align: "left" });
  }
  const shown = displayUrl(link);
  ops.push({
    kind: "text",
    text: shown,
    x: left,
    y: CARD_IMG_HEIGHT - 76,
    size: fitFontSize(shown, 30, 18, maxW, measure),
    weight: 600,
    color: accent,
    font: "sans",
    align: "left",
  });
  return ops;
}

/** 글자가 카드 밖으로 나가지 않는지(테스트·회귀 방지용). 모든 텍스트 op 은 왼쪽 정렬이다. */
export function cardImageOverflows(ops: BgOp[]): boolean {
  return ops.some((op) => op.kind === "text" && (op.y > CARD_IMG_HEIGHT || op.y < 0 || op.x < 0 || op.x + estimateTextWidth(op.text, op.size) > CARD_IMG_WIDTH));
}
