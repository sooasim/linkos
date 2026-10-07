// QA (generated): 백서 5 정규화 — phones → E.164 across 41 countries and 9 input formats, emails, URLs, names.
// Invariants: the same number written any common way normalizes to ONE E.164 string (otherwise F-020 duplicate
// detection misses), output matches ^\+[1-9]\d{6,14}$, and normalization is idempotent.
import { describe, expect, it } from "vitest";
import { type PhoneCountry, nameKey, normalizeCompanyName, normalizeEmail, normalizePersonName, normalizePhone, normalizeUrl, scoreDuplicate } from "../../src";
import { type Rng, cases, rng } from "./_gen";

// Independent test oracle (not imported from src): calling code, trunk prefix, national significant number shape.
const C: Record<PhoneCountry, { cc: string; trunk: string | null; len: number; first: string }> = {
  KR: { cc: "82", trunk: "0", len: 10, first: "1" }, US: { cc: "1", trunk: "1", len: 10, first: "23456789" }, CA: { cc: "1", trunk: "1", len: 10, first: "2456789" },
  JP: { cc: "81", trunk: "0", len: 10, first: "3679" }, CN: { cc: "86", trunk: "0", len: 11, first: "1" }, GB: { cc: "44", trunk: "0", len: 10, first: "27" },
  DE: { cc: "49", trunk: "0", len: 11, first: "1" }, FR: { cc: "33", trunk: "0", len: 9, first: "1234567" }, IT: { cc: "39", trunk: null, len: 10, first: "03" },
  ES: { cc: "34", trunk: null, len: 9, first: "6789" }, NL: { cc: "31", trunk: "0", len: 9, first: "126" }, BE: { cc: "32", trunk: "0", len: 9, first: "4" },
  CH: { cc: "41", trunk: "0", len: 9, first: "247" }, AT: { cc: "43", trunk: "0", len: 10, first: "16" }, SE: { cc: "46", trunk: "0", len: 9, first: "78" },
  NO: { cc: "47", trunk: null, len: 8, first: "49" }, DK: { cc: "45", trunk: null, len: 8, first: "2345" }, FI: { cc: "358", trunk: "0", len: 9, first: "45" },
  PL: { cc: "48", trunk: null, len: 9, first: "5678" }, PT: { cc: "351", trunk: null, len: 9, first: "29" }, IE: { cc: "353", trunk: "0", len: 9, first: "8" },
  AU: { cc: "61", trunk: "0", len: 9, first: "2348" }, NZ: { cc: "64", trunk: "0", len: 9, first: "29" }, SG: { cc: "65", trunk: null, len: 8, first: "689" },
  HK: { cc: "852", trunk: null, len: 8, first: "2569" }, TW: { cc: "886", trunk: "0", len: 9, first: "29" }, TH: { cc: "66", trunk: "0", len: 9, first: "2689" },
  VN: { cc: "84", trunk: "0", len: 9, first: "3789" }, ID: { cc: "62", trunk: "0", len: 10, first: "8" }, MY: { cc: "60", trunk: "0", len: 9, first: "13" },
  PH: { cc: "63", trunk: "0", len: 10, first: "9" }, IN: { cc: "91", trunk: "0", len: 10, first: "6789" }, AE: { cc: "971", trunk: "0", len: 9, first: "5" },
  SA: { cc: "966", trunk: "0", len: 9, first: "5" }, IL: { cc: "972", trunk: "0", len: 9, first: "5" }, TR: { cc: "90", trunk: "0", len: 10, first: "5" },
  BR: { cc: "55", trunk: "0", len: 11, first: "123" }, MX: { cc: "52", trunk: null, len: 10, first: "3589" }, AR: { cc: "54", trunk: "0", len: 10, first: "1239" },
  RU: { cc: "7", trunk: "8", len: 10, first: "9" }, ZA: { cc: "27", trunk: "0", len: 9, first: "17" },
};
const COUNTRIES = Object.keys(C) as PhoneCountry[];

