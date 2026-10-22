// X-009 문자명함 전송 — 순수 로직(본문 조립, 국내 문자 바이트 계산, 딥링크, 명함 이미지 레이아웃).
import { describe, expect, it } from "vitest";
import {
  CARD_IMG_HEIGHT,
  CARD_IMG_WIDTH,
  GOOGLE_CONTACTS_URL,
  LMS_BYTE_LIMIT,
  SEND_DAILY_LIMIT,
  SEND_MIN_INTERVAL_SEC,
  SMS_BYTE_LIMIT,
  type CardSmsSender,
  buildCardSmsText,
  cardImageLayout,
  cardImageOverflows,
  hasSmsApp,
  maskPhone,
  normalizePhone,
  phoneDeliveryWarning,
  sendGuard,
  smsByteLength,
  smsDeepLink,
  smsKind,
  smsPlatform,
  toVCard,
  vcardFileName,
} from "../src/index";

const ME: CardSmsSender = {
  name: "김도윤",
  company: "아크로 메디컬",
  jobTitle: "대표",
  phone: "010-2345-6789",
  email: "doyun@acro.kr",
  website: "https://acro.kr",
};
const LINK = "https://linkos.app/s/kR3nQb7xTc1vY9zA2mL8pD4sF6gH0jW5";

describe("smsByteLength (국내 통신사 EUC-KR 기준)", () => {
  it("ASCII 는 1바이트, 한글은 2바이트로 센다", () => {
    expect(smsByteLength("abc")).toBe(3);
    expect(smsByteLength("가나다")).toBe(6);
    expect(smsByteLength("김도윤 Kim")).toBe(6 + 4);
  });

  it("EUC-KR 로 표현할 수 없는 이모지는 가장 불리한 4바이트로 센다(길이 경고가 먼저 뜨게)", () => {
    expect(smsByteLength("🙂")).toBe(4);
  });

  it("빈 문자열은 0", () => {
    expect(smsByteLength("")).toBe(0);
  });
});

describe("smsKind", () => {
  it("90바이트 이하는 단문, 넘으면 장문", () => {
    expect(smsKind("a".repeat(SMS_BYTE_LIMIT))).toBe("sms");
    expect(smsKind("a".repeat(SMS_BYTE_LIMIT + 1))).toBe("lms");
  });

  it("이미지가 붙으면 길이와 무관하게 그림문자다", () => {
    expect(smsKind("짧음", true)).toBe("mms");
  });

  it("2,000바이트를 넘으면 보낼 수 없다고 알린다", () => {
    expect(smsKind("가".repeat(LMS_BYTE_LIMIT))).toBe("too_long");
  });
});

