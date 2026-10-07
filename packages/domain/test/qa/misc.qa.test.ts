// QA (generated): F-177 i18n (Accept-Language negotiation, catalog parity) · F-050/F-045 tokens & short codes ·
// F-009/F-084 consent gates · F-111 message templates · F-127 CRM field mapping.
import { describe, expect, it } from "vitest";
import {
  CARD_MESSAGES,
  CONSENT_TYPES,
  SCANNER_MESSAGES,
  CRM_OBJECTS,
  CRM_PROVIDERS,
  DEFAULT_MAPPINGS,
  GUEST_MESSAGES,
  LOCALES,
  type Locale,
  POLICY_VERSIONS,
  REQUIRED_FOR_SIGNUP,
  TEMPLATE_VARIABLES,
  applyMapping,
  canStartRecording,
  constantTimeEqual,
  fmt,
  generateShortCode,
  generateToken,
  hashToken,
  isWellFormedToken,
  localValues,
  missingRequiredConsents,
  normalizeShortCode,
  pickLocale,
  renderTemplate,
  shortMessage,
  splitName,
  supportsObject,
  templateVariables,
  validateMapping,
  validateTemplate,
} from "../../src";
import { type Rng, cases, product } from "./_gen";

// ---------------- i18n ----------------
const TAGS = ["ko", "ko-KR", "en", "en-US", "en-GB", "ja", "ja-JP", "zh", "zh-CN", "zh-Hant-TW", "de-DE", "fr", "es-419", "*", "EN-us", "Ja", "x-klingon", "", "pt-BR"];

function header(r: Rng): { h: string; parts: { lang: string; q: number; i: number }[] } {
  const parts: { lang: string; q: number; i: number }[] = [];
  const raw: string[] = [];
  for (let i = 0; i < r.int(0, 7); i++) {
    const tag = r.pick(TAGS);
    const qv = r.pick([null, null, "1", "0.9", "0.8", "0.5", "0.1", "0", "0.000", "abc", "1.0"]);
    const q = qv == null ? 1 : Number.isFinite(Number(qv)) ? Number(qv) : 0;
    raw.push(`${r.pick(["", " ", "  "])}${tag}${qv == null ? "" : `;q=${qv}`}`);
    parts.push({ lang: tag.toLowerCase().split("-")[0]!, q, i });
  }
  return { h: raw.join(","), parts };
}

/** Independent oracle: highest q (>0), earliest on ties, first supported primary subtag; else ko. */
function oracle(parts: { lang: string; q: number; i: number }[]): Locale {
  const ok = parts.filter((p) => p.lang && p.q > 0 && (LOCALES as readonly string[]).includes(p.lang)).sort((a, b) => b.q - a.q || a.i - b.i);
  return (ok[0]?.lang as Locale) ?? "ko";
}

describe("QA · pickLocale (1,000 generated Accept-Language headers)", () => {
  it.each(cases(1000, 1822, header))("header #$i", ({ c }) => {
    const l = pickLocale(c.h);
    expect(LOCALES).toContain(l);
    expect(l).toBe(oracle(c.parts));
  });
  it.each(product({ override: ["ko", "EN", "ja-JP", " en ", "xx", "", null], header: ["ja", "en-US,en;q=0.9", null] }))("override $override beats header $header", ({ override, header: h }) => {
    const o = override?.trim().toLowerCase().slice(0, 2);
    const expected = o && (LOCALES as readonly string[]).includes(o) ? o : pickLocale(h);
    expect(pickLocale(h, override)).toBe(expected);
  });
  it("pathological headers do not blow up", () => {
    expect(pickLocale(",".repeat(10_000))).toBe("ko");
    expect(pickLocale(`${"xx;q=0.1,".repeat(5000)}ja`)).toBe("ko"); // only the first 20 entries are considered
  });
});

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("QA · message catalogs are complete and placeholder-consistent", () => {
  const guestKeys = Object.keys(GUEST_MESSAGES.ko) as (keyof (typeof GUEST_MESSAGES)["ko"])[];
  it.each(product({ locale: LOCALES, key: guestKeys }))("guest $locale.$key", ({ locale, key }) => {
    const v = GUEST_MESSAGES[locale][key];
    expect(typeof v).toBe("string");
    expect(v.trim().length).toBeGreaterThan(0);
    expect(placeholders(v)).toEqual(placeholders(GUEST_MESSAGES.ko[key])); // a translation must not drop/rename {name}
    expect(fmt(v, { name: "Jun", place: "COEX", n: 3 })).not.toMatch(/\{(name|place|n)\}/);
  });
  const cardLocales = Object.keys(CARD_MESSAGES) as (keyof typeof CARD_MESSAGES)[];
  const cardKeys = Object.keys(CARD_MESSAGES.ko) as (keyof (typeof CARD_MESSAGES)["ko"])[];
  it.each(product({ locale: cardLocales, key: cardKeys }))("card $locale.$key", ({ locale, key }) => {
    const v = (CARD_MESSAGES[locale] as Record<string, string>)[key];
    expect(v, `${locale}.${key} missing`).toBeTruthy();
    expect(placeholders(v!)).toEqual(placeholders(CARD_MESSAGES.ko[key]));
  });
  it("every supported locale has a card catalog", () => expect(cardLocales.sort()).toEqual([...LOCALES].sort()));
  const scannerKeys = Object.keys(SCANNER_MESSAGES.ko) as (keyof (typeof SCANNER_MESSAGES)["ko"])[];
  it.each(product({ locale: LOCALES, key: scannerKeys }))("scanner $locale.$key", ({ locale, key }) => {
    const v = SCANNER_MESSAGES[locale][key];
    expect(v.trim().length).toBeGreaterThan(0);
    expect(placeholders(v)).toEqual(placeholders(SCANNER_MESSAGES.ko[key]));
    if (locale !== "ko") expect(v, `${locale}.${key} is untranslated Korean`).not.toMatch(/[가-힣]/); // BUG-14 regression
  });
  it.each(cases(100, 1823, (r) => ({ t: r.pick(["{a}{b}", "{a} {zz}", "{{a}}", "{a", "a}", "{0}", "{}", "{constructor}", "{toString}"]), v: { a: r.pick(["$&", "$1", "x"]), b: 2 } })))("fmt #$i never throws, unknown keys kept", ({ c }) => {
    const out = fmt(c.t, c.v);
    expect(typeof out).toBe("string");
    if (c.t === "{constructor}" || c.t === "{toString}") expect(out).toBe(c.t); // prototype keys are not "vars"
  });
});

