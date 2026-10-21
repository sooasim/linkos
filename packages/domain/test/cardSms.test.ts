// X-009 문자명함 전송 — 순수 로직(본문 조립, 국내 문자 바이트 계산, 딥링크, 명함 이미지 레이아웃).
import { describe, expect, it } from "vitest";
import {
  CARD_IMG_HEIGHT,
  CARD_IMG_WIDTH,
  GOOGLE_CONTACTS_URL,
  LMS_BYTE_LIMIT,
  SMS_BYTE_LIMIT,
  type CardSmsSender,
  buildCardSmsText,
  cardImageLayout,
  cardImageOverflows,
  normalizePhone,
  smsByteLength,
  smsDeepLink,
  smsKind,
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
  it("iOS·Android 양쪽에서 동작하는 `?&body=` 형태로 본문을 채운다", () => {
    const link = smsDeepLink("+821023456789", "[명함] 김도윤\nhttps://x");
    expect(link.startsWith("sms:+821023456789?&body=")).toBe(true);
    expect(decodeURIComponent(link.split("?&body=")[1]!)).toBe("[명함] 김도윤\nhttps://x");
  });

  it("번호에 섞인 하이픈·공백은 떼어낸다", () => {
    expect(smsDeepLink("010-2345 6789", "hi").startsWith("sms:01023456789?")).toBe(true);
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
