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

export type SmsPlatform = "ios" | "android" | "unknown";

/**
 * 사용자의 문자 앱을 본문이 채워진 상태로 여는 링크 — 발송 게이트웨이가 없을 때의 폴백.
 * 구분자는 플랫폼마다 다르다: iOS 는 `&body=`, Android 는 `?body=`. 어느 쪽인지 모르면 양쪽에서
 * 동작하는 `?&body=` 를 쓴다.
 *
 * **본문이 반드시 채워진다는 보장은 없다.** Apple 의 `sms:` 공식 문서는 본문 포함을 규정하지 않아
 * iOS 버전·브라우저마다 동작이 갈린다 — 그래서 화면은 항상 "본문 복사"를 함께 제공하고,
 * 문자 앱이 열린 것을 발송 성공으로 기록하지 않는다.
 */
export function smsDeepLink(phone: string, body: string, platform: SmsPlatform = "unknown"): string {
  const sep = platform === "ios" ? "&" : platform === "android" ? "?" : "?&";
  return `sms:${phone.replace(/[^\d+]/g, "")}${sep}body=${encodeURIComponent(body)}`;
}

/** User-Agent → 문자 URI 구분자 판단에 쓰는 플랫폼. 문자 앱이 없는 데스크톱도 구분한다. */
export function smsPlatform(userAgent: string | null | undefined): SmsPlatform {
  const ua = userAgent ?? "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "unknown";
}

export function hasSmsApp(userAgent: string | null | undefined): boolean {
  return /Android|iPhone|iPad|iPod/i.test(userAgent ?? "");
}

/** 기록·목록에 보여 줄 부분 마스킹(앞 3자리 + 뒤 4자리). 전체 번호는 재발송에 필요한 곳에서만 쓴다. */
export function maskPhone(e164OrLocal: string): string {
  const d = e164OrLocal.replace(/[^\d]/g, "");
  const national = d.startsWith("82") ? `0${d.slice(2)}` : d;
  if (national.length < 7) return "***";
  return `${national.slice(0, 3)}-****-${national.slice(-4)}`;
}

/**
 * 한국 번호인데 휴대폰(01x)이 아니면 알려 준다. **차단하지는 않는다** — 해외 번호도 보낼 수 있고,
 * 명함의 대표번호로 문자를 보내려는 경우도 있다. 다만 유선번호는 문자가 도착하지 않는 일이 흔하다.
 */
export function phoneDeliveryWarning(e164: string): string | null {
  if (!e164.startsWith("+82")) return null;
  const national = e164.slice(3);
  if (/^1[0-9]\d{7,8}$/.test(national)) return null; // 10/11 → 휴대폰
  return "휴대폰 번호가 아닐 수 있어요(유선번호로는 문자가 도착하지 않는 경우가 많습니다). 번호를 다시 확인해 주세요.";
}

// ---------------------------------------------------------------- 발송 남용 방지 (순수 판정)

/** 연속 발송 최소 간격 — 손이 미끄러져 두 번 누르거나 자동화로 쏟아붓는 것을 막는다. */
export const SEND_MIN_INTERVAL_SEC = 30;
/** 채널별 1일 상한. 명함 교환은 하루 수십 건이 현실적인 상한이다. */
export const SEND_DAILY_LIMIT = 20;
/** 같은 상대에게 다시 보내기 전 기다리는 시간. "보냈는지 모르겠다"는 상태도 중복으로 본다. */
export const SEND_DEDUPE_HOURS = 24;

export interface SendHistory {
  /** 같은 채널의 최근 발송 시각 (없으면 null) */
  lastSentAt?: Date | string | null;
  /** 같은 채널의 최근 24시간 발송 건수 */
  dailyCount: number;
  /** 같은 상대(번호 해시)에게 최근 SEND_DEDUPE_HOURS 안에 보냈거나 결과를 모르는 건이 있는지 */
  recentSameRecipient?: boolean;
}

export type SendBlock =
  | { ok: true }
  | { ok: false; code: "too_soon"; retryAfterSec: number; message: string }
  | { ok: false; code: "daily_limit"; message: string }
  | { ok: false; code: "duplicate_recipient"; message: string };

/**
 * 보내도 되는지 판정한다(DB 조회 결과를 받아 계산만 한다 — 그래서 단위테스트가 가능하다).
 * 시간당 rate limit 과는 별개의 층이다: 이쪽은 "같은 사람에게 두 번" 같은 사람 기준 사고를 막는다.
 */
export function sendGuard(h: SendHistory, now: Date = new Date()): SendBlock {
  if (h.recentSameRecipient) {
    return { ok: false, code: "duplicate_recipient", message: `최근 ${SEND_DEDUPE_HOURS}시간 안에 같은 번호로 보낸(또는 결과를 확인하지 못한) 내역이 있어 중복 발송을 막았습니다.` };
  }
  if (h.dailyCount >= SEND_DAILY_LIMIT) {
    return { ok: false, code: "daily_limit", message: `하루 ${SEND_DAILY_LIMIT}건 발송 제한을 넘었습니다. 내일 다시 보낼 수 있어요.` };
  }
  if (h.lastSentAt) {
    const elapsed = (now.getTime() - new Date(h.lastSentAt).getTime()) / 1000;
    if (elapsed < SEND_MIN_INTERVAL_SEC) {
      return { ok: false, code: "too_soon", retryAfterSec: Math.max(1, Math.ceil(SEND_MIN_INTERVAL_SEC - elapsed)), message: `연속 발송을 막기 위해 ${Math.max(1, Math.ceil(SEND_MIN_INTERVAL_SEC - elapsed))}초 뒤에 다시 시도해 주세요.` };
    }
  }
  return { ok: true };
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