// ---------------- tokens ----------------
describe("QA · exchange tokens (1,000 generated)", () => {
  const tokens = Array.from({ length: 1000 }, () => generateToken());
  it.each(tokens.map((t, i) => ({ i, t })))("token #$i: ≥128 bit base64url, no PII-shaped content", ({ t }) => {
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(isWellFormedToken(t)).toBe(true);
    expect(t).not.toMatch(/@/);
  });
  it("tokens are unique and hashes are SHA-256 hex", async () => {
    expect(new Set(tokens).size).toBe(tokens.length);
    const h = await hashToken(tokens[0]!);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken(tokens[0]!)).toBe(h);
    expect(await hashToken(tokens[1]!)).not.toBe(h);
  });
  it.each([8, 15])("refuses %i-byte (<128 bit) tokens", (n) => expect(() => generateToken(n)).toThrow());
  it.each(["", "short", "a".repeat(21), "a".repeat(129), "has space aaaaaaaaaaaaaaaaaa", "plus+slash/aaaaaaaaaaaaaaa", "=".repeat(30)])("isWellFormedToken rejects %j", (s) => expect(isWellFormedToken(s)).toBe(false));

  const codes = Array.from({ length: 1000 }, () => generateShortCode());
  it.each(codes.map((c, i) => ({ i, c })))("short code #$i normalizes from any typed form", ({ c }) => {
    expect(c).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(normalizeShortCode(c)).toBe(c);
    expect(normalizeShortCode(c.toLowerCase())).toBe(c);
    expect(normalizeShortCode(`${c.slice(0, 3)}-${c.slice(3)}`)).toBe(c);
    expect(normalizeShortCode(` ${c.slice(0, 3)} ${c.slice(3)} `)).toBe(c);
    expect(normalizeShortCode(`lk.to/${c}`)).toBe(c);
  });
  it("short code alphabet is roughly uniform (no modulo bias)", () => {
    const counts = new Map<string, number>();
    for (const c of codes) for (const ch of c) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const expected = (codes.length * 6) / 31;
    for (const n of counts.values()) expect(Math.abs(n - expected) / expected).toBeLessThan(0.35);
    expect(counts.size).toBe(31);
  });
  it.each(["", "ABCDE", "ABCDEFG", "ABCDE0", "ABCDEO", "ABCDE1", "ABCDEI", "ABCDEL", "ÄBCDEF"])("normalizeShortCode rejects %j", (s) => expect(normalizeShortCode(s)).toBeNull());
  it.each(cases(200, 1824, (r) => [r.str("ab", 0, 6), r.str("ab", 0, 6)] as const))("constantTimeEqual #$i ≡ ===", ({ c: [a, b] }) => {
    expect(constantTimeEqual(a, b)).toBe(a === b);
    expect(constantTimeEqual(b, a)).toBe(a === b);
  });
});

// ---------------- consent ----------------
describe("QA · consent gates", () => {
  const decisions = product({ terms: [null, false, true], privacy: [null, false, true], age_14: [null, false, true], marketing: [null, false, true] });
  it.each(decisions)("signup consents %o", (d) => {
    const list = Object.entries(d).filter(([, v]) => v !== null).map(([type, granted]) => ({ type: type as (typeof CONSENT_TYPES)[number], granted: granted as boolean }));
    const missing = missingRequiredConsents(list);
    for (const t of REQUIRED_FOR_SIGNUP) expect(missing.includes(t)).toBe(d[t as "terms"] !== true);
    expect(missing).not.toContain("marketing"); // marketing is always optional
  });
  it.each(product({ ownerConsented: [false, true], participantsAcknowledged: [false, true], policy: ["all_party", "one_party_notice"] as const }))("recording gate %o", (s) => {
    const r = canStartRecording(s);
    expect(r.ok).toBe(s.ownerConsented && (s.policy === "one_party_notice" || s.participantsAcknowledged));
    if (!s.ownerConsented) expect(r.reason).toBe("owner_consent_missing"); // rule 7
  });
  it.each(CONSENT_TYPES.map((t) => [t]))("%s has a policy version", (t) => expect(POLICY_VERSIONS[t]).toMatch(/^\d{4}-\d{2}-\d{2}$/));
});

