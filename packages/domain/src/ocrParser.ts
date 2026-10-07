// F-015, F-016, F-017, F-018: OCR 토큰 → 타입 필드. 원문에 없는 값은 절대 생성하지 않는다.
import { normalizeEmail, normalizePersonName, normalizePhone, normalizeUrl } from "./normalize";

export type Provenance = "ocr" | "user" | "sync" | "ai_inferred" | "exchange";

export interface OcrLine {
  text: string;
  /** 0..1 confidence from the OCR engine */
  confidence?: number;
  /** bounding box in image pixels */
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

export type FieldKey =
  | "fullName"
  | "company"
  | "jobTitle"
  | "department"
  | "email"
  | "mobile"
  | "phone"
  | "fax"
  | "address"
  | "website"
  | "sns";

export interface ExtractedField {
  key: FieldKey;
  value: string; // exactly as it appears in the source line (trimmed)
  normalized?: string | null;
  confidence: number; // 0..1
  provenance: Provenance;
  sourceLine: number; // index into lines
  bbox?: OcrLine["bbox"];
}

export interface ExtractionResult {
  fields: ExtractedField[];
  unassigned: { line: number; text: string }[];
  language: "ko" | "en" | "ja" | "zh" | "mixed";
}

/** F-018: 이 값 미만이면 사용자 확인 대상 */
export const REVIEW_THRESHOLD = 0.75;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|co|kr|jp|cn|app|dev|me|biz|info|xyz|tech|studio|design)(?:\.[a-z]{2})?(?:\/[^\s]*)?/gi;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{4}/g;
const SNS_RE = /\b(?:linkedin\.com\/in\/[\w-]+|instagram\.com\/[\w.]+|x\.com\/\w+|twitter\.com\/\w+|github\.com\/[\w-]+|@[a-z0-9_.]{3,30})\b/gi;

const LABEL_MOBILE = /(?:^|[\s|/])(?:m|mob|mobile|h\.?p|cell|휴대폰|휴대전화|핸드폰|携帯|手机)\s*[.:)]?\s*$/i;
const LABEL_FAX = /(?:^|[\s|/])(?:f|fax|팩스|传真)\s*[.:)]?\s*$/i;
const LABEL_TEL = /(?:^|[\s|/])(?:t|tel|phone|office|전화|대표|直通|电话)\s*[.:)]?\s*$/i;

const TITLE_WORDS = [
  "대표이사", "대표", "회장", "사장", "부사장", "전무", "상무", "이사", "본부장", "실장", "센터장", "부장", "차장", "과장",
  "대리", "주임", "사원", "팀장", "파트장", "매니저", "수석", "책임", "선임", "연구원", "교수", "변호사", "회계사", "변리사",
  "디자이너", "개발자", "엔지니어", "컨설턴트", "프로", "원장", "소장",
  "ceo", "cto", "cfo", "coo", "cmo", "cpo", "founder", "co-founder", "president", "vice president", "vp", "director",
  "manager", "engineer", "designer", "developer", "consultant", "partner", "principal", "head of", "lead", "officer",
  "associate", "analyst", "specialist", "architect", "researcher", "professor", "attorney", "owner",
  "社長", "部長", "課長", "取締役", "代表", "经理", "总监", "总经理",
];
const COMPANY_MARKERS = [
  /\(주\)/, /㈜/, /주식회사/, /유한회사/, /株式会社/, /有限公司/, /集团/,
  /\b(inc|corp|corporation|co\.,?\s*ltd|ltd|llc|gmbh|limited|plc|group|holdings|labs?|studio|partners|ventures|capital|technologies|systems|solutions)\b\.?/i,
  /(그룹|홀딩스|컴퍼니|랩스|스튜디오|벤처스|파트너스|테크|솔루션|시스템즈|코리아)$/,
];
const DEPT_MARKERS = [/(팀|부|본부|실|센터|사업부|연구소|그룹)$/, /\b(dept\.?|department|division|team|office of|group)\b/i, /(部|课|課)$/];
const ADDRESS_MARKERS = [
  /(특별시|광역시|특별자치시|[가-힣]+시\s|[가-힣]+구\s|[가-힣]+군\s|[가-힣]+로\s?\d|[가-힣]+길\s?\d|[가-힣]+동\s?\d|번지|층|호$)/,
  /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/,
  /\b(street|st\.|road|rd\.|avenue|ave\.|suite|floor|blvd|building|bldg)\b/i,
  /(都|道|府|県|市|区|町|号|路|楼)/,
];

function lineConf(l: OcrLine): number {
  const c = l.confidence;
  if (c === undefined || Number.isNaN(c)) return 0.85;
  return Math.max(0, Math.min(1, c > 1 ? c / 100 : c));
}

