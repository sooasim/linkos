// F-010 교환 끝단: 내 명함 문자 본문 · sms: 링크. 없는 값은 줄을 생략하고(지어내지 않음), 번호는 숫자/+만 남긴다.
import { describe, expect, it } from "vitest";
import { buildMyCardMessage, buildScanRecordMessage, smsHref, telDigits } from "../src";

describe("cardShare", () => {
  it("builds my-card body from present fields only", () => {
    const body = buildMyCardMessage(
      { name: "홍길동", jobTitle: "대표", company: "링코스랩", phone: "010-1234-5678", email: "gd@linkos.ai", url: "https://linkos.app/p/hong" },
      { recipientName: "김철수" },
    );
    expect(body).toContain("김철수님");
    expect(body).toContain("홍길동 대표");
    expect(body).toContain("링코스랩");
    expect(body).toContain("☎ 010-1234-5678");
    expect(body).toContain("✉ gd@linkos.ai");
    expect(body).toContain("https://linkos.app/p/hong");
  });

  it("omits empty fields instead of inventing them", () => {
    const body = buildMyCardMessage({ name: "홍길동", url: "https://linkos.app/p/hong" });
    expect(body).toContain("홍길동");
    expect(body).toContain("https://linkos.app/p/hong");
    expect(body).not.toContain("☎");
    expect(body).not.toContain("✉");
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("null");
  });

  it("scan-record body summarizes only the recognized facts", () => {
    const body = buildScanRecordMessage({ fullName: "이영희", company: "한빛물산", phone: "010-0000-1111" }, "스타트업 밋업");
    expect(body).toContain("📇 스캔한 명함");
    expect(body).toContain("이영희");
    expect(body).toContain("한빛물산");
    expect(body).toContain("☎ 010-0000-1111");
    expect(body).toContain("— 스타트업 밋업");
    expect(body).not.toContain("✉");
  });

  it("smsHref keeps only digits/+ in the recipient and encodes the body", () => {
    expect(smsHref("010-1234-5678", "안녕 & 반가워요")).toBe("sms:01012345678?body=" + encodeURIComponent("안녕 & 반가워요"));
    expect(smsHref("+82 (10) 1234 5678", "x")).toBe("sms:+821012345678?body=x");
    expect(smsHref(null, "x")).toBe("sms:?body=x");
    expect(telDigits("02) 336-7788")).toBe("023367788");
  });
});