// ---------------- templates ----------------
const VARS = [...TEMPLATE_VARIABLES, "unknownVar", "ssn"];

describe("QA · message templates (500 generated)", () => {
  it.each(
    cases(500, 1925, (r) => {
      const used = Array.from({ length: r.int(0, 5) }, () => r.pick(VARS));
      const text = used.map((v) => `${r.pick(["안녕하세요 ", "Hi ", "", ", "])}{{${r.pick(["", " "])}${v}${r.pick(["", " "])}}}${r.pick(["님", "!", ".", " ", ""])}`).join("") + r.pick(["", " 감사합니다.", " {single} {{}} {{ 1bad }}"]);
      const vars = Object.fromEntries(VARS.map((v) => [v, r.pick([null, undefined, "", "  ", "김민수", "$&", "{{name}}", "Acme, Inc."])]));
      return { text, used, vars };
    }),
  )("template #$i: no invented values, every gap reported", ({ c }) => {
    const { text, missing } = renderTemplate(c.text, c.vars);
    expect(text).not.toMatch(/\bundefined\b|\bnull\b/);
    for (const v of new Set(c.used)) {
      const val = c.vars[v];
      const empty = val == null || String(val).trim() === "";
      expect(missing.includes(v)).toBe(empty);
    }
    expect(text).not.toMatch(/[ \t]{2,}/);
    const unknown = validateTemplate([c.text]).unknown;
    expect(unknown.sort()).toEqual([...new Set(c.used.filter((v) => !(TEMPLATE_VARIABLES as readonly string[]).includes(v)))].sort());
    expect(templateVariables(c.text).every((v) => c.used.includes(v))).toBe(true);
  });
  it.each(["김민수", "김 민수", "John Smith", "Mary Jane Watson", "Cher", "  Jane   Doe ", "", "王伟", "南宮민수"])("splitName(%j) keeps every character", (n) => {
    const { first, last } = splitName(n);
    expect(`${last}${first}`.replace(/\s/g, "").length).toBe(n.replace(/\s/g, "").length);
  });
  it.each(cases(200, 1926, (r) => r.str("가나다라. 다요. Hi! ok? 。 abc   ", 0, 300)))("shortMessage #$i ≤ max", ({ c }) => {
    const out = shortMessage(c, 90);
    expect([...out].length).toBeLessThanOrEqual(90);
  });
});

// ---------------- field mapping ----------------
describe("QA · CRM field mapping (providers × objects × 100 contacts)", () => {
  const combos = product({ provider: CRM_PROVIDERS, object: CRM_OBJECTS }).filter((x) => supportsObject(x.provider, x.object));
  it.each(combos)("default $provider/$object mapping validates", ({ provider, object }) => {
    expect(validateMapping(provider, object, DEFAULT_MAPPINGS[provider][object]!)).toEqual({ ok: true, errors: [] });
  });
  const contacts = cases(100, 2027, (r) => ({
    id: `00000000-0000-4000-8000-${r.digits(12)}`,
    fullName: r.pick(["김민수", "Jane Doe", "Cher", "Mary Jane Watson", " "]),
    company: r.pick([null, "", "Acme", "x".repeat(400)]),
    email: r.pick([null, "a@b.io"]),
    phone: r.pick([null, "", "010-1234-5678"]),
    jobTitle: r.pick([null, "CTO"]),
  }));
  it.each(product({ combo: combos, contact: contacts.map((x) => x.c) }).map((x, i) => ({ i, ...x })))("apply #$i", ({ combo, contact }) => {
    const entries = DEFAULT_MAPPINGS[combo.provider][combo.object]!;
    const { values, missingRequired } = applyMapping(combo.provider, combo.object, entries, contact);
    const local = localValues(contact);
    for (const e of entries) {
      const v = values[e.remote];
      if (v !== undefined) {
        expect(String(local[e.local]).slice(0, 255)).toBe(v); // never invented
        expect(v.trim()).not.toBe(""); // never blanks out a CRM field
      }
    }
    for (const m of missingRequired) expect(values[m]).toBeUndefined();
  });
  it.each([
    [[{ local: "email", remote: "Email" }, { local: "phone", remote: "email" }], "duplicate_remote:email"],
    [[{ local: "nope", remote: "X" }], "unknown_local:nope"],
    [[{ local: "email", remote: "1bad" }], "invalid_remote:1bad"],
    [[{ local: "email", remote: "Email; DROP" }], "invalid_remote:Email; DROP"],
  ])("validateMapping rejects %j", (entries, err) => {
    expect(validateMapping("hubspot", "contact", entries as never).errors).toContain(err);
  });
});