function detectLanguage(text: string): ExtractionResult["language"] {
  const ko = (text.match(/[가-힣]/g) ?? []).length;
  const ja = (text.match(/[぀-ヿ]/g) ?? []).length;
  const zh = (text.match(/[一-鿿]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = ko + ja + zh + en || 1;
  // Latin-heavy tokens (email/URL) are common on any card, so CJK scripts win at a lower share.
  if (ko / total > 0.3 && ko >= ja && ko >= zh) return "ko";
  if (ja / total > 0.2) return "ja";
  if (zh / total > 0.3) return "zh";
  if (en / total > 0.8) return "en";
  return "mixed";
}

function bboxHeight(l: OcrLine): number {
  return l.bbox ? l.bbox.y1 - l.bbox.y0 : 0;
}

function looksLikeKoreanName(s: string): boolean {
  const n = normalizePersonName(s);
  return /^[가-힣]{2,4}$/.test(n);
}

function looksLikeLatinName(s: string): boolean {
  return /^[A-Z][a-zA-Z'’-]+(?:\s[A-Z][a-zA-Z'’.-]+){1,2}$/.test(s.trim()) && !/\d/.test(s);
}

function hasTitleWord(s: string): string | null {
  const low = s.toLowerCase();
  for (const w of TITLE_WORDS) {
    const re = /^[a-z\s-]+$/.test(w) ? new RegExp(`(^|[^a-z])${w.replace(/[-\s]/g, "[-\\s]")}([^a-z]|$)`, "i") : null;
    if (re ? re.test(low) : s.includes(w)) return w;
  }
  return null;
}

/**
 * Parse OCR lines into typed contact fields. Every returned value is a substring
 * of an input line — the parser never fabricates values (백서 1.1, 17).
 */
export function parseBusinessCard(lines: OcrLine[]): ExtractionResult {
  const fields: ExtractedField[] = [];
  const used = new Set<number>();
  const clean = lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() }));

  const push = (f: ExtractedField) => {
    if (!fields.some((x) => x.key === f.key && x.value === f.value)) fields.push(f);
  };

  clean.forEach((l, i) => {
    if (!l.text) return;
    const conf = lineConf(l);
    let consumed = false;

    for (const m of l.text.matchAll(EMAIL_RE)) {
      push({ key: "email", value: m[0], normalized: normalizeEmail(m[0]), confidence: conf * 0.98, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      consumed = true;
    }
    const withoutEmail = l.text.replace(EMAIL_RE, " ");

    for (const m of withoutEmail.matchAll(SNS_RE)) {
      if (m[0].startsWith("@") && /\.[a-z]{2,}$/i.test(m[0])) continue;
      push({ key: "sns", value: m[0], normalized: m[0].toLowerCase(), confidence: conf * 0.9, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      consumed = true;
    }
    const withoutSns = withoutEmail.replace(SNS_RE, " ");

    for (const m of withoutSns.matchAll(URL_RE)) {
      const norm = normalizeUrl(m[0]);
      if (!norm) continue;
      push({ key: "website", value: m[0].replace(/[),.;]+$/, ""), normalized: norm, confidence: conf * 0.93, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      consumed = true;
    }

    for (const m of l.text.matchAll(PHONE_RE)) {
      const raw = m[0].trim();
      const digits = raw.replace(/\D/g, "");
      if (digits.length < 8) continue;
      const before = l.text.slice(0, m.index ?? 0);
      let key: FieldKey = "phone";
      let c = conf * 0.9;
      if (LABEL_FAX.test(before)) key = "fax";
      else if (LABEL_MOBILE.test(before)) key = "mobile";
      else if (LABEL_TEL.test(before)) key = "phone";
      else if (/^(?:\+?82[\s.-]?)?0?1[016789]/.test(raw.replace(/[()\s]/g, ""))) key = "mobile";
      else c = conf * 0.8; // unlabeled landline
      push({ key, value: raw, normalized: normalizePhone(raw), confidence: c, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      consumed = true;
    }
    if (consumed) used.add(i);
  });

  // Address (before company — addresses often include building names)
  clean.forEach((l, i) => {
    if (used.has(i) || !l.text) return;
    const hits = ADDRESS_MARKERS.filter((re) => re.test(l.text)).length;
    if (hits >= 2 || (hits === 1 && /\d/.test(l.text) && l.text.length >= 10)) {
      push({ key: "address", value: l.text, normalized: null, confidence: lineConf(l) * (hits >= 2 ? 0.9 : 0.75), provenance: "ocr", sourceLine: i, bbox: l.bbox });
      used.add(i);
    }
  });

  // Company
  clean.forEach((l, i) => {
    if (used.has(i) || !l.text || fields.some((f) => f.key === "company")) return;
    if (COMPANY_MARKERS.some((re) => re.test(l.text))) {
      push({ key: "company", value: l.text, normalized: null, confidence: lineConf(l) * 0.9, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      used.add(i);
    }
  });

  // Name + title (may share a line: "홍길동 대표" / "Jane Doe, CEO")
  let nameIdx = -1;
  const candidates = clean
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => !used.has(i) && l.text.length > 0 && l.text.length <= 40);

  for (const { l, i } of candidates) {
    const title = hasTitleWord(l.text);
    if (!title) continue;
    const parts = l.text.split(/\s*[,|/·]\s*|\s{2,}/).filter(Boolean);
    let titleValue = l.text;
    if (parts.length >= 2) {
      const namePart = parts.find((p) => looksLikeKoreanName(p) || looksLikeLatinName(p));
      if (namePart && nameIdx < 0) {
        push({ key: "fullName", value: namePart, normalized: normalizePersonName(namePart), confidence: lineConf(l) * 0.85, provenance: "ocr", sourceLine: i, bbox: l.bbox });
        nameIdx = i;
        titleValue = parts.filter((p) => p !== namePart).join(" ");
      }
    } else {
      // "홍길동 대표이사" (single space)
      const m = l.text.match(/^([가-힣]{2,4})\s+(.+)$/);
      if (m && looksLikeKoreanName(m[1]!) && hasTitleWord(m[2]!) && nameIdx < 0) {
        push({ key: "fullName", value: m[1]!, normalized: m[1]!, confidence: lineConf(l) * 0.85, provenance: "ocr", sourceLine: i, bbox: l.bbox });
        nameIdx = i;
        titleValue = m[2]!;
      }
    }
    const deptMatch = DEPT_MARKERS.some((re) => re.test(titleValue.split(" ")[0] ?? ""));
    if (deptMatch && titleValue.includes(" ")) {
      const [dept, ...rest] = titleValue.split(" ");
      push({ key: "department", value: dept!, normalized: null, confidence: lineConf(l) * 0.75, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      titleValue = rest.join(" ");
    }
    if (!fields.some((f) => f.key === "jobTitle")) {
      push({ key: "jobTitle", value: titleValue, normalized: null, confidence: lineConf(l) * 0.85, provenance: "ocr", sourceLine: i, bbox: l.bbox });
    }
    used.add(i);
  }

  if (nameIdx < 0) {
    const nameCands = candidates
      .filter(({ i }) => !used.has(i))
      .filter(({ l }) => looksLikeKoreanName(l.text) || looksLikeLatinName(l.text));
    // Prefer the tallest text (names are typically printed largest), then the earliest line.
    nameCands.sort((a, b) => bboxHeight(b.l) - bboxHeight(a.l) || a.i - b.i);
    const pick = nameCands[0];
    if (pick) {
      const korean = looksLikeKoreanName(pick.l.text);
      push({
        key: "fullName",
        value: pick.l.text,
        normalized: normalizePersonName(pick.l.text),
        confidence: lineConf(pick.l) * (korean ? 0.85 : 0.7) * (nameCands.length > 1 ? 0.85 : 1),
        provenance: "ocr",
        sourceLine: pick.i,
        bbox: pick.l.bbox,
      });
      used.add(pick.i);
    }
  }

  // Department lines without a title word
  clean.forEach((l, i) => {
    if (used.has(i) || !l.text || fields.some((f) => f.key === "department")) return;
    if (l.text.length <= 30 && DEPT_MARKERS.some((re) => re.test(l.text))) {
      push({ key: "department", value: l.text, normalized: null, confidence: lineConf(l) * 0.65, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      used.add(i);
    }
  });

  const unassigned = clean.map((l, i) => ({ line: i, text: l.text })).filter((x) => x.text && !used.has(x.line));
  return { fields, unassigned, language: detectLanguage(clean.map((l) => l.text).join(" ")) };
}

export function needsReview(f: Pick<ExtractedField, "confidence">): boolean {
  return f.confidence < REVIEW_THRESHOLD;
}

/** Collapse extracted fields into a flat draft (first value per key wins). */
export function toDraft(fields: ExtractedField[]): Partial<Record<FieldKey, string>> {
  const d: Partial<Record<FieldKey, string>> = {};
  for (const f of fields) if (d[f.key] === undefined) d[f.key] = f.value;
  return d;
}

/** Verify the no-fabrication invariant: every value must be a substring of some source line. */
export function assertGrounded(fields: ExtractedField[], lines: OcrLine[]): void {
  for (const f of fields) {
    if (f.provenance !== "ocr") continue;
    const src = lines[f.sourceLine]?.text.replace(/\s+/g, " ") ?? "";
    if (!src.includes(f.value)) throw new Error(`ungrounded field ${f.key}`);
  }
}