describe("buildCardSmsText", () => {
  it("이름·직책·회사·연락처·저장 링크를 그 순서로 담고, 링크는 마지막 줄이다", () => {
    const text = buildCardSmsText(ME, LINK, { recipientName: "박서진", placeLabel: "바이오코리아" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("[명함] 김도윤");
    expect(lines[1]).toBe("박서진님, 바이오코리아에서 인사드렸습니다.");
    expect(lines[2]).toBe("대표 · 아크로 메디컬");
    expect(text).toContain("010-2345-6789");
    expect(text).toContain("doyun@acro.kr");
    expect(lines.at(-1)).toBe(`연락처 저장(구글 연락처·휴대폰 주소록): ${LINK}`);
  });

  it("카드에 없는 값은 줄 자체가 생기지 않는다 (지어내지 않는다)", () => {
    const text = buildCardSmsText({ name: "김도윤" }, LINK);
    expect(text.split("\n")).toEqual(["[명함] 김도윤", "반갑습니다.", `연락처 저장(구글 연락처·휴대폰 주소록): ${LINK}`]);
  });

  it("만난 곳이 없으면 장소를 꾸며 넣지 않는다", () => {
    expect(buildCardSmsText(ME, LINK, { recipientName: "박서진" })).toContain("박서진님, 반갑습니다.");
  });

  it("사용자가 쓴 인사말이 자동 문구를 대신한다", () => {
    const text = buildCardSmsText(ME, LINK, { recipientName: "박서진", placeLabel: "바이오코리아", note: "말씀 나눠 반가웠습니다." });
    expect(text.split("\n")[1]).toBe("말씀 나눠 반가웠습니다.");
    expect(text).not.toContain("바이오코리아");
  });

  it("이미지가 함께 갈 때만 그 사실을 적는다", () => {
    expect(buildCardSmsText(ME, LINK, { withImage: true })).toContain("제 명함 이미지를 함께 보냅니다.");
    expect(buildCardSmsText(ME, LINK)).not.toContain("명함 이미지");
  });

  it("영어 수신자용 본문도 같은 구조다", () => {
    const text = buildCardSmsText(ME, LINK, { locale: "en", recipientName: "Seojin" });
    expect(text.split("\n")[0]).toBe("[Card] 김도윤");
    expect(text).toContain("Seojin, great to meet you.");
    expect(text.split("\n").at(-1)).toContain("Save to contacts");
  });

  it("기본 본문은 장문 한도 안에 들어간다", () => {
    expect(smsKind(buildCardSmsText(ME, LINK, { recipientName: "박서진", placeLabel: "바이오코리아" }))).toBe("lms");
  });
});

describe("smsDeepLink", () => {
  it("플랫폼을 모르면 iOS·Android 양쪽에서 동작하는 `?&body=` 를 쓴다", () => {
    const link = smsDeepLink("+821023456789", "[명함] 김도윤\nhttps://x");
    expect(link.startsWith("sms:+821023456789?&body=")).toBe(true);
    expect(decodeURIComponent(link.split("?&body=")[1]!)).toBe("[명함] 김도윤\nhttps://x");
  });

  it("본문 구분자는 플랫폼마다 다르다 — iOS `&`, Android `?`", () => {
    expect(smsDeepLink("+821023456789", "hi", "ios")).toBe("sms:+821023456789&body=hi");
    expect(smsDeepLink("+821023456789", "hi", "android")).toBe("sms:+821023456789?body=hi");
  });

  it("번호에 섞인 하이픈·공백은 떼어낸다", () => {
    expect(smsDeepLink("010-2345 6789", "hi").startsWith("sms:01023456789?")).toBe(true);
  });

  it("User-Agent 로 플랫폼과 문자 앱 유무를 가린다", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
    const android = "Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36";
    const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    expect([smsPlatform(iphone), smsPlatform(android), smsPlatform(desktop), smsPlatform(null)]).toEqual(["ios", "android", "unknown", "unknown"]);
    expect([hasSmsApp(iphone), hasSmsApp(android), hasSmsApp(desktop)]).toEqual([true, true, false]);
  });
});

describe("maskPhone (이력에 남기는 형태)", () => {
  it("앞 3자리와 뒤 4자리만 남긴다. +82 는 국내 표기로 돌린다", () => {
    expect(maskPhone("+821077771234")).toBe("010-****-1234");
    expect(maskPhone("010-7777-1234")).toBe("010-****-1234");
  });

  it("해외 번호도 가운데를 가린다", () => {
    expect(maskPhone("+15551234567")).toBe("155-****-4567");
  });

  it("번호로 볼 수 없으면 아무것도 내보내지 않는다", () => {
    expect(maskPhone("1234")).toBe("***");
  });
});

describe("phoneDeliveryWarning (문자가 안 갈 수 있는 번호)", () => {
  it("국내 휴대폰은 조용하다", () => {
    expect(phoneDeliveryWarning("+821023456789")).toBeNull();
    expect(phoneDeliveryWarning("+82111234567")).toBeNull(); // 구 011-123-4567
  });

  it("국내 유선·대표번호는 알려 준다(차단은 하지 않는다)", () => {
    expect(phoneDeliveryWarning("+82212345678")).toContain("휴대폰 번호가 아닐 수 있어요");
    expect(phoneDeliveryWarning("+8215881234")).toContain("휴대폰 번호가 아닐 수 있어요");
  });

  it("해외 번호는 판단하지 않는다 (국가별 규칙을 지어내지 않는다)", () => {
    expect(phoneDeliveryWarning("+15551234567")).toBeNull();
  });
});

describe("sendGuard (사람 기준 남용 방지)", () => {
  const now = new Date("2026-10-22T09:00:00Z");

  it("아무 이력이 없으면 보낸다", () => {
    expect(sendGuard({ dailyCount: 0 }, now)).toEqual({ ok: true });
  });

  it("같은 상대에게 보낸(또는 결과를 모르는) 내역이 있으면 막는다 — 가장 먼저 본다", () => {
    const v = sendGuard({ dailyCount: 0, recentSameRecipient: true }, now);
    expect(v).toMatchObject({ ok: false, code: "duplicate_recipient" });
    expect(v.ok === false && v.message).toContain("24시간");
  });

  it("하루 20건을 넘기면 막는다", () => {
    expect(sendGuard({ dailyCount: SEND_DAILY_LIMIT - 1 }, now)).toEqual({ ok: true });
    expect(sendGuard({ dailyCount: SEND_DAILY_LIMIT }, now)).toMatchObject({ ok: false, code: "daily_limit" });
  });

  it("30초 안에 또 누르면 남은 시간을 알려 준다", () => {
    const v = sendGuard({ dailyCount: 1, lastSentAt: new Date(now.getTime() - 10_000) }, now);
    expect(v).toMatchObject({ ok: false, code: "too_soon" });
    expect(v.ok === false && v.code === "too_soon" && v.retryAfterSec).toBe(20);
  });

  it("30초가 지나면 보낸다", () => {
    expect(sendGuard({ dailyCount: 1, lastSentAt: new Date(now.getTime() - SEND_MIN_INTERVAL_SEC * 1000) }, now)).toEqual({ ok: true });
  });

  it("문자열 시각(DB 에서 온 값)도 그대로 읽는다", () => {
    expect(sendGuard({ dailyCount: 1, lastSentAt: "2026-10-22T08:59:55.000Z" }, now)).toMatchObject({ ok: false, code: "too_soon" });
  });
});

describe("수신 번호 정규화 (종이 명함 OCR 결과를 그대로 받는다)", () => {
  it("국내 휴대폰 표기를 E.164 로 바꾼다", () => {
    expect(normalizePhone("010-2345-6789")).toBe("+821023456789");
    expect(normalizePhone("+82 10 2345 6789")).toBe("+821023456789");
    expect(normalizePhone("０１０-２３４５-６７８９")).toBe("+821023456789");
  });

  it("전화번호로 볼 수 없는 값은 null 이다 (발송 전에 막힌다)", () => {
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("acro.kr")).toBeNull();
  });
});

