// QA (generated): 백서 12 central redaction — no e-mail or phone number survives redact()/redactString()
// across 1,200 generated log lines (ko/en/ja/zh prose, JSON-ish payloads, full-width digits, nested objects).
import { describe, expect, it } from "vitest";
import { redact, redactString } from "../../src";
import { type Rng, cases } from "./_gen";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function email(r: Rng): string {
  const local = r.str("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._%+-", 1, 18).replace(/^\./, "x");
  return `${local}@${r.str("abcdefghijklmnopqrstuvwxyz0123456789-", 1, 10)}.${r.pick(["com", "co.kr", "io", "jp", "cn", "travel"])}`;
}

function phone(r: Rng): string {
  const d = (n: number) => r.digits(n);
  const p = r.pick([
    `010-${d(4)}-${d(4)}`, `010 ${d(4)} ${d(4)}`, `010.${d(4)}.${d(4)}`, `01${r.int(0, 9)}${d(8)}`, `+82 10-${d(4)}-${d(4)}`, `+82-10-${d(4)}-${d(4)}`,
    `(02) ${d(3)}-${d(4)}`, `02-${d(4)}-${d(4)}`, `+1 (${d(3)}) ${d(3)}-${d(4)}`, `+81 3-${d(4)}-${d(4)}`, `+86 138 ${d(4)} ${d(4)}`, `090-${d(4)}-${d(4)}`,
    `1588-${d(4)}`, `+44 20 ${d(4)} ${d(4)}`, `${d(3)}.${d(3)}.${d(4)}`,
  ]);
  // CJK IMEs often produce full-width digits/hyphens
  return r.bool(0.15) ? p.replace(/\d/g, (x) => String.fromCharCode(0xff10 + Number(x))).replace(/-/g, "－") : p;
}

const FILLER = ["연락 주세요", "call me at", "電話は", "我的电话", "email:", "tel", "|", "→", "(mobile)", "명함 교환 완료", "OK", "id=42", "2026-10-07", "v1.2.3", "price 15000원"];

function digitsOf(s: string): string {
  return s.normalize("NFKC").replace(/\D/g, "");
}

const LINES = cases(1200, 606, (r) => {
  const emails: string[] = [];
  const phones: string[] = [];
  const parts: string[] = [];
  for (let k = r.int(1, 6); k > 0; k--) {
    const kind = r.int(0, 2);
    if (kind === 0) {
      const e = email(r);
      emails.push(e);
      parts.push(r.bool(0.3) ? `<${e}>` : e);
    } else if (kind === 1) {
      const p = phone(r);
      phones.push(p);
      parts.push(r.bool(0.3) ? `(${p})` : p);
    } else parts.push(r.pick(FILLER));
  }
  return { text: parts.join(r.pick([" ", ", ", " / ", "\n", ";"])), emails, phones };
});

describe("QA · redactString (1,200 generated log lines)", () => {
  it.each(LINES)("line #$i leaks no e-mail/phone", ({ c }) => {
    const out = redactString(c.text);
    for (const e of c.emails) expect(out).not.toContain(e);
    expect(out).not.toMatch(EMAIL_RE);
    for (const p of c.phones) {
      expect(out).not.toContain(p);
      // at most the last 2 digits of any number may remain visible
      const d = digitsOf(p);
      expect(digitsOf(out).includes(d), `phone ${p} digits survive in ${out}`).toBe(false);
    }
    expect(redactString(out)).toBe(out); // idempotent: redacted text is stable
  });
});

const OBJECTS = cases(200, 707, (r) => {
  const e = email(r);
  const p = phone(r);
  return {
    e,
    p,
    obj: {
      event: "exchange.completed",
      email: e,
      user: { phone: p, nested: [{ memo: `call ${p}` }, { list: [e, 1, true, null] }] },
      headers: { authorization: `Bearer ${r.str("abcdefghijklmnopqrstuvwxyz0123456789", 30, 40)}` },
      Note: `회의 메모 ${e}`,
    },
  };
});

describe("QA · redact(object) (200 generated payloads)", () => {
  it.each(OBJECTS)("payload #$i", ({ c }) => {
    const out = JSON.stringify(redact(c.obj));
    expect(out).not.toContain(c.e);
    expect(digitsOf(out).includes(digitsOf(c.p))).toBe(false);
    expect(out).toContain("exchange.completed");
  });

  it("depth-bombs terminate", () => {
    let o: Record<string, unknown> = { email: "x@y.com" };
    for (let i = 0; i < 100; i++) o = { child: o };
    expect(() => redact(o)).not.toThrow();
  });
});
