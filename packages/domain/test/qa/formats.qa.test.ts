// QA (generated): F-036/F-1xx vCard & CSV export · ICS (RFC 5545) · MIME (RFC 5322/2047) · F-123 webhook URL guard.
// Round-trips with independent parsers written here; injection attempts (CR/LF, formula prefixes, header smuggling).
import { describe, expect, it } from "vitest";
import {
  buildIcs,
  buildMimeMessage,
  encodeHeader,
  icsEscape,
  isPrivateAddress,
  isRetryableStatus,
  isSafeEmail,
  toCsv,
  toVCard,
  validateWebhookUrl,
  webhookRetryDelaySec,
  webhookSigningInput,
} from "../../src";
import { type Rng, cases } from "./_gen";

const NASTY = ["\n", "\r\n", "\r", ",", ";", "\\", ":", '"', "'", "=", "+", "-", "@", "\t", "😀", "한글", "日本語", "中文", "ü", " ", "BEGIN:VCARD", "END:VEVENT", " ", "<b>", "%0d%0a"];

function text(r: Rng, min = 0, max = 40): string {
  let s = "";
  const n = r.int(min, max);
  while ([...s].length < n) s += r.bool(0.35) ? r.pick(NASTY) : r.str("abcdefghijklmnopqrstuvwxyz ABCXYZ0123456789", 1, 4);
  return s;
}

