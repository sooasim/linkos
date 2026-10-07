// F-177 다국어: 로케일 선택과 메시지 리소스 완전성
import { describe, expect, it } from "vitest";
import { CARD_MESSAGES, GUEST_MESSAGES, LOCALES, fmt, pickLocale } from "../src/i18n";

describe("F-177 i18n", () => {
  it("picks by Accept-Language q-value and falls back to ko", () => {
    expect(pickLocale("en-US,en;q=0.9")).toBe("en");
    expect(pickLocale("fr-FR,ja;q=0.8,en;q=0.5")).toBe("ja");
    expect(pickLocale("de-DE,fr;q=0.9")).toBe("ko");
    expect(pickLocale("en;q=0.2,ko;q=0.9")).toBe("ko");
    expect(pickLocale("ja;q=0,en")).toBe("en");
    expect(pickLocale(null)).toBe("ko");
    expect(pickLocale("")).toBe("ko");
  });
  it("explicit override wins and is validated", () => {
    expect(pickLocale("ko-KR", "ja")).toBe("ja");
    expect(pickLocale("ko-KR", "EN-gb")).toBe("en");
    expect(pickLocale("en", "xx")).toBe("en");
  });
  it("every locale defines every key with the same placeholders", () => {
    const keys = Object.keys(GUEST_MESSAGES.ko) as (keyof typeof GUEST_MESSAGES.ko)[];
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const l of LOCALES) {
      for (const k of keys) {
        expect(GUEST_MESSAGES[l][k], `${l}.${k}`).toBeTruthy();
        expect(ph(GUEST_MESSAGES[l][k]), `${l}.${k}`).toBe(ph(GUEST_MESSAGES.ko[k]));
      }
    }
  });
  it("card labels exist in every locale", () => {
    for (const l of LOCALES) for (const k of Object.keys(CARD_MESSAGES.ko) as (keyof typeof CARD_MESSAGES.ko)[]) expect(CARD_MESSAGES[l][k], `${l}.${k}`).toBeTruthy();
  });
  it("fmt interpolates and leaves unknown keys", () => {
    expect(fmt("{name}님께 보내기", { name: "Jun" })).toBe("Jun님께 보내기");
    expect(fmt("{a} {b}", { a: 1 })).toBe("1 {b}");
  });
});
