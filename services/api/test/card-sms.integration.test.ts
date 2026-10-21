// X-009 문자명함 전송 integration (real PostgreSQL). Env: DATABASE_URL (default linkos_test_sms).
// 덮는 것: 동의 없이는 초안도 안 만들어진다 · 본문·이미지·vCard 에 business audience 밖 필드가 안 나간다 ·
// 게이트웨이 없으면 manual 로 내려간다 · 승인 1회 = 발송 1회 · 수신자는 로그인 없이 열고 저장한다 ·
// 토큰은 평문으로 저장되지 않는다 · 만료·취소·남의 발송 접근.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_sms";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";
process.env.OBJECT_STORAGE_LOCAL_DIR ??= mkdtempSync(join(tmpdir(), "linkos-cardsms-"));
delete process.env.OBJECT_STORAGE_DRIVER;
delete process.env.OBJECT_STORAGE_BUCKET;
for (const k of ["SMS_PROVIDER", "SMS_SENDER_PHONE", "SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_BASE_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]) delete process.env[k];

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { cardSms, card, identity, relationship, closePool, q, one } = api;

const ctx = (userId: string | null, ip = "10.9.0.7") => ({ userId, ip, userAgent: "test", requestId: "t" });
/** 라우트가 하는 것과 같은 검증을 거쳐 입력을 만든다 (route() → parse(cardSms.prepareInput, body)). */
const prep = (input: unknown) => cardSms.prepareInput.parse(input);
const consents = ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true }));
const base = { company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [], theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [] };
// 1×1 PNG — sniffType 가 image/png 로 인식하는 최소 유효 파일
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const realFetch = globalThis.fetch;

const stamp = Date.now();
let n = 0;
async function user(prefix: string) {
  const email = `${prefix}${stamp}-${n++}@cardsms.test`;
  const { devCode } = await identity.requestOtp(ctx(null), email);
  return (await identity.verifyOtp(ctx(null), email, devCode!, consents)).user;
}

