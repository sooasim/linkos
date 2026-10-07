// Audit G-02 (F-058 / F-162): a guest's raw OCR lines may contain values the guest chose NOT to share.
// Before the evidence is stored on the sender's side, keep only lines that support a shared value and strip any
// email / phone / URL token that was not shared.

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /\+?\d[\d\s().-]{6,}\d/g;
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|co|kr|jp|cn|app|dev|me)(?:\/\S*)?/gi;

const norm = (s: string) => s.toLowerCase().replace(/[\s\-().·/:_]+/g, "");

export interface MinimizableLine {
  text: string;
  confidence?: number;
}

export function minimizeOcrLines<T extends MinimizableLine>(lines: T[], sharedValues: (string | null | undefined)[]): T[] {
  const shared = sharedValues.filter((v): v is string => !!v && v.trim().length >= 2).map(norm);
  if (!shared.length) return [];
  const isShared = (token: string) => {
    const t = norm(token);
    return shared.some((v) => v === t || (t.length >= 6 && v.includes(t)) || (v.length >= 6 && t.includes(v)));
  };
  const out: T[] = [];
  for (const l of lines) {
    let text = l.text;
    for (const re of [EMAIL, PHONE, URL_RE]) text = text.replace(re, (m) => (isShared(m) ? m : "").trim());
    text = text.replace(/\s{2,}/g, " ").trim();
    if (!text) continue;
    const n = norm(text);
    if (shared.some((v) => n.includes(v) || (n.length >= 2 && v.includes(n)))) out.push({ ...l, text });
  }
  return out;
}
