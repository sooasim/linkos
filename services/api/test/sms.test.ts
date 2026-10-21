// X-009 문자 발송 게이트웨이. provider 가 없는 환경(이 저장소의 기본값)과 Solapi·Twilio 호출을 fetch 스텁으로 덮는다.
// DB 는 필요 없다 — 비용 기록은 실패해도 발송을 막지 않도록 호출부에서 삼킨다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSms, smsConfigured, smsProvider, solapiAuthHeader } from "../src/lib/sms";

const KEYS = ["SMS_PROVIDER", "SMS_SENDER_PHONE", "SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_BASE_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const;
let saved: Partial<Record<(typeof KEYS)[number], string | undefined>>;
const realFetch = globalThis.fetch;

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("설정 감지", () => {
  it("아무 키도 없으면 미설정이고, 보내려 해도 던지지 않고 sent=false 를 돌려준다", async () => {
    expect(smsProvider()).toBeNull();
    expect(smsConfigured()).toBe(false);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await sendSms("+821023456789", "hi");
    expect(r).toEqual({ sent: false, provider: null, messageId: null, withImage: false, reason: "not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled(); // 설정이 없으면 네트워크를 건드리지 않는다
  });

  it("키만 보고 provider 를 추론한다", () => {
    process.env.SOLAPI_API_KEY = "k";
    process.env.SOLAPI_API_SECRET = "s";
    expect(smsProvider()).toBe("solapi");
    expect(smsConfigured()).toBe(false); // 발신번호가 없으면 아직 보낼 수 없다
    process.env.SMS_SENDER_PHONE = "02-1234-5678";
    expect(smsConfigured()).toBe(true);
  });

  it("SMS_PROVIDER 가 키 추론보다 우선한다", () => {
    process.env.SOLAPI_API_KEY = "k";
    process.env.SOLAPI_API_SECRET = "s";
    process.env.SMS_PROVIDER = "twilio";
    expect(smsProvider()).toBe("twilio");
  });

  it("발신번호가 없으면 provider 가 있어도 보내지 않는다", async () => {
    process.env.SMS_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC1";
    process.env.TWILIO_AUTH_TOKEN = "t";
    const r = await sendSms("+821023456789", "hi");
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("no_sender");
  });
});

describe("Solapi HMAC 인증 헤더", () => {
  it("date·salt 로 서명하고 apiKey 를 평문으로 싣는다 (secret 은 나가지 않는다)", () => {
    const h = solapiAuthHeader("KEY1", "SECRET1", "2026-10-22T00:00:00.000Z", "abcd");
    expect(h).toMatch(/^HMAC-SHA256 apiKey=KEY1, date=2026-10-22T00:00:00\.000Z, salt=abcd, signature=[0-9a-f]{64}$/);
    expect(h).not.toContain("SECRET1");
  });

  it("같은 date·salt 면 같은 서명, 다르면 다른 서명이다", () => {
    const a = solapiAuthHeader("K", "S", "2026-10-22T00:00:00.000Z", "x");
    expect(solapiAuthHeader("K", "S", "2026-10-22T00:00:00.000Z", "x")).toBe(a);
    expect(solapiAuthHeader("K", "S", "2026-10-22T00:00:00.000Z", "y")).not.toBe(a);
  });
});

describe("Solapi 발송", () => {
  beforeEach(() => {
    process.env.SMS_PROVIDER = "solapi";
    process.env.SOLAPI_API_KEY = "k";
    process.env.SOLAPI_API_SECRET = "s";
    process.env.SMS_SENDER_PHONE = "02-1234-5678";
    process.env.SOLAPI_BASE_URL = "https://solapi.test";
  });

  it("90바이트를 넘는 본문은 LMS 로, E.164 수신번호는 국내 표기로 바꿔 보낸다", async () => {
    const calls: { url: string; body: any }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return json({ messageId: "M1" });
    }) as unknown as typeof fetch;
    const r = await sendSms("+821023456789", "가".repeat(60));
    expect(r).toMatchObject({ sent: true, provider: "solapi", messageId: "M1", withImage: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://solapi.test/messages/v4/send");
    expect(calls[0]!.body.message).toMatchObject({ to: "01023456789", from: "0212345678", type: "LMS" });
  });

  it("짧은 본문은 SMS 로 보낸다", async () => {
    let sentBody: any;
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      sentBody = JSON.parse(init.body);
      return json({ messageId: "M2" });
    }) as unknown as typeof fetch;
    await sendSms("+821023456789", "안녕하세요");
    expect(sentBody.message.type).toBe("SMS");
  });

  it("이미지는 먼저 올려 imageId 를 받고 MMS 로 보낸다", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      urls.push(String(url));
      if (String(url).includes("/storage/")) {
        expect(JSON.parse(init.body)).toMatchObject({ type: "MMS", file: Buffer.from("png").toString("base64") });
        return json({ fileId: "FILE1" });
      }
      expect(JSON.parse(init.body).message).toMatchObject({ imageId: "FILE1", type: "MMS" });
      return json({ messageId: "M3" });
    }) as unknown as typeof fetch;
    const r = await sendSms("+821023456789", "hi", { bytes: Buffer.from("png"), contentType: "image/png" });
    expect(urls).toEqual(["https://solapi.test/storage/v1/files", "https://solapi.test/messages/v4/send"]);
    expect(r).toMatchObject({ sent: true, withImage: true });
  });

  it("이미지 업로드가 실패하면 본문만 보내고 그 사실을 알린다 (발송 자체는 살린다)", async () => {
    globalThis.fetch = vi.fn(async (url: any) => (String(url).includes("/storage/") ? json({}, false, 413) : json({ messageId: "M4" }))) as unknown as typeof fetch;
    const r = await sendSms("+821023456789", "hi", { bytes: Buffer.from("png"), contentType: "image/png" });
    expect(r).toMatchObject({ sent: true, withImage: false, reason: "image_upload_failed" });
  });

  it("provider 가 거절하면 던진다 (호출자가 failed 로 남긴다)", async () => {
    globalThis.fetch = vi.fn(async () => json({ errorMessage: "발신번호 미등록" }, false, 400)) as unknown as typeof fetch;
    await expect(sendSms("+821023456789", "hi")).rejects.toThrow(/solapi_400.*발신번호 미등록/);
  });
});

