// F-014 배지 스캔 / F-144 배지 OCR: 행사 배지 레이아웃(이름이 가장 크게, 그 아래 회사, 직함) 매핑.
// 모든 값은 OCR 원문의 부분 문자열이다(원문에 없는 값 생성 금지). 배지 유형(VISITOR/SPEAKER…)은 연락처 필드가 아니라 메타데이터.
import { type ExtractedField, type ExtractionResult, type OcrLine, parseBusinessCard } from "./ocrParser";
import { normalizePersonName } from "./normalize";

const BADGE_TYPES = /^(?:visitor|attendee|delegate|speaker|exhibitor|sponsor|press|media|staff|crew|organizer|vip|guest|student|참관객|참가자|관람객|연사|발표자|전시자|전시업체|후원사|프레스|기자|스태프|운영진|주최|초청|학생)$/i;
const EVENT_NOISE = /(20\d{2}|expo|summit|conference|forum|festival|week|show|박람회|컨퍼런스|포럼|서밋|엑스포|페스티벌|\bday\b|hall|booth|부스|\bno\.?\s*\d+|^[#\d\s-]+$)/i;
const COMPANYISH = /(\(주\)|㈜|주식회사|inc\.?|corp\.?|ltd\.?|llc|gmbh|labs?|studio|group|partners|ventures|capital|대학교|university|병원|hospital|재단|협회|association|institute|연구원|센터)/i;
const TITLEISH = /(대표|이사|팀장|부장|과장|매니저|연구원|교수|ceo|cto|cfo|coo|founder|director|manager|engineer|designer|head|lead|vp|president|officer|analyst|partner)/i;

function conf(l: OcrLine): number {
  const c = l.confidence;
  if (c === undefined || Number.isNaN(c)) return 0.85;
  return Math.max(0, Math.min(1, c > 1 ? c / 100 : c));
}

const height = (l: OcrLine) => (l.bbox ? l.bbox.y1 - l.bbox.y0 : 0);
const top = (l: OcrLine) => (l.bbox ? l.bbox.y0 : 0);

function nameLike(s: string): boolean {
  const t = s.trim();
  if (/\d|@/.test(t)) return false;
  if (/^[가-힣]{2,4}$/.test(normalizePersonName(t))) return true;
  if (/^[가-힣]{1,2}\s[가-힣]{1,3}$/.test(t)) return true;
  return /^[A-Za-z][A-Za-z'’.-]+(?:\s[A-Za-z][A-Za-z'’.-]+){1,2}$/.test(t) && t.length <= 32;
}

export interface BadgeExtraction extends ExtractionResult {
  /** e.g. SPEAKER / 참관객 — shown as context, never stored as a contact field */
  badgeType: string | null;
}

/**
 * Badge layout parser. Contact channels (email/phone/url) come from the business-card parser;
 * name/company/title follow badge typography: the tallest name-like line is the name, the next
 * non-noise line below it is the company (or a title when it contains a title word).
 */
export function parseBadge(lines: OcrLine[]): BadgeExtraction {
  const base = parseBusinessCard(lines);
  const clean = lines.map((l, i) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim(), i }));
  const channelLines = new Set(base.fields.filter((f) => ["email", "mobile", "phone", "fax", "website", "sns"].includes(f.key)).map((f) => f.sourceLine));
  let badgeType: string | null = null;
  const typeLine = clean.find((l) => BADGE_TYPES.test(l.text));
  if (typeLine) badgeType = typeLine.text;

  const usable = clean.filter((l) => l.text && !channelLines.has(l.i) && l !== typeLine && !EVENT_NOISE.test(l.text));
  const names = usable.filter((l) => nameLike(l.text));
  // tallest first; without boxes, the first name-like line
  names.sort((a, b) => height(b) - height(a) || a.i - b.i);
  const name = names[0];
  const fields: ExtractedField[] = base.fields.filter((f) => !["fullName", "company", "jobTitle", "department"].includes(f.key));
  const used = new Set<number>([...channelLines]);
  if (typeLine) used.add(typeLine.i);
  if (name) {
    const tallest = Math.max(0, ...clean.map(height));
    const dominant = height(name) > 0 && height(name) >= tallest * 0.95;
    fields.push({ key: "fullName", value: name.text, normalized: normalizePersonName(name.text), confidence: conf(name) * (dominant ? 0.92 : 0.8), provenance: "ocr", sourceLine: name.i, bbox: name.bbox });
    used.add(name.i);
    // lines after the name in layout order
    const after = usable
      .filter((l) => !used.has(l.i) && (l.bbox && name.bbox ? top(l) >= top(name) : l.i > name.i))
      .sort((a, b) => (a.bbox && b.bbox ? top(a) - top(b) : a.i - b.i));
    let company = after.find((l) => COMPANYISH.test(l.text)) ?? after.find((l) => !TITLEISH.test(l.text));
    const title = after.find((l) => l !== company && TITLEISH.test(l.text));
    if (!company && after[0] && after[0] !== title) company = after[0];
    if (company) {
      fields.push({ key: "company", value: company.text, normalized: null, confidence: conf(company) * (COMPANYISH.test(company.text) ? 0.9 : 0.75), provenance: "ocr", sourceLine: company.i, bbox: company.bbox });
      used.add(company.i);
    }
    if (title) {
      fields.push({ key: "jobTitle", value: title.text, normalized: null, confidence: conf(title) * 0.8, provenance: "ocr", sourceLine: title.i, bbox: title.bbox });
      used.add(title.i);
    }
  } else {
    // no name-like line: keep the card parser's guesses
    // (never the badge-type line: "연사"/"참관객" look like 2-syllable Korean names to the card parser)
    for (const f of base.fields) if (["fullName", "company", "jobTitle", "department"].includes(f.key) && f.sourceLine !== typeLine?.i) {
      fields.push(f);
      used.add(f.sourceLine);
    }
  }
  const unassigned = clean.filter((l) => l.text && !used.has(l.i)).map((l) => ({ line: l.i, text: l.text }));
  return { fields, unassigned, language: base.language, badgeType };
}