/** Solapi 를 켜고 응답을 가로챈다. 돌려받은 배열에 실제로 나간 요청이 쌓인다. */
function withSolapi(): { url: string; body: any }[] {
  process.env.SMS_PROVIDER = "solapi";
  process.env.SOLAPI_API_KEY = "k";
  process.env.SOLAPI_API_SECRET = "s";
  process.env.SMS_SENDER_PHONE = "02-1234-5678";
  process.env.SOLAPI_BASE_URL = "https://solapi.test";
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => (String(url).includes("/storage/") ? { fileId: "FILE1" } : { messageId: "SOLAPI-1" }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

let owner: { id: string };
let profileId: string;
let slug: string;

beforeAll(async () => {
  await migrate();
  owner = await user("owner");
  const p = await card.saveProfile(ctx(owner.id), {
    ...base,
    name: "김도윤",
    company: "아크로 메디컬",
    jobTitle: "대표",
    headline: "의료기기 유통",
    fields: [
      { type: "email", value: "doyun@acro.kr", visibility: "business" },
      { type: "mobile", value: "010-2345-6789", visibility: "business" },
      { type: "other", label: "개인 메모", value: "secret-note", visibility: "private" },
      { type: "address", value: "서울 강남", visibility: "trusted" },
    ],
  });
  profileId = p.id;
  slug = p.slug;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ["SMS_PROVIDER", "SMS_SENDER_PHONE", "SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_BASE_URL"]) delete process.env[k];
});

afterAll(async () => {
  await closePool();
});

describe("미리보기", () => {
  it("교환과 같은 audience 로 투영한 내 기본정보와, 보낼 수 있는지를 알려준다", async () => {
    const r = await cardSms.cardSmsPreview(ctx(owner.id));
    expect(r.sender).toEqual({ name: "김도윤", company: "아크로 메디컬", jobTitle: "대표", phone: "010-2345-6789", email: "doyun@acro.kr", website: null });
    expect(r.cardUrl).toBe(`https://linkos.test/p/${encodeURIComponent(slug)}`);
    expect(r.canSend).toBe(false); // 이 환경에는 게이트웨이가 없다
  });

  it("로그인과 내 명함이 필요하다", async () => {
    await expect(cardSms.cardSmsPreview(ctx(null))).rejects.toMatchObject({ status: 401 });
    const u = await user("nocard");
    await expect(cardSms.cardSmsPreview(ctx(u.id))).rejects.toMatchObject({ code: "profile_required" });
    await expect(cardSms.cardSmsPreview(ctx(u.id), profileId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("초안 만들기", () => {
  it("동의 확인이 없으면 초안조차 만들지 않는다 (§2.7)", () => {
    // 라우트의 입력 검증 단계에서 끊긴다 — 모듈까지 내려가지 않는다
    expect(() => prep({ recipient: { fullName: "박서진", phone: "010-1111-2222" } })).toThrow(/명함을 직접 건넸다/);
    expect(() => prep({ recipient: { fullName: "박서진", phone: "010-1111-2222" }, consent: "assumed" })).toThrow();
  });

  it("전화번호로 볼 수 없는 값은 400 으로 막는다 (OCR 오인식이 그대로 발송되지 않게)", async () => {
    await expect(
      cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { fullName: "박서진", phone: "02-xx" }, consent: "card_handed" })),
    ).rejects.toMatchObject({ code: "invalid_phone" });
  });

  it("본문은 내 카드 값만 담고, business 밖 필드(trusted/private)는 들어가지 않는다", async () => {
    const d = await cardSms.prepareCardSms(ctx(owner.id), prep({
      recipient: { fullName: "박서진", phone: "010-1111-2222" },
      placeLabel: "바이오코리아",
      consent: "card_handed",
    }));
    expect(d.toPhone).toBe("+821011112222");
    expect(d.status).toBe("draft");
    expect(d.kind).toBe("lms");
    expect(d.body).toContain("[명함] 김도윤");
    expect(d.body).toContain("박서진님, 바이오코리아에서 인사드렸습니다.");
    expect(d.body).toContain("doyun@acro.kr");
    expect(d.body).not.toContain("secret-note");
    expect(d.body).not.toContain("서울 강남");
    expect(d.link).toMatch(/^https:\/\/linkos\.test\/s\/[A-Za-z0-9_-]{32}$/);
    expect(d.body.trimEnd().endsWith(d.link!)).toBe(true); // 저장 링크는 항상 마지막 줄
  });

  it("토큰은 DB 에 평문으로 남지 않는다 (§3)", async () => {
    const d = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-1111-3333" }, consent: "card_handed" }));
    const token = d.link!.split("/s/")[1]!;
    const row = await one<{ token_hash: string; token_sealed: Buffer }>("SELECT token_hash, token_sealed FROM card_sms_deliveries WHERE id=$1", [d.id]);
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.token_hash).not.toBe(token);
    expect(row!.token_sealed.toString("latin1")).not.toContain(token); // 봉인(암호화)된 사본
    // 그런데도 소유자는 같은 링크를 다시 꺼낼 수 있다
    expect((await cardSms.listCardSms(owner.id)).find((x) => x.id === d.id)?.link).toBe(d.link);
  });

  it("남의 연락처·이미지 id 는 붙일 수 없다", async () => {
    const other = await user("other");
    await card.saveProfile(ctx(other.id), { ...base, name: "타인" });
    const c = await relationship.createContact(ctx(other.id), relationship.contactInput.parse({ fullName: "남의 연락처" }));
    await expect(
      cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-1111-4444" }, contactId: c.contactId, consent: "card_handed" })),
    ).rejects.toMatchObject({ status: 404 });
    const img = await cardSms.putCardImage(ctx(other.id), PNG);
    await expect(
      cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-1111-4444" }, imageObjectId: img.objectId, consent: "card_handed" })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("발송 (명시적 승인)", () => {
  it("게이트웨이가 없으면 실패가 아니라 manual — 문자 앱 딥링크를 돌려준다", async () => {
    const d = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-2222-1111" }, consent: "card_handed" }));
    const r = await cardSms.sendCardSms(ctx(owner.id), d.id, { approved: true });
    expect(r).toMatchObject({ status: "manual", gateway: false });
    expect(r.smsLink!.startsWith("sms:+821022221111?&body=")).toBe(true);
    expect(decodeURIComponent(r.smsLink!.split("?&body=")[1]!)).toBe(d.body);
  });

  it("게이트웨이가 있으면 보내고, messages 이력과 관계 last_contact_at 을 함께 남긴다", async () => {
    const contact = await relationship.createContact(ctx(owner.id), relationship.contactInput.parse({ fullName: "박서진", phone: "010-2222-3333", source: "scan" }));
    const d = await cardSms.prepareCardSms(ctx(owner.id), prep({
      recipient: { fullName: "박서진", phone: "010-2222-3333" },
      contactId: contact.contactId,
      consent: "card_handed",
    }));
    const calls = withSolapi();
    const r = await cardSms.sendCardSms(ctx(owner.id), d.id, { approved: true });
    expect(r).toMatchObject({ status: "sent", provider: "solapi", gateway: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.message).toMatchObject({ to: "01022223333", from: "0212345678", type: "LMS" });
    const msg = await one<{ channel: string; status: string; to_address: string }>("SELECT channel, status, to_address FROM messages WHERE owner_user_id=$1 AND contact_id=$2", [owner.id, contact.contactId]);
    expect(msg).toMatchObject({ channel: "sms", status: "sent", to_address: "+821022223333" });
    expect((await one<{ last_contact_at: Date }>("SELECT last_contact_at FROM relationships WHERE owner_user_id=$1 AND contact_id=$2", [owner.id, contact.contactId]))!.last_contact_at).toBeTruthy();
  });

  it("이미지를 붙이면 먼저 업로드하고 그림문자로 보낸다", async () => {
    const img = await cardSms.putCardImage(ctx(owner.id), PNG);
    const d = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-2222-4444" }, imageObjectId: img.objectId, consent: "card_handed" }));
    expect(d.kind).toBe("mms");
    expect(d.body).toContain("제 명함 이미지를 함께 보냅니다.");
    const calls = withSolapi();
    const r = await cardSms.sendCardSms(ctx(owner.id), d.id, { approved: true });
    expect(r).toMatchObject({ status: "sent", kind: "mms" });
    expect(calls.map((c) => c.url)).toEqual(["https://solapi.test/storage/v1/files", "https://solapi.test/messages/v4/send"]);
    expect(calls[1]!.body.message).toMatchObject({ imageId: "FILE1", type: "MMS" });
  });

  it("같은 승인을 두 번 눌러도 두 번 보내지 않는다", async () => {
    const d = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-2222-5555" }, consent: "card_handed" }));
    const calls = withSolapi();
    await cardSms.sendCardSms(ctx(owner.id), d.id, { approved: true });
    const again = await cardSms.sendCardSms(ctx(owner.id), d.id, { approved: true });
    expect(again.status).toBe("sent");
    expect(calls).toHaveLength(1);
  });

  it("provider 가 거절하면 failed 로 남고 사용자에게 이유를 알린다", async () => {
    const d = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-2222-6666" }, consent: "card_handed" }));
    withSolapi();
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ errorMessage: "발신번호 미등록" }) }) as unknown as Response) as unknown as typeof fetch;
    await expect(cardSms.sendCardSms(ctx(owner.id), d.id, { approved: true })).rejects.toMatchObject({ code: "sms_send_failed" });
    expect((await one<{ status: string; error: string }>("SELECT status, error FROM card_sms_deliveries WHERE id=$1", [d.id]))).toMatchObject({ status: "failed" });
  });

  it("남의 발송은 보이지도, 보내지지도 않는다", async () => {
    const other = await user("other2");
    const d = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-2222-7777" }, consent: "card_handed" }));
    await expect(cardSms.sendCardSms(ctx(other.id), d.id, { approved: true })).rejects.toMatchObject({ status: 404 });
    expect(await cardSms.listCardSms(other.id)).toHaveLength(0);
  });
});

describe("수신자 랜딩 (로그인 없음)", () => {
  it("열면 내 카드가 보이고 열람 횟수가 올라간다", async () => {
    const d = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { fullName: "박서진", phone: "010-3333-1111" }, consent: "card_handed" }));
    const token = d.link!.split("/s/")[1]!;
    const l1 = await cardSms.openCardSmsLanding(token, ctx(null));
    expect(l1.sender.name).toBe("김도윤");
    expect(l1.toName).toBe("박서진");
    expect(l1.vcardPath).toBe(`/s/${token}/vcard`);
    expect(JSON.stringify(l1.sender)).not.toContain("secret-note");
    await cardSms.openCardSmsLanding(token, ctx(null));
    const row = await one<{ open_count: number; opened_at: Date }>("SELECT open_count, opened_at FROM card_sms_deliveries WHERE id=$1", [d.id]);
    expect(row!.open_count).toBe(2);
    expect(row!.opened_at).toBeTruthy();
  });

  it("vCard 는 구글 연락처가 읽는 필드만 담고 저장 시각을 남긴다", async () => {
    const d = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-3333-2222" }, consent: "card_handed" }));
    const token = d.link!.split("/s/")[1]!;
    const v = await cardSms.cardSmsVcard(token, ctx(null));
    expect(v.filename).toBe("contact.vcf"); // 한글 이름 → ASCII 안전 이름
    expect(v.vcard).toContain("FN:김도윤");
    expect(v.vcard).toContain("ORG:아크로 메디컬");
    expect(v.vcard).toContain("TEL;TYPE=CELL:010-2345-6789");
    expect(v.vcard).not.toContain("서울 강남"); // trusted
    expect(v.vcard).not.toContain("secret-note"); // private
    expect((await one<{ saved_at: Date }>("SELECT saved_at FROM card_sms_deliveries WHERE id=$1", [d.id]))!.saved_at).toBeTruthy();
    // 보낸 사람 화면에서 "저장됨"으로 보인다
    expect((await cardSms.listCardSms(owner.id)).find((x) => x.id === d.id)?.savedAt).toBeTruthy();
  });

  it("만료·취소·엉뚱한 토큰은 410/404 로 끊는다", async () => {
    await expect(cardSms.openCardSmsLanding("not-a-token", ctx(null))).rejects.toMatchObject({ status: 404 });
    const expired = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-3333-3333" }, consent: "card_handed" }));
    await q("UPDATE card_sms_deliveries SET expires_at = now() - interval '1 day' WHERE id=$1", [expired.id]);
    await expect(cardSms.openCardSmsLanding(expired.link!.split("/s/")[1]!, ctx(null))).rejects.toMatchObject({ code: "link_expired" });
    await expect(cardSms.sendCardSms(ctx(owner.id), expired.id, { approved: true })).rejects.toMatchObject({ code: "link_expired" });

    const cancelled = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-3333-4444" }, consent: "card_handed" }));
    await cardSms.cancelCardSms(ctx(owner.id), cancelled.id);
    await expect(cardSms.openCardSmsLanding(cancelled.link!.split("/s/")[1]!, ctx(null))).rejects.toMatchObject({ code: "link_revoked" });
  });

  it("보낸 문자는 취소할 수 없다", async () => {
    const d = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-3333-5555" }, consent: "card_handed" }));
    withSolapi();
    await cardSms.sendCardSms(ctx(owner.id), d.id, { approved: true });
    await expect(cardSms.cancelCardSms(ctx(owner.id), d.id)).rejects.toMatchObject({ code: "not_cancellable" });
  });
});