/** Minimal vCard 3.0 value unescape (RFC 2426 §5). */
function vUnescape(v: string): string {
  return v.replace(/\\([\\,;nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}
const vNormalizeNewlines = (s: string) => s.replace(/\r\n|\r/g, "\n");

const VCARDS = cases(500, 1418, (r) => ({
  fullName: text(r, 1, 30),
  company: r.bool(0.7) ? text(r, 1, 30) : null,
  jobTitle: r.bool(0.5) ? text(r, 1, 20) : null,
  email: r.bool(0.5) ? `${r.str("abc", 1, 5)}@x.io` : null,
  phone: r.bool(0.5) ? `010-${r.digits(4)}-${r.digits(4)}` : null,
  address: r.bool(0.4) ? text(r, 1, 50) : null,
  website: r.bool(0.4) ? "https://a.io/x,y;z" : null,
  note: r.bool(0.5) ? text(r, 0, 80) : null,
}));

describe("QA · vCard (500 generated contacts with hostile characters)", () => {
  it.each(VCARDS)("vcard #$i round-trips and keeps one property per line", ({ c }) => {
    const v = toVCard(c);
    expect(v.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n")).toBe(true);
    expect(v.endsWith("END:VCARD\r\n")).toBe(true);
    const lines = v.slice(0, -2).split("\r\n");
    // no bare CR or LF may survive inside a content line (would split/inject properties)
    for (const l of lines) expect(l, JSON.stringify(l)).not.toMatch(/[\r\n]/);
    expect(lines.filter((l) => l === "BEGIN:VCARD")).toHaveLength(1);
    expect(lines.filter((l) => l === "END:VCARD")).toHaveLength(1);
    const prop = (name: string) => lines.find((l) => l.startsWith(name))?.slice(name.length);
    expect(vUnescape(prop("FN:")!)).toBe(vNormalizeNewlines(c.fullName));
    if (c.company) expect(vUnescape(prop("ORG:")!)).toBe(vNormalizeNewlines(c.company));
    if (c.note) expect(vUnescape(prop("NOTE:")!)).toBe(vNormalizeNewlines(c.note));
    if (c.address) expect(vUnescape(prop("ADR;TYPE=WORK:;;")!.replace(/;;;;$/, ""))).toBe(vNormalizeNewlines(c.address));
  });
});

/** RFC 4180 parser for the round-trip. */
function parseCsv(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === '"' && s[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\r" && s[i + 1] === "\n") row.push(cell), rows.push(row), (row = []), (cell = ""), i++;
    else cell += ch;
  }
  return rows;
}

const CSVS = cases(300, 1519, (r) => Array.from({ length: r.int(0, 6) }, () => ({ a: text(r), b: r.pick([null, undefined, 42, true, text(r)]), c: r.pick(["=SUM(A1)", "+1", "-2", "@cmd", "\tx", "\rx", "ok", ""]) })));

describe("QA · CSV export (300 generated sheets)", () => {
  it.each(CSVS)("csv #$i round-trips with formula-injection guard", ({ c }) => {
    const out = toCsv(c, ["a", "b", "c"]);
    expect(out.startsWith("﻿")).toBe(true);
    const rows = parseCsv(out.slice(1));
    expect(rows[0]).toEqual(["a", "b", "c"]);
    expect(rows).toHaveLength(c.length + 1);
    c.forEach((src, k) => {
      const row = rows[k + 1]!;
      (["a", "b", "c"] as const).forEach((col, j) => {
        const raw = src[col] == null ? "" : String(src[col]);
        const cell = row[j]!;
        expect(cell).not.toMatch(/^[=+\-@\t\r]/); // no spreadsheet formula can start a cell
        expect(cell === raw || cell === `'${raw}`).toBe(true);
      });
    });
  });
});

/** RFC 5545 unfold + unescape. */
function icsUnfold(s: string): string[] {
  return s.replace(/\r\n[ \t]/g, "").split("\r\n").filter(Boolean);
}
function icsUnescape(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

const ICS = cases(400, 1620, (r) => {
  const start = new Date(Date.UTC(2026, r.int(0, 11), r.int(1, 28), r.int(0, 23), r.int(0, 59)));
  return {
    uid: `${r.str("abcdef0123456789", 8, 32)}@linkos`,
    start,
    end: new Date(start.getTime() + r.int(15, 240) * 60000),
    summary: text(r, 1, 120),
    description: r.bool(0.7) ? text(r, 0, 400) : null,
    location: r.bool(0.5) ? text(r, 0, 60) : null,
    organizer: r.bool(0.5) ? { name: text(r, 0, 20), email: "o@x.io" } : null,
    attendees: Array.from({ length: r.int(0, 3) }, () => ({ name: text(r, 0, 20), email: `${r.str("abc", 1, 4)}@y.io` })),
  };
});

const enc = new TextEncoder();

describe("QA · ICS (400 generated events)", () => {
  it.each(ICS)("event #$i: folded ≤75 octets, unfolds to the original text", ({ c }) => {
    const ics = buildIcs({ ...c, dtstamp: new Date(0) });
    for (const phys of ics.slice(0, -2).split("\r\n")) {
      expect(enc.encode(phys).length).toBeLessThanOrEqual(75);
      expect(phys).not.toMatch(/[\r\n]/);
    }
    const lines = icsUnfold(ics);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines.filter((l) => l === "END:VEVENT")).toHaveLength(1);
    const get = (p: string) => lines.find((l) => l.startsWith(p))?.slice(p.length);
    expect(icsUnescape(get("SUMMARY:")!)).toBe(vNormalizeNewlines(c.summary));
    if (c.description) expect(icsUnescape(get("DESCRIPTION:")!)).toBe(vNormalizeNewlines(c.description));
    if (c.location) expect(icsUnescape(get("LOCATION:")!)).toBe(vNormalizeNewlines(c.location));
    expect(lines.filter((l) => l.startsWith("ATTENDEE"))).toHaveLength(c.attendees.length);
  });

  it.each(["a\rb", "a\nb", "a\r\nb", "x\r\rBEGIN:VEVENT"])("icsEscape leaves no raw line break: %j", (s) => expect(icsEscape(s)).not.toMatch(/[\r\n]/));
  it("rejects CR/LF in UID", () => expect(() => buildIcs({ uid: "a\r\nX:1", start: new Date(), end: new Date(), summary: "s" })).toThrow());
});

/** Decode RFC 2047 B-encoded words joined by CRLF SP. */
function decodeHeader(v: string): string {
  return v
    .split("\r\n ")
    .map((w) => {
      const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=$/.exec(w);
      return m ? Buffer.from(m[1]!, "base64").toString("utf8") : w;
    })
    .join("");
}

const HEADERS = cases(300, 1721, (r) => text(r, 0, 120).replace(/[\r\n]/g, ""));

describe("QA · MIME headers & messages (300 generated subjects)", () => {
  it.each(HEADERS)("subject #$i round-trips through RFC 2047", ({ c }) => {
    const h = encodeHeader(c);
    expect(h).not.toMatch(/\r\n(?! )/); // only folded continuation lines
    for (const w of h.split("\r\n ")) if (w.startsWith("=?")) expect(w.length).toBeLessThanOrEqual(75); // RFC 2047 §2 encoded-word limit
    expect(decodeHeader(h)).toBe(c);
    const msg = buildMimeMessage({ to: "a@b.io", toName: c, subject: c, body: `${c}\nline2`, date: new Date(0) });
    const [head, body] = msg.split("\r\n\r\n");
    expect(head!.split("\r\n").filter((l) => /^[A-Za-z-]+: /.test(l)).map((l) => l.split(":")[0])).toEqual(["To", "Subject", "Date", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"]);
    expect(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(`${c}\r\nline2`);
  });

  it.each(["a\r\nBcc: x@y.io", "a\nb", "x\rb"])("header injection is refused: %j", (s) => {
    expect(() => encodeHeader(s)).toThrow();
    expect(() => buildMimeMessage({ to: "a@b.io", subject: s, body: "" })).toThrow();
  });

  it.each([
    ["a@b.io", true], ["a+tag@sub.b.io", true], ["a@b", false], ["a b@c.io", false], ["a@b.io\r\nBcc: z@z.io", false], ["<a@b.io>", false], ["a@b.io,c@d.io", false], [`${"a".repeat(250)}@b.io`, false],
  ])("isSafeEmail(%j) = %s", (e, ok) => expect(isSafeEmail(e as string)).toBe(ok));
});

const PRIVATE_HOSTS = [
  "localhost", "LOCALHOST", "localhost.", "a.localhost", "svc.internal", "printer.local", "printer.local.",
  "127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
  "[::1]", "[::]", "[fc00::1]", "[fd12::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[::ffff:10.0.0.1]", "[::ffff:169.254.169.254]", "[0:0:0:0:0:0:0:1]",
  "2130706433", "0x7f.0.0.1", "0177.0.0.1", "127.0.0.1.",
];
const PUBLIC_HOSTS = ["example.com", "hooks.zapier.com", "8.8.8.8", "172.32.0.1", "192.169.0.1", "100.128.0.1", "[2606:4700::1111]", "sub.example.co.kr"];

describe("QA · webhook URL SSRF guard", () => {
  it.each(PRIVATE_HOSTS)("blocks private host %s", (h) => {
    const v = validateWebhookUrl(`https://${h}/hook`);
    expect(v.ok, `${h} → ${JSON.stringify(v)}`).toBe(false);
  });
  it.each(PUBLIC_HOSTS)("allows public host %s", (h) => {
    const v = validateWebhookUrl(`https://${h}/hook`);
    expect(v.ok).toBe(true);
    if (v.ok) expect(isPrivateAddress(v.url.hostname)).toBe(false);
  });
  it.each([
    ["http://example.com/x", "https_required"], ["https://u:p@example.com/", "credentials_in_url"], ["https://example.com:22/", "port_not_allowed"], ["not a url", "invalid_url"], ["ftp://example.com/", "https_required"], ["javascript:alert(1)", "https_required"],
  ])("rejects %s (%s)", (u, reason) => {
    const v = validateWebhookUrl(u);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe(reason);
  });
  it.each(Array.from({ length: 20 }, (_, i) => i))("retry delay attempt %i is monotone and capped", (a) => {
    expect(webhookRetryDelaySec(a + 1)).toBeGreaterThanOrEqual(webhookRetryDelaySec(a));
    expect(webhookRetryDelaySec(a)).toBeLessThanOrEqual(6 * 3600);
    expect(webhookRetryDelaySec(a)).toBeGreaterThanOrEqual(30);
  });
  it.each(Array.from({ length: 50 }, (_, i) => 100 + i * 10))("status %i retryable iff 408/425/429/5xx", (s) => {
    expect(isRetryableStatus(s)).toBe(s === 408 || s === 425 || s === 429 || s >= 500);
  });
  it("signing input binds timestamp and body", () => expect(webhookSigningInput(1, "{}")).toBe("1.{}"));
});
