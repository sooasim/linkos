// 백서 5. raw + normalized 병행 보관. 정규화는 원문을 대체하지 않는다.

export function normalizeEmail(raw: string): string | null {
  const m = raw.trim().toLowerCase().match(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/);
  return m ? m[0] : null;
}

const COUNTRY_CODES: Record<string, string> = { KR: "82", US: "1", JP: "81", CN: "86" };

/** Best-effort E.164 normalization. Returns null when the input is not a plausible phone number. */
export function normalizePhone(raw: string, defaultCountry: keyof typeof COUNTRY_CODES = "KR"): string | null {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\(0\)/g, "").replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (hasPlus) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  const cc = COUNTRY_CODES[defaultCountry] ?? "82";
  if (digits.startsWith("0")) digits = digits.slice(1);
  // Korean numbers like 1588-xxxx (8 digits, no leading 0) are national service numbers.
  return `+${cc}${digits}`;
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