describe("보존", () => {
  it("만료된 발송의 명함 이미지는 지우고, 아직 살아 있는 발송이 쓰는 이미지는 남긴다", async () => {
    const img = await cardSms.putCardImage(ctx(owner.id), PNG);
    const live = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-4444-1111" }, imageObjectId: img.objectId, consent: "card_handed" }));
    const old = await cardSms.prepareCardSms(ctx(owner.id), prep({ recipient: { phone: "010-4444-2222" }, imageObjectId: img.objectId, consent: "card_handed" }));
    await q("UPDATE card_sms_deliveries SET expires_at = now() - interval '1 day' WHERE id=$1", [old.id]);
    expect(await cardSms.purgeExpiredCardSms()).toBeGreaterThanOrEqual(1);
    expect((await one<{ image_object_id: string | null }>("SELECT image_object_id FROM card_sms_deliveries WHERE id=$1", [old.id]))!.image_object_id).toBeNull();
    expect((await one<{ image_object_id: string | null }>("SELECT image_object_id FROM card_sms_deliveries WHERE id=$1", [live.id]))!.image_object_id).toBe(img.objectId);
    expect(await one("SELECT 1 FROM stored_objects WHERE id=$1 AND deleted_at IS NULL", [img.objectId])).toBeTruthy();
  });
});
