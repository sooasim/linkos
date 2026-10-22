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

export type SmsProvider = "solapi" | "twilio" | "android_gateway";

export interface SmsSendResult {
  sent: boolean;
  provider: SmsProvider | null;
  messageId: string | null;
  /** 실제로 이미지가 함께 갔는지 — MMS 를 요청했어도 업로드가 실패하면 본문만 보내고 false 가 된다 */
  withImage: boolean;
  reason?: "not_configured" | "no_sender" | "image_upload_failed";
}

/**
 * 외부에 요청은 나갔지만 응답을 받지 못한 상태. **이미 상대 휴대폰에 도착했을 수 있으므로**
 * 호출자는 자동 재시도하지 않고 'uncertain' 으로 남겨 사용자가 자기 문자함을 보고 판단하게 한다.
 */
export class SmsUncertainError extends Error {
  readonly uncertain = true;
  constructor(message: string) {
    super(message);
    this.name = "SmsUncertainError";
  }
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

// ---------------------------------------------------------------- 사용자 본인 안드로이드 SIM (android-sms-gateway, Cloud)

/**
 * 공식 Cloud 엔드포인트 **고정**. 사용자가 URL 을 고를 수 없으므로 SSRF 경로가 생기지 않는다.
 * (Local/Private 서버를 쓰려면 사내망 주소를 받아야 하는데, 그건 임의 URL 로 POST 하는 길을 여는 것이므로
 *  별도 설계 — 허용 목록·사설망 차단 — 없이는 지원하지 않는다.)
 */
export const ANDROID_GATEWAY_ENDPOINT = "https://api.sms-gate.app/3rdparty/v1/message";

export interface AndroidGatewayCredentials {
  username: string;
  password: string;
}

/**
 * 사용자 폰의 공식 앱(capcom6/android-sms-gateway)이 자기 SIM 으로 보낸다. 서버는 1건 요청만 전달한다.
 * 2xx 는 **접수**일 뿐 통신사 발송·도착이 아니다. 응답을 못 받으면 SmsUncertainError 로 올려
 * 호출자가 재시도 대신 '불확실'로 남기게 한다(중복 발송 방지).
 */
export async function sendViaAndroidGateway(creds: AndroidGatewayCredentials, toE164: string, text: string): Promise<SmsSendResult> {
  const body = JSON.stringify({ textMessage: { text }, phoneNumbers: [toE164] });
  const auth = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
  let res: Response;
  try {
    res = await fetch(ANDROID_GATEWAY_ENDPOINT, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new SmsUncertainError(`안드로이드 게이트웨이와 통신하지 못했습니다(${(e as Error).name}). 요청이 접수됐을 수도 있으니 다시 보내기 전에 휴대폰 문자함을 확인하세요.`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`gateway_${res.status}: 게이트웨이 사용자명·비밀번호가 맞지 않거나 권한이 없습니다.`);
  if (res.status >= 500) throw new SmsUncertainError(`게이트웨이 서버 오류(HTTP ${res.status}). 접수 여부가 불확실하므로 휴대폰에서 확인한 뒤 판단하세요.`);
  if (!res.ok) throw new Error(`gateway_${res.status}: 게이트웨이가 요청을 거절했습니다. 휴대폰의 앱 상태(서비스 실행·권한·배터리 최적화 제외)를 확인하세요.`);
  const json = (await res.json().catch(() => null)) as { id?: string } | null;
  await recordCost(null, { jobType: "sms", provider: "android_gateway", rateKey: "sms.gateway", units: 1 }).catch(() => undefined);
  return { sent: true, provider: "android_gateway", messageId: json?.id ?? null, withImage: false };
}

/** 저장된 인증정보가 실제로 쓸 수 있는지 확인(발송 전 1회). 공식 API 의 상태 조회를 쓴다. */
export async function checkAndroidGateway(creds: AndroidGatewayCredentials): Promise<{ ok: boolean; status: number }> {
  const auth = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
  try {
    // 메시지 전송 엔드포인트와 같은 호스트의 조회 경로. 없는 id 를 물어 404/401 로 인증 여부만 가린다.
    const res = await fetch(`${ANDROID_GATEWAY_ENDPOINT}/00000000-0000-0000-0000-000000000000`, {
      method: "GET",
      headers: { authorization: auth },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.status !== 401 && res.status !== 403, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
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