describe("vCard (수신자가 누르는 저장 버튼의 내용)", () => {
  it("구글 연락처·휴대폰 주소록이 읽는 필드를 담는다", () => {
    const v = toVCard({ fullName: ME.name, company: ME.company, jobTitle: ME.jobTitle, phone: ME.phone, email: ME.email, website: ME.website });
    expect(v.startsWith("BEGIN:VCARD\r\nVERSION:3.0")).toBe(true);
    expect(v).toContain("FN:김도윤");
    expect(v).toContain("ORG:아크로 메디컬");
    expect(v).toContain("TEL;TYPE=CELL:010-2345-6789");
    expect(v.trimEnd().endsWith("END:VCARD")).toBe(true);
  });

  it("파일명은 ASCII 로 안전하게 만들고, 한글만 있으면 고정 이름을 쓴다", () => {
    expect(vcardFileName("Doyun Kim")).toBe("Doyun-Kim.vcf");
    expect(vcardFileName("김도윤")).toBe("contact.vcf");
  });

  it("구글 연락처 입구는 공식 주소 하나뿐이다 (자동 등록 링크를 흉내내지 않는다)", () => {
    expect(GOOGLE_CONTACTS_URL).toBe("https://contacts.google.com/");
  });
});

describe("cardImageLayout (문자에 실어 보내는 PNG)", () => {
  it("배경과 모든 텍스트가 카드 안에 들어간다", () => {
    const ops = cardImageLayout(ME, LINK);
    expect(ops[0]).toEqual({ kind: "fill", color: "#FCFCFE" });
    expect(cardImageOverflows(ops)).toBe(false);
  });

  it("이름이 아주 길어도 넘치지 않게 글자 크기를 줄인다", () => {
    const ops = cardImageLayout({ ...ME, name: "박하늘별님구름햇님보다사랑스러우리" }, LINK);
    const name = ops.find((o) => o.kind === "text")!;
    expect(name.kind === "text" && name.size).toBeLessThan(104);
    expect(cardImageOverflows(ops)).toBe(false);
  });

  it("카드에 없는 값은 그리지 않는다", () => {
    const texts = cardImageLayout({ name: "김도윤" }, LINK).filter((o) => o.kind === "text");
    expect(texts.map((o) => (o.kind === "text" ? o.text : ""))).toEqual(["김도윤", "linkos.app/s/kR3nQb7xTc1vY9zA2mL8pD4sF6gH0jW5"]);
  });

  it("다크 스타일은 배경만 바꾸고 레이아웃은 같다", () => {
    const a = cardImageLayout(ME, LINK, "pastel").filter((o) => o.kind === "text");
    const b = cardImageLayout(ME, LINK, "ink").filter((o) => o.kind === "text");
    expect(b.map((o) => (o.kind === "text" ? [o.text, o.x, o.y] : null))).toEqual(a.map((o) => (o.kind === "text" ? [o.text, o.x, o.y] : null)));
  });

  it("가로형 비율은 실제 명함에 가깝다", () => {
    expect(CARD_IMG_WIDTH / CARD_IMG_HEIGHT).toBeGreaterThan(1.4);
    expect(CARD_IMG_WIDTH / CARD_IMG_HEIGHT).toBeLessThan(1.8);
  });
});