function nsn(r: Rng, c: (typeof C)[PhoneCountry]): string {
  return r.pick([...c.first]) + r.digits(c.len - 1);
}

/** Split digits into human groups with a separator style. */
function group(r: Rng, digits: string, style: number): string {
  const parts: string[] = [];
  let i = 0;
  while (i < digits.length) {
    const n = Math.min(digits.length - i, r.int(2, 4));
    parts.push(digits.slice(i, i + n));
    i += n;
  }
  switch (style) {
    case 0: return parts.join(" ");
    case 1: return parts.join("-");
    case 2: return parts.join(".");
    case 3: return `(${parts[0]}) ${parts.slice(1).join("-")}`;
    default: return digits;
  }
}

const FORMATS = ["intl", "intl_00", "intl_paren_trunk", "intl_with_trunk", "national", "national_fullwidth", "intl_nbsp", "intl_tab_noise", "already_e164"] as const;
type Format = (typeof FORMATS)[number];

function render(r: Rng, country: PhoneCountry, num: string, f: Format): string | null {
  const c = C[country];
  const g = () => group(r, num, r.int(0, 4));
  switch (f) {
    case "intl": return `+${c.cc} ${g()}`;
    case "intl_00": return `00 ${c.cc} ${g()}`;
    case "intl_paren_trunk": return c.trunk === "0" ? `+${c.cc} (0)${g()}` : null;
    case "intl_with_trunk": return c.trunk === "0" ? `+${c.cc} 0${g()}` : null; // common on Korean/Japanese cards: "+82 010-…"
    case "national": return `${c.trunk ?? ""}${g()}`;
    case "national_fullwidth": return `${c.trunk ?? ""}${g()}`.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
    case "intl_nbsp": return `+${c.cc} ${g().replace(/ /g, " ")}`;
    case "intl_tab_noise": return `  \t+${c.cc}  ${g()}\t `;
    case "already_e164": return `+${c.cc}${num}`;
  }
}

const PHONE_CASES = COUNTRIES.flatMap((country, ci) =>
  FORMATS.flatMap((format, fi) =>
    [0, 1, 2].map((k) => {
      const r = rng(ci * 1000 + fi * 10 + k);
      const num = nsn(r, C[country]);
      return { country, format, num, input: render(r, country, num, format) };
    }),
  ),
).filter((x): x is typeof x & { input: string } => x.input !== null);

describe(`QA · normalizePhone → E.164 (${COUNTRIES.length} countries × ${FORMATS.length} formats)`, () => {
  it("covers at least 30 countries", () => expect(COUNTRIES.length).toBeGreaterThanOrEqual(30));

  it.each(PHONE_CASES)("$country $format: $input", ({ country, format, num, input }) => {
    const expected = `+${C[country].cc}${num}`;
    const dc = format.startsWith("national") ? country : "KR";
    const out = normalizePhone(input, dc);
    expect(out).toBe(expected);
    expect(out).toMatch(/^\+[1-9]\d{6,14}$/);
    // idempotent: E.164 in → same E.164 out, whatever the default country
    expect(normalizePhone(out!, "US")).toBe(out);
    expect(normalizePhone(out!, country)).toBe(out);
  });

  it.each([
    ["", null], ["123", null], ["++++", null], ["010", null], ["1".repeat(30), null], ["phone: n/a", null], ["+", null],
  ])("rejects implausible %j", (input, expected) => expect(normalizePhone(input)).toBe(expected));

  // regression: the same Korean mobile written "+82 010-…" vs "010-…" must be ONE number (F-020 duplicate detection)
  it("duplicate detection treats +82 010-… and 010-… as the same phone", () => {
    const a = { fullName: "김민수", phone: "+82 010-1234-5678" };
    const b = { fullName: "Minsu Kim", phone: "010-1234-5678" };
    expect(scoreDuplicate(a, b).reasons).toContain("phone_exact");
    expect(scoreDuplicate(b, a).reasons).toContain("phone_exact");
  });

  // regression: NANP national numbers written with the trunk "1" must not become +11…
  it.each(["1 (415) 555-0100", "1-415-555-0100", "(415) 555-0100", "415.555.0100"])("US national %s → +14155550100", (s) => expect(normalizePhone(s, "US")).toBe("+14155550100"));
});

