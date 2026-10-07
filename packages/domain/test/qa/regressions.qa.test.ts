// Regression cases for every bug the generated QA suites found (docs/QA_MATRIX.md §Bugs). One named case per bug so a
// revert fails loudly even if generator seeds change.
import { describe, expect, it } from "vitest";
import {
  buildIcs,
  createOutboxItem,
  enqueue,
  fmt,
  normalizePhone,
  parseBadge,
  parseBusinessCard,
  redactString,
  scoreDuplicate,
  settle,
  ssoEnforcementDecision,
  toVCard,
  validateWebhookUrl,
} from "../../src";

describe("QA regressions", () => {
  it("BUG-01 F-015 rule 6: 'Name, Title, Title' keeps the title as a literal slice of the card", () => {
    const r = parseBusinessCard([{ text: "Jane Doe, CEO, Founder" }]);
    expect(r.fields.find((f) => f.key === "fullName")?.value).toBe("Jane Doe");
    expect(r.fields.find((f) => f.key === "jobTitle")?.value).toBe("CEO, Founder"); // was "CEO Founder" (not on the card)
    const k = parseBusinessCard([{ text: "홍길동 | 마케팅팀 | 팀장" }]);
    expect(k.fields.find((f) => f.key === "department")?.value).toBe("마케팅팀");
    expect(k.fields.find((f) => f.key === "jobTitle")?.value).toBe("팀장"); // was "마케팅팀 팀장"
  });

  it("BUG-02 F-016: single-digit area codes (Tokyo 3, Osaka 6, Seoul 2 w/ +82) are extracted", () => {
    for (const p of ["+81 3-1234-5678", "+81 6-1234-5678", "Tel +82 2 1234 5678"]) {
      const r = parseBusinessCard([{ text: p }]);
      expect(r.fields.some((f) => ["phone", "mobile"].includes(f.key)), p).toBe(true);
    }
  });

  it("BUG-03 F-014: a badge-type line (연사/참관객) is never stored as the person's name", () => {
    const r = parseBadge([{ text: "연사" }, { text: "陈敏" }, { text: "深圳华信科技有限公司" }]);
    expect(r.badgeType).toBe("연사");
    expect(r.fields.find((f) => f.key === "fullName")?.value).not.toBe("연사");
  });

  it("BUG-04 백서 12: full-width phone numbers are redacted", () => {
    const out = redactString("전화 ０１０－１２３４－５６７８ 주세요 / +８２ １０ １２３４ ５６７８");
    expect(out).not.toMatch(/[０-９]{3,}/);
    expect(out).toContain("***78");
  });

  it("BUG-05 F-020: '+82 010-…' and '010-…' normalize to the same E.164 number; US trunk '1' is dropped", () => {
    expect(normalizePhone("+82 010-1234-5678")).toBe("+821012345678");
    expect(normalizePhone("1 (415) 555-0100", "US")).toBe("+14155550100");
    expect(normalizePhone("０１０-１２３４-５６７８")).toBe("+821012345678");
    expect(normalizePhone("+39 06 1234 5678")).toBe("+390612345678"); // Italy keeps its leading 0
    expect(scoreDuplicate({ fullName: "A", phone: "+82 010 1234 5678" }, { fullName: "B", phone: "010-1234-5678" }).reasons).toContain("phone_exact");
  });

  it("BUG-06 vCard: a bare CR cannot inject a property", () => {
    const v = toVCard({ fullName: "Eve\rEMAIL:attacker@evil.io", note: "a\r\nb\rc" });
    expect(v.split("\r\n").some((l) => l.startsWith("EMAIL"))).toBe(false);
    expect(v.slice(0, -2).split("\r\n").every((l) => !/[\r\n]/.test(l))).toBe(true);
  });

  it("BUG-07 ICS: a bare CR cannot inject a property", () => {
    const ics = buildIcs({ uid: "u@x", start: new Date(0), end: new Date(60_000), summary: "Hi\rATTENDEE:mailto:evil@x.io", dtstamp: new Date(0) });
    expect(ics.split("\r\n").some((l) => l.startsWith("ATTENDEE"))).toBe(false);
  });

  it("BUG-08 F-123 SSRF: trailing-dot hosts and IPv4-mapped IPv6 (hex form) are private", () => {
    for (const u of ["https://localhost./x", "https://[::ffff:127.0.0.1]/x", "https://[::ffff:a9fe:a9fe]/x", "https://[64:ff9b::a00:1]/x"]) expect(validateWebhookUrl(u).ok, u).toBe(false);
    expect(validateWebhookUrl("https://[2606:4700::1111]/x").ok).toBe(true);
  });

  it("BUG-09 F-008: SSO enforcement parses the domain like the org lookup does", () => {
    for (const email of ["kim@acme.com.", "kim@ACME.com", " kim@acme.com "]) {
      expect(ssoEnforcementDecision({ ssoRequired: true, ssoAvailable: true, email, verifiedDomains: ["acme.com"], role: "member", method: "email_otp" }), email).toBe("sso_required");
    }
  });

  it("BUG-10 F-178: a PATCH coalesced into an in-flight request gets a new key and survives the response", () => {
    const path = "/contacts/11111111-1111-4111-8111-111111111111";
    const first = createOutboxItem({ id: "a", method: "PATCH", path, body: { jobTitle: "CTO" }, idempotencyKey: "k1", now: 1 })!;
    const inFlight = first;
    const merged = enqueue([first], createOutboxItem({ id: "b", method: "PATCH", path, body: { company: "Acme" }, idempotencyKey: "k2", now: 2 })!);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.idempotencyKey).toBe("k2"); // different body → different key
    expect(merged[0]!.body).toEqual({ jobTitle: "CTO", company: "Acme" });
    expect(settle(merged[0], inFlight, { action: "done" })).toEqual({ action: "keep" }); // not deleted with the in-flight response
  });

  it("BUG-11 F-177: fmt() does not expand Object.prototype keys", () => {
    expect(fmt("{constructor}{toString}", {})).toBe("{constructor}{toString}");
  });
});