describe("Twilio 발송", () => {
  beforeEach(() => {
    process.env.SMS_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC1";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.SMS_SENDER_PHONE = "+15550001111";
  });

  it("E.164 그대로 폼 인코딩으로 보내고 Basic 인증을 쓴다", async () => {
    let seen: { url: string; headers: any; body: string } | null = null;
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      seen = { url: String(url), headers: init.headers, body: init.body };
      return json({ sid: "SM1" });
    }) as unknown as typeof fetch;
    const r = await sendSms("+821023456789", "hello");
    expect(r).toMatchObject({ sent: true, provider: "twilio", messageId: "SM1" });
    expect(seen!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect(seen!.headers.authorization).toBe(`Basic ${Buffer.from("AC1:tok").toString("base64")}`);
    const form = new URLSearchParams(seen!.body);
    expect([form.get("To"), form.get("From"), form.get("Body")]).toEqual(["+821023456789", "+15550001111", "hello"]);
    expect(form.get("MediaUrl")).toBeNull();
  });

  it("공개 URL 이 있으면 MediaUrl 로 붙여 MMS 로 보낸다", async () => {
    let body = "";
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      body = init.body;
      return json({ sid: "SM2" });
    }) as unknown as typeof fetch;
    const r = await sendSms("+821023456789", "hi", { bytes: Buffer.from("png"), contentType: "image/png", publicUrl: "https://linkos.app/api/v1/files/x?exp=1&sig=a" });
    expect(new URLSearchParams(body).get("MediaUrl")).toBe("https://linkos.app/api/v1/files/x?exp=1&sig=a");
    expect(r.withImage).toBe(true);
  });

  it("공개 URL 을 만들 수 없으면(로컬 http) 본문만 보낸다", async () => {
    globalThis.fetch = vi.fn(async () => json({ sid: "SM3" })) as unknown as typeof fetch;
    const r = await sendSms("+821023456789", "hi", { bytes: Buffer.from("png"), contentType: "image/png", publicUrl: null });
    expect(r).toMatchObject({ sent: true, withImage: false, reason: "image_upload_failed" });
  });

  it("provider 오류는 그대로 올린다", async () => {
    globalThis.fetch = vi.fn(async () => json({ message: "unverified number" }, false, 400)) as unknown as typeof fetch;
    await expect(sendSms("+821023456789", "hi")).rejects.toThrow(/twilio_400.*unverified number/);
  });
});
