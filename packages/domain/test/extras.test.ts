// X-001..X-007 pure logic + audit G-01 (match announcements)
import { describe, expect, it } from "vitest";
import {
  BG_WIDTH,
  POSTER_SIZES,
  announceableMatches,
  backgroundLayout,
  buildApplePassJson,
  buildEmailSignature,
  buildEmailSignatures,
  buildGoogleGenericObject,
  composePrepBrief,
  escapeHtml,
  fillDailySeries,
  fitFontSize,
  formatShortCode,
  googleWalletId,
  passManifest,
  pickReconnectDigest,
  posterLayout,
  prepBriefDue,
  prepBriefNotificationBody,
  reconnectDraft,
  safeHref,
  sparklinePoints,
  trackedCardUrl,
  validateApplePassJson,
  minimizeOcrLines,
  viewCountingAllowed,
  weekStart,
} from "../src";

const card = { name: "홍길동", jobTitle: "대표", company: "링코스랩", email: "hong@linkos.ai", phone: "010-1234-5678", website: "linkos.ai", headline: "의료 AI" };

describe("X-001 email signature", () => {
  it("produces html + plain text for all three styles with the tracked card link", () => {
    const url = trackedCardUrl("https://linkos.test/", "hong-abc", "sig");
    expect(url).toBe("https://linkos.test/p/hong-abc?src=sig");
    const sigs = buildEmailSignatures(card, url);
    expect(sigs.map((s) => s.style)).toEqual(["classic", "compact", "pastel"]);
    for (const s of sigs) {
      expect(s.html).toContain("홍길동");
      expect(s.html).toContain("mailto:hong@linkos.ai");
      expect(s.html).toContain("tel:01012345678");
      expect(s.html).toContain(escapeHtml(url));
      expect(s.text).toContain(url);
      expect(s.text).not.toContain("<");
      expect(s.html).not.toMatch(/<style|class=|var\(--/); // inline CSS only
    }
  });

  it("escapes everything — no markup or script can be injected through card fields", () => {
    const evil = { name: '<img src=x onerror="alert(1)">', jobTitle: "</td><script>x()</script>", company: "A&B", email: 'a"@b.co', website: "javascript:alert(1)" };
    for (const style of ["classic", "compact", "pastel"] as const) {
      const s = buildEmailSignature(evil, "javascript:alert(2)", style);
      expect(s.html).not.toMatch(/<img|<script|onerror=|href="javascript:/i);
      expect(s.html).toContain("&#60;img");
      expect(s.html).toContain("A&#38;B");
    }
  });

  it("safeHref allows only http(s)/mailto/tel", () => {
    expect(safeHref("linkos.ai")).toBe("https://linkos.ai/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(safeHref("tel:+821012345678")).toBe("tel:+821012345678");
    expect(safeHref("https://a.b/\" onmouseover=x")).toBeNull();
  });
});

describe("X-002 virtual background layout", () => {
  it("fits long names inside the right band and keeps the link", () => {
    const ops = backgroundLayout({ ...card, name: "아주아주아주긴이름을가진사람의이름입니다정말로길어요" }, "https://linkos.test/p/hong?src=bg", "pastel");
    const texts = ops.filter((o) => o.kind === "text") as Extract<(typeof ops)[number], { kind: "text" }>[];
    expect(texts[0]!.size).toBeLessThan(96);
    expect(texts.every((t) => t.x <= BG_WIDTH && t.align === "right")).toBe(true);
    expect(texts.at(-1)!.text).toBe("linkos.test/p/hong?src=bg");
    expect(ops[0]).toEqual({ kind: "fill", color: "#FCFCFE" });
  });
  it("dark style uses the dark palette; fitFontSize respects min", () => {
    const ops = backgroundLayout({ name: "Kim" }, "https://x.io", "dark");
    expect(ops[0]).toEqual({ kind: "fill", color: "#0F0F17" });
    expect(fitFontSize("x".repeat(500), 96, 48, 100)).toBe(48);
  });
});

describe("X-003 card view counting", () => {
  it("respects owner opt-out, GPC and DNT", () => {
    expect(viewCountingAllowed({ ownerOptOut: false })).toBe(true);
    expect(viewCountingAllowed({ ownerOptOut: true })).toBe(false);
    expect(viewCountingAllowed({ ownerOptOut: false, gpc: "1" })).toBe(false);
    expect(viewCountingAllowed({ ownerOptOut: false, dnt: "1" })).toBe(false);
    expect(viewCountingAllowed({ ownerOptOut: false, isOwner: true })).toBe(false);
  });
  it("fills a 30-day series and draws a sparkline", () => {
    const today = new Date("2026-10-07T12:00:00Z");
    const s = fillDailySeries([{ day: "2026-10-07", count: 3 }, { day: "2026-10-01", count: 2 }, { day: "2026-08-01", count: 9 }], 30, today);
    expect(s).toHaveLength(30);
    expect(s.at(-1)).toBe(3);
    expect(s.at(-7)).toBe(2);
    expect(s.reduce((a, b) => a + b, 0)).toBe(5);
    const pts = sparklinePoints(s, 120, 32).split(" ");
    expect(pts).toHaveLength(30);
    expect(sparklinePoints([0, 0], 10, 10)).toBe("2.0,8.0 8.0,8.0");
  });
});

describe("X-004 wallet pass builders", () => {
  const pc = { ...card, profileId: "6f0f6f2e-1111-4222-8333-444455556666", cardUrl: "https://linkos.test/p/hong?src=wallet" };
  const cfg = { passTypeIdentifier: "pass.ai.linkos.card", teamIdentifier: "ABCDE12345" };
  it("builds a valid generic pass.json", () => {
    const p = buildApplePassJson(pc, cfg, "serial-0001");
    expect(validateApplePassJson(p)).toEqual([]);
    expect((p.generic as any).primaryFields[0].value).toBe("홍길동");
    expect((p.barcodes as any)[0]).toMatchObject({ format: "PKBarcodeFormatQR", message: pc.cardUrl });
    expect(JSON.stringify(p)).not.toContain("undefined");
  });
  it("flags invalid identifiers and missing fields", () => {
    const p = buildApplePassJson(pc, { passTypeIdentifier: "ai.linkos", teamIdentifier: "abc" }, "s1");
    expect(validateApplePassJson(p)).toEqual(expect.arrayContaining(["passTypeIdentifier", "teamIdentifier", "serialNumber"]));
  });
  it("manifest hashes every file except manifest/signature", () => {
    const files = { "pass.json": new Uint8Array([1]), "icon.png": new Uint8Array([2]), signature: new Uint8Array([3]) };
    const m = passManifest(files, (b) => `h${b[0]}`);
    expect(m).toEqual({ "icon.png": "h2", "pass.json": "h1" });
  });
  it("Google generic object uses issuer-scoped ids", () => {
    const o = buildGoogleGenericObject(pc, "3388000000012345678");
    expect(o.id).toBe(`3388000000012345678.card_${pc.profileId}`);
    expect(o.classId).toBe("3388000000012345678.linkos_living_card");
    expect(googleWalletId("1", "a b/c")).toBe("1.a_b_c");
    expect((o.header as any).defaultValue.value).toBe("홍길동");
  });
});

describe("X-005 meeting prep brief", () => {
  const base = { meetingTitle: "분기 리뷰", startsAt: new Date("2026-10-07T05:00:00Z"), contact: { id: "c1", fullName: "김영희", company: "메디파트너스", jobTitle: "이사" } };
  it("is due only inside the lead window", () => {
    expect(prepBriefDue(base.startsAt, new Date("2026-10-07T04:35:00Z"), 30)).toBe(true);
    expect(prepBriefDue(base.startsAt, new Date("2026-10-07T04:20:00Z"), 30)).toBe(false);
    expect(prepBriefDue(base.startsAt, new Date("2026-10-07T05:01:00Z"), 30)).toBe(false);
    expect(prepBriefDue(base.startsAt, new Date("2026-10-07T04:59:00Z"), 0)).toBe(false);
  });
  it("only restates records and labels inferred topics", () => {
    const b = composePrepBrief({
      ...base,
      lastEncounter: { at: new Date("2026-09-01T00:00:00Z"), place: "COEX" },
      encounterCount: 2,
      recentNote: { body: "병원 3곳 소개 약속", at: new Date() },
      openActions: [{ description: "제안서 보내기" }],
      theirOffers: ["전국 병원 유통망"],
      myNeeds: ["병원 유통 파트너"],
    });
    expect(b.items.map((i) => i.kind)).toEqual(["who", "last_met", "note", "open_action", "their_offer", "topic"]);
    expect(b.items.find((i) => i.kind === "topic")!.provenance).toBe("ai_inferred");
    expect(b.items.filter((i) => i.kind !== "topic").every((i) => i.provenance === "record")).toBe(true);
    expect(b.aiInferredCount).toBe(1);
    expect(prepBriefNotificationBody(b)).toContain("COEX");
    expect(prepBriefNotificationBody(b)).not.toContain("제안해");
  });
  it("never invents anything when there is no history", () => {
    const b = composePrepBrief(base);
    expect(b.empty).toBe(true);
    expect(b.items).toEqual([{ kind: "who", text: "김영희 — 이사 · 메디파트너스", provenance: "record" }]);
    expect(prepBriefNotificationBody(b)).toMatch(/기록된 이전 만남이 없어요/);
  });
});

describe("X-006 re-connect digest", () => {
  it("picks 3, high risk first, skipping recently nudged", () => {
    const items = [
      { contactId: "a", fullName: "A", daysSilent: 40, level: "medium" },
      { contactId: "b", fullName: "B", daysSilent: 90, level: "high" },
      { contactId: "c", fullName: "C", daysSilent: 120, level: "medium" },
      { contactId: "d", fullName: "D", daysSilent: 60, level: "high" },
      { contactId: "e", fullName: "E", daysSilent: 300, level: "high" },
    ];
    expect(pickReconnectDigest(items, new Set(["e"])).map((i) => i.contactId)).toEqual(["b", "d", "c"]);
  });
  it("draft mentions only recorded facts", () => {
    const d = reconnectDraft({ fullName: "김영희", company: null, lastPlace: null });
    expect(d.body).toContain("김영희님");
    expect(d.body).not.toMatch(/지난번|에서 요즘/);
    const d2 = reconnectDraft({ fullName: "김영희", company: "메디파트너스", lastPlace: "COEX", senderName: "홍길동" });
    expect(d2.body).toContain("COEX");
    expect(d2.body).toContain("메디파트너스");
    expect(d2.body.trim().endsWith("홍길동 드림")).toBe(true);
  });
  it("weekStart is the UTC Monday", () => {
    expect(weekStart(new Date("2026-10-07T10:00:00Z"))).toBe("2026-10-05");
    expect(weekStart(new Date("2026-10-04T10:00:00Z"))).toBe("2026-09-28");
  });
});

describe("X-007 poster layout (QR is the small fallback)", () => {
  it("short code is the hero, QR is small and in the corner", () => {
    for (const size of ["a6", "a4"] as const) {
      const l = posterLayout(size);
      expect(l.qr.size).toBeLessThan(l.w * 0.25);
      expect(l.qr.size).toBeLessThan(l.codeSize * 1.5);
      expect(l.qr.y).toBeGreaterThan(l.urlY); // below the code + url
      expect(l.qr.x + l.qr.size).toBeLessThanOrEqual(POSTER_SIZES[size].w);
    }
    expect(posterLayout("a4").codeSize).toBeGreaterThan(posterLayout("a6").codeSize);
    expect(formatShortCode("k7mp2q")).toBe("K7M P2Q");
  });
});

describe("audit G-01 match announcements", () => {
  it("announces only matches at/above the threshold", () => {
    expect(announceableMatches([{ score: 0.29 }, { score: 0.3 }, { score: 0.8 }]).map((m) => m.score)).toEqual([0.3, 0.8]);
  });
});

describe("audit G-02 OCR evidence minimization (F-058, F-162)", () => {
  it("keeps only lines backing shared values and strips unshared contact tokens", () => {
    const lines = [
      { text: "김영희 이사", confidence: 92 },
      { text: "메디파트너스", confidence: 90 },
      { text: "M 010-9999-8888", confidence: 88 },
      { text: "yh@medi.kr  T 02-555-1234", confidence: 95 },
      { text: "서울시 강남구 테헤란로 1", confidence: 80 },
      { text: "www.medi.kr", confidence: 70 },
    ];
    const out = minimizeOcrLines(lines, ["김영희", "메디파트너스", "이사", "yh@medi.kr"]);
    expect(out.map((l) => l.text)).toEqual(["김영희 이사", "메디파트너스", "yh@medi.kr T"]);
    expect(JSON.stringify(out)).not.toMatch(/9999|555|테헤란/);
    expect(minimizeOcrLines(lines, [])).toEqual([]);
    expect(minimizeOcrLines(lines, ["김영희", "010-9999-8888"]).map((l) => l.text)).toEqual(["김영희 이사", "M 010-9999-8888"]);
  });
});
