// 백서 12: 로그/트레이스/분석 이벤트에는 원문 명함·전화·이메일을 남기지 않는다 (central redaction).
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// \p{Nd} + full-width separators: CJK IMEs produce "０１０－１２３４－５６７８", which must not slip through.
const PHONE = /(?:[+＋]?\p{Nd}[\p{Nd}\s().\-－（）．]{7,}\p{Nd})/gu;
const TOKENISH = /\b[A-Za-z0-9_-]{22,}\b/g;

const SENSITIVE_KEYS = new Set([
  "email", "phone", "mobile", "fax", "address", "fullName", "full_name", "name", "token", "claimToken", "claim_token",
  "password", "otp", "code", "authorization", "cookie", "access_token", "refresh_token", "body", "note", "transcript",
]);

export function redactString(s: string): string {
  return s
    .replace(EMAIL, (m) => `${m[0]}***@${m.split("@")[1]}`)
    .replace(PHONE, (m) => `***${m.normalize("NFKC").replace(/\D/g, "").slice(-2)}`)
    .replace(TOKENISH, (m) => `${m.slice(0, 4)}…`);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k) && v != null ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