const EMAIL_CASES = cases(300, 303, (r) => {
  const local = r.str("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._%+-", 1, 20).replace(/^[.]+/, "a");
  const domain = `${r.str("abcdefghijklmnopqrstuvwxyz0123456789-", 1, 12)}.${r.pick(["com", "co.kr", "io", "jp", "travel", "museum"])}`;
  return { raw: `${r.pick(["", " ", "\t"])}${local}@${domain}${r.pick(["", " ", "\n"])}` };
});

describe("QA · normalizeEmail (300 generated)", () => {
  it.each(EMAIL_CASES)("email #$i", ({ c }) => {
    const n = normalizeEmail(c.raw);
    expect(n).toBe(c.raw.trim().toLowerCase());
    expect(normalizeEmail(n!)).toBe(n);
    expect(normalizeEmail(n!.toUpperCase())).toBe(n);
  });
  it.each(["", "a@", "@b.com", "a@b", "a b@c.com", "a@b.c", "<a@b.com>", "a@b.com\nBcc: x@y.com"])("rejects %j", (s) => expect(normalizeEmail(s)).toBeNull());
});

const URL_CASES = cases(200, 404, (r) => {
  const host = `${r.pick(["", "www.", "WWW."])}${r.str("abcdefghijklmnopqrstuvwxyz0123456789-", 1, 10).replace(/^-|-$/g, "x")}.${r.pick(["com", "io", "co.kr", "ai"])}`;
  const path = r.pick(["", "/", "/team", "/a/b?x=1", "/%EC%95%88"]);
  return `${r.pick(["", "http://", "https://", "HTTPS://"])}${host}${path}${r.pick(["", ")", ".", "#frag"])}`;
});

describe("QA · normalizeUrl (200 generated)", () => {
  it.each(URL_CASES)("url #$i", ({ c }) => {
    const n = normalizeUrl(c);
    expect(n).not.toBeNull();
    expect(n).toMatch(/^https?:\/\/[a-z0-9.-]+/);
    expect(n).not.toMatch(/\/\/www\./);
    expect(normalizeUrl(n!)).toBe(n);
  });
  it.each(["", "localhost", "http://", "javascript:alert(1)"])("rejects %j", (s) => expect(normalizeUrl(s)).toBeNull());
});

const NAME_CASES = cases(200, 505, (r) => {
  const ko = r.pick(["김", "이", "박"]) + r.pick(["민수", "영희", "도윤"]);
  return r.pick([ko, [...ko].join(" "), `  ${ko}  `, `Jane   ${r.pick(["Doe", "O'Neil"])}`, r.pick(["山田 太郎", "王伟"])]);
});

describe("QA · names & companies (200 generated)", () => {
  it.each(NAME_CASES)("name #$i normalizes idempotently", ({ c }) => {
    const n = normalizePersonName(c);
    expect(normalizePersonName(n)).toBe(n);
    expect(nameKey(n)).toBe(nameKey(c));
    expect(n).not.toMatch(/\s{2,}|^\s|\s$/);
  });
  it.each([["(주)링코스", "링코스"], ["링코스 주식회사", "링코스"], ["Acme, Inc.", "acme"], ["ACME Corp", "acme"], ["株式会社サンプル", "サンプル"], ["Globex GmbH", "globex"]])("company %s → %s", (a, b) => {
    expect(normalizeCompanyName(a)).toBe(b);
  });
});
