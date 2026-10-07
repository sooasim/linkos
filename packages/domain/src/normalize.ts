// 백서 5. raw + normalized 병행 보관. 정규화는 원문을 대체하지 않는다.

export function normalizeEmail(raw: string): string | null {
  const m = raw.trim().toLowerCase().match(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/);
  return m ? m[0] : null;
}

/**
 * Calling code + national trunk prefix per country. `trunk` is the prefix dialled inside the country and dropped in
 * E.164 ("010-1234-5678" → +82 10…); null = no trunk prefix, a leading 0 is part of the number (Italy) or absent.
 */
export const PHONE_COUNTRIES = {
  KR: { cc: "82", trunk: "0" }, US: { cc: "1", trunk: "1" }, CA: { cc: "1", trunk: "1" }, JP: { cc: "81", trunk: "0" }, CN: { cc: "86", trunk: "0" },
  GB: { cc: "44", trunk: "0" }, DE: { cc: "49", trunk: "0" }, FR: { cc: "33", trunk: "0" }, IT: { cc: "39", trunk: null }, ES: { cc: "34", trunk: null },
  NL: { cc: "31", trunk: "0" }, BE: { cc: "32", trunk: "0" }, CH: { cc: "41", trunk: "0" }, AT: { cc: "43", trunk: "0" }, SE: { cc: "46", trunk: "0" },
  NO: { cc: "47", trunk: null }, DK: { cc: "45", trunk: null }, FI: { cc: "358", trunk: "0" }, PL: { cc: "48", trunk: null }, PT: { cc: "351", trunk: null },
  IE: { cc: "353", trunk: "0" }, AU: { cc: "61", trunk: "0" }, NZ: { cc: "64", trunk: "0" }, SG: { cc: "65", trunk: null }, HK: { cc: "852", trunk: null },
  TW: { cc: "886", trunk: "0" }, TH: { cc: "66", trunk: "0" }, VN: { cc: "84", trunk: "0" }, ID: { cc: "62", trunk: "0" }, MY: { cc: "60", trunk: "0" },
  PH: { cc: "63", trunk: "0" }, IN: { cc: "91", trunk: "0" }, AE: { cc: "971", trunk: "0" }, SA: { cc: "966", trunk: "0" }, IL: { cc: "972", trunk: "0" },
  TR: { cc: "90", trunk: "0" }, BR: { cc: "55", trunk: "0" }, MX: { cc: "52", trunk: null }, AR: { cc: "54", trunk: "0" }, RU: { cc: "7", trunk: "8" },
  ZA: { cc: "27", trunk: "0" },
} as const satisfies Record<string, { cc: string; trunk: string | null }>;
export type PhoneCountry = keyof typeof PHONE_COUNTRIES;

/** calling codes whose national trunk prefix is "0" (a "+82 010…" style 0 after the code is dropped). */
const ZERO_TRUNK_CC = new Set<string>(Object.values(PHONE_COUNTRIES).filter((c) => c.trunk === "0").map((c) => c.cc));

function dropTrunkAfterCountryCode(intl: string): string {
  for (const len of [1, 2, 3]) {
    const cc = intl.slice(0, len);
    if (ZERO_TRUNK_CC.has(cc) && intl[len] === "0") return cc + intl.slice(len + 1);
  }
  return intl;
}

/** Best-effort E.164 normalization. Returns null when the input is not a plausible phone number. */
export function normalizePhone(raw: string, defaultCountry: PhoneCountry = "KR"): string | null {
  // NFKC: full-width digits / plus sign from CJK input methods ("０１０" → "010")
  const trimmed = raw.normalize("NFKC").trim();
  const hasPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\(0\)/g, "").replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 17) return null;
  let out: string;
  if (hasPlus) out = dropTrunkAfterCountryCode(digits);
  else if (digits.startsWith("00")) out = dropTrunkAfterCountryCode(digits.slice(2));
  else {
    const c = PHONE_COUNTRIES[defaultCountry] ?? PHONE_COUNTRIES.KR;
    // "0" trunk is always dropped; NANP "1" / Russian "8" only when it precedes a full 10-digit national number
    if (c.trunk === "0" && digits.startsWith("0")) digits = digits.slice(1);
    else if (c.trunk && c.trunk !== "0" && digits.length === 11 && digits.startsWith(c.trunk)) digits = digits.slice(1);
    // Korean numbers like 1588-xxxx (8 digits, no leading 0) are national service numbers.
    out = `${c.cc}${digits}`;
  }
  return out.length >= 7 && out.length <= 15 ? `+${out}` : null;
}

export function normalizeUrl(raw: string): string | null {
  let s = raw.trim().replace(/[),.;]+$/, "");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname.includes(".")) return null;
    u.hash = "";
    const out = `${u.protocol}//${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}${u.search}`;
    return out;
  } catch {
    return null;
  }
}

const COMPANY_AFFIXES = [
  /\(주\)/g,
  /㈜/g,
  /주식회사/g,
  /유한회사/g,
  /株式会社/g,
  /有限公司/g,
  /\b(inc|corp|corporation|co|ltd|llc|gmbh|limited|plc)\b\.?/gi,
];

export function normalizeCompanyName(raw: string): string {
  let s = raw;
  for (const re of COMPANY_AFFIXES) s = s.replace(re, " ");
  return s.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizePersonName(raw: string): string {
  const s = raw.trim().replace(/\s+/g, " ");
  // "홍 길 동" → "홍길동" (Hangul letters separated by single spaces)
  if (/^[가-힣](\s[가-힣]){1,4}$/.test(s)) return s.replace(/\s/g, "");
  return s;
}

/** Compact key for fuzzy comparison. */
export function nameKey(raw: string): string {
  return normalizePersonName(raw).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
