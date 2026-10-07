// F-111 메시지 템플릿 — 변수 치환은 순수 함수. 알 수 없는 변수는 저장 시 거부하고, 값이 없는 변수는 비워 둔 채 "missing" 으로 알린다
// (AI/템플릿이 사실을 지어내지 않도록: 값이 없으면 채우지 않는다).

export const TEMPLATE_VARIABLES = ["name", "firstName", "company", "jobTitle", "myName", "myCompany", "myTitle", "place", "date"] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

const VAR_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

export function templateVariables(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(VAR_RE)) out.add(m[1]!);
  return [...out];
}

export function validateTemplate(parts: string[]): { ok: boolean; unknown: string[] } {
  const unknown = [...new Set(parts.flatMap(templateVariables))].filter((v) => !(TEMPLATE_VARIABLES as readonly string[]).includes(v));
  return { ok: unknown.length === 0, unknown };
}

export function renderTemplate(text: string, vars: Partial<Record<string, string | null | undefined>>): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const rendered = text.replace(VAR_RE, (_all, name: string) => {
    const v = vars[name];
    if (v == null || String(v).trim() === "") {
      missing.add(name);
      return "";
    }
    return String(v);
  });
  // collapse the double spaces / dangling punctuation a missing value can leave behind
  return { text: rendered.replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?])/g, "$1"), missing: [...missing] };
}

/** "김민수" → 민수, "John Smith" → John. Korean names: 1-char family name for 2–4 Hangul syllables. */
export function splitName(full: string): { first: string; last: string } {
  const s = full.trim().replace(/\s+/g, " ");
  if (!s) return { first: "", last: "" };
  if (/^[가-힣]{2,4}$/.test(s)) return { last: s.slice(0, 1), first: s.slice(1) };
  if (/^[가-힣]+ [가-힣]+$/.test(s)) {
    const [a, b] = s.split(" ");
    return { last: a!, first: b! };
  }
  const parts = s.split(" ");
  if (parts.length === 1) return { first: "", last: parts[0]! };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1]! };
}

/** F-105 SMS/메신저용 짧은 초안: 문장 경계에서 자른다. */
export function shortMessage(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const sentences = flat.split(/(?<=[.!?。]|[다요]\.)\s+/);
  let out = "";
  for (const s of sentences) {
    if ((out ? out.length + 1 : 0) + s.length > max) break;
    out = out ? `${out} ${s}` : s;
  }
  return out || `${flat.slice(0, max - 1)}…`;
}

export interface SequenceStep {
  dayOffset: number;
  kind: "thank_you" | "check_in" | "send_material" | "meeting_request" | "custom";
  channel: "email" | "sms";
}

export const DEFAULT_SEQUENCE: SequenceStep[] = [
  { dayOffset: 0, kind: "thank_you", channel: "email" },
  { dayOffset: 3, kind: "check_in", channel: "sms" },
  { dayOffset: 14, kind: "check_in", channel: "email" },
];
