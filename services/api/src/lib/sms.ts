// X-009 문자 발송 게이트웨이. 국내(Solapi)·해외(Twilio) 두 provider 와, **아무것도 설정되지 않은 환경**을 똑같이 다룬다.
// 설정이 없으면 던지지 않고 `{ sent: false, reason: "not_configured" }` 를 돌려주고, 호출자는 사용자의 문자 앱을 여는
// 딥링크로 넘긴다(CLAUDE.md §2.3 사다리와 같은 생각 — 보낼 수 없으면 더 낮은 수단으로 내려가되 거짓말하지 않는다).
//
// 환경변수
//   SMS_PROVIDER      solapi | twilio   (없으면 키로 추론, 그래도 없으면 미설정)
//   SMS_SENDER_PHONE  발신번호 (국내는 사전등록 번호여야 한다)
//   SOLAPI_API_KEY / SOLAPI_API_SECRET
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
import { createHmac, randomBytes } from "node:crypto";
import { recordCost } from "./metering";
import { log } from "./platform";

export type SmsProvider = "solapi" | "twilio";

export interface SmsSendResult {
  sent: boolean;
  provider: SmsProvider | null;
  messageId: string | null;
  /** 실제로 이미지가 함께 갔는지 — MMS 를 요청했어도 업로드가 실패하면 본문만 보내고 false 가 된다 */
  withImage: boolean;
  reason?: "not_configured" | "no_sender" | "image_upload_failed";
}

export interface SmsImage {
  bytes: Buffer;
  contentType: string;
  /** Twilio 가 직접 가져갈 수 있는 절대 URL (짧은 서명 URL). 로컬/사설망이면 생략한다. */
  publicUrl?: string | null;
}

export function smsProvider(): SmsProvider | null {
  const v = (process.env.SMS_PROVIDER ?? "").trim().toLowerCase();
  if (v === "solapi" || v === "twilio") return v;
  if (process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET) return "solapi";
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) return "twilio";
  return null;
}

export function smsSender(): string | null {
  const v = (process.env.SMS_SENDER_PHONE ?? "").replace(/[^\d+]/g, "");
  return v.length >= 8 ? v : null;
}

/** 발송 가능 여부 — 화면에서 "문자로 바로 보내기" 버튼을 보여줄지 결정한다. */
export function smsConfigured(): boolean {
  const p = smsProvider();
  if (!p) return false;
  if (p === "solapi") return Boolean(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET && smsSender());
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && smsSender());
}

// ---------------------------------------------------------------- Solapi (국내 SMS/LMS/MMS)

/** Solapi HMAC 인증 헤더: `HMAC-SHA256 apiKey=…, date=…, salt=…, signature=HMAC(date+salt, secret)`. */
export function solapiAuthHeader(apiKey: string, apiSecret: string, date = new Date().toISOString(), salt = randomBytes(16).toString("hex")): string {
  const signature = createHmac("sha256", apiSecret).update(date + salt).digest("hex");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

const SOLAPI_BASE = () => (process.env.SOLAPI_BASE_URL ?? "https://api.solapi.com").replace(/\/$/, "");

/** 그림문자(MMS)는 먼저 이미지를 Solapi 스토리지에 올려 fileId 를 받아야 한다. 실패해도 본문 발송은 계속한다. */
async function solapiUploadImage(auth: string, image: SmsImage): Promise<string | null> {
  const res = await fetch(`${SOLAPI_BASE()}/storage/v1/files`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ file: image.bytes.toString("base64"), name: "card.jpg", type: "MMS" }),
  });
  if (!res.ok) {
    log("warn", "sms.image_upload_failed", { provider: "solapi", status: res.status });
    return null;
  }
  const body = (await res.json().catch(() => null)) as { fileId?: string } | null;
  return body?.fileId ?? null;
}

async function solapiSend(to: string, text: string, image: SmsImage | null): Promise<SmsSendResult> {
  const apiKey = process.env.SOLAPI_API_KEY!;
  const apiSecret = process.env.SOLAPI_API_SECRET!;
  const from = smsSender()!;
  const auth = solapiAuthHeader(apiKey, apiSecret);
  const imageId = image ? await solapiUploadImage(auth, image) : null;
  // type 은 생략하면 Solapi 가 길이/첨부로 판단하지만, 과금이 달라지는 값이라 명시한다.
  const message: Record<string, unknown> = { to: to.replace(/^\+82/, "0").replace(/[^\d]/g, ""), from, text, type: imageId ? "MMS" : Buffer.byteLength(text, "utf8") > 90 ? "LMS" : "SMS" };
  if (imageId) message.imageId = imageId;
  const res = await fetch(`${SOLAPI_BASE()}/messages/v4/send`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const body = (await res.json().catch(() => null)) as { messageId?: string; statusMessage?: string; errorMessage?: string } | null;
  if (!res.ok) throw new Error(`solapi_${res.status}: ${body?.errorMessage ?? body?.statusMessage ?? "send failed"}`);
  return { sent: true, provider: "solapi", messageId: body?.messageId ?? null, withImage: Boolean(imageId), reason: image && !imageId ? "image_upload_failed" : undefined };
}

// ---------------------------------------------------------------- Twilio (해외 SMS/MMS)

async function twilioSend(to: string, text: string, image: SmsImage | null): Promise<SmsSendResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const form = new URLSearchParams({ To: to, From: smsSender()!, Body: text });
  // Twilio 는 발송 시점에 미디어 URL 을 직접 가져간다 — 공개 URL 이 없으면 본문만 보낸다.
  if (image?.publicUrl) form.append("MediaUrl", image.publicUrl);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => null)) as { sid?: string; message?: string } | null;
  if (!res.ok) throw new Error(`twilio_${res.status}: ${body?.message ?? "send failed"}`);
  return { sent: true, provider: "twilio", messageId: body?.sid ?? null, withImage: Boolean(image?.publicUrl), reason: image && !image.publicUrl ? "image_upload_failed" : undefined };
}

/**
 * 문자 1건 발송. 설정이 없으면 예외 대신 `sent: false` 를 돌려준다 — 호출자가 문자 앱 딥링크로 내려갈 수 있어야 한다.
 * provider 가 거절하면(잘못된 발신번호, 잔액 부족 …) 예외를 던지고 호출자가 상태를 failed 로 남긴다.
 */
export async function sendSms(to: string, text: string, image: SmsImage | null = null): Promise<SmsSendResult> {
  const provider = smsProvider();
  if (!provider) return { sent: false, provider: null, messageId: null, withImage: false, reason: "not_configured" };
  if (!smsSender()) return { sent: false, provider, messageId: null, withImage: false, reason: "no_sender" };
  const r = provider === "solapi" ? await solapiSend(to, text, image) : await twilioSend(to, text, image);
  // F-187 비용 기록: 그림문자는 단가가 다르므로 종류를 rateKey 로 나눈다.
  await recordCost(null, { jobType: "sms", provider, rateKey: r.withImage ? "sms.mms" : "sms.message", units: 1 }).catch(() => undefined);
  return r;
}
