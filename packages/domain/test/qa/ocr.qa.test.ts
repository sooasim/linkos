// QA (generated): F-015~F-018 OCR parser · F-014 badge parser — CLAUDE.md rule 6 "AI는 사실 필드를 지어내지 않는다".
// 2,000 synthetic business cards (ko/en/ja/zh, noisy confidences, mixed layouts, junk lines, odd whitespace)
// + 400 badges. Invariants: never throws, every extracted value is a substring of its (whitespace-collapsed)
// source line, confidence ∈ [0,1], provenance = ocr, and clean emails/phones are always recovered verbatim.
import { describe, expect, it } from "vitest";
import { type OcrLine, assertGrounded, normalizeEmail, parseBadge, parseBusinessCard } from "../../src";
import { type Rng, cases, collapse } from "./_gen";

type Lang = "ko" | "en" | "ja" | "zh";

const NAMES: Record<Lang, (r: Rng) => string> = {
  ko: (r) => r.pick(["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오"]) + r.pick(["민수", "영희", "지훈", "서연", "도윤", "하은", "준호", "수빈", "길동", "예린"]),
  en: (r) => `${r.pick(["Jane", "John", "Alex", "Maria", "Chris", "Priya", "Liam", "Olivia", "Noah", "Emma"])} ${r.pick(["Doe", "Smith", "Kim", "Garcia", "O'Neil", "Nguyen", "Brown", "Lee", "Martin", "Clark"])}`,
  ja: (r) => `${r.pick(["山田", "佐藤", "鈴木", "高橋", "田中", "伊藤"])} ${r.pick(["太郎", "花子", "健一", "由美", "翔", "愛"])}`,
  zh: (r) => r.pick(["王", "李", "张", "刘", "陈", "杨"]) + r.pick(["伟", "芳", "娜", "敏", "静", "强", "磊"]),
};
const COMPANIES: Record<Lang, (r: Rng) => string> = {
  ko: (r) => r.pick(["(주)", "㈜", "", ""]) + r.pick(["링코스랩", "에이스테크", "메디파트너스", "한빛솔루션", "누리벤처스"]) + r.pick(["", " 주식회사", ""]),
  en: (r) => `${r.pick(["Acme", "Northwind", "Globex", "Initech", "Umbrella", "Hooli"])} ${r.pick(["Labs", "Inc.", "Corp", "Technologies", "Ventures LLC", "Group", "Ltd"])}`,
  ja: (r) => `株式会社${r.pick(["サンプル", "未来技研", "東京ソフト", "アオバ"])}`,
  zh: (r) => `${r.pick(["上海", "北京", "深圳"])}${r.pick(["星辰", "华信", "天成"])}科技有限公司`,
};
const TITLES: Record<Lang, string[]> = {
  ko: ["대표이사", "대표", "팀장", "이사", "수석연구원", "매니저", "과장", "부장"],
  en: ["CEO", "CTO", "Senior Engineer", "Product Manager", "Director of Sales", "Co-Founder", "VP Marketing", "Founder"],
  ja: ["部長", "課長", "代表取締役", "社長"],
  zh: ["总经理", "经理", "总监"],
};
const DEPTS: Record<Lang, string[]> = {
  ko: ["마케팅팀", "영업본부", "연구소", "전략기획실"],
  en: ["Sales Team", "Engineering Dept.", "Marketing Department"],
  ja: ["営業部", "開発部"],
  zh: ["市场部", "研发部"],
};
const ADDRESSES: Record<Lang, string[]> = {
  ko: ["서울특별시 강남구 테헤란로 123, 10층", "경기도 성남시 분당구 판교역로 235 7층", "부산광역시 해운대구 센텀중앙로 97 1203호"],
  en: ["123 Main Street, Suite 400, San Francisco, CA", "55 Fifth Avenue, Floor 3, New York", "1 Market Rd. Building B, Austin"],
  ja: ["東京都港区六本木1-2-3 森タワー10階", "大阪府大阪市北区梅田2-4-9"],
  zh: ["上海市浦东新区世纪大道100号", "北京市朝阳区建国路88号楼"],
};
const PHONES: Record<Lang, (r: Rng) => { text: string; mobile: boolean }[]> = {
  ko: (r) => [
    { text: `010-${r.digits(4)}-${r.digits(4)}`, mobile: true },
    { text: `+82 10 ${r.digits(4)} ${r.digits(4)}`, mobile: true },
    { text: `010.${r.digits(4)}.${r.digits(4)}`, mobile: true },
    { text: `02-${r.int(200, 999)}-${r.digits(4)}`, mobile: false },
    { text: `(031) ${r.int(200, 999)}-${r.digits(4)}`, mobile: false },
  ],
  en: (r) => [
    { text: `+1 (${r.int(201, 989)}) ${r.int(200, 999)}-${r.digits(4)}`, mobile: false },
    { text: `${r.int(201, 989)}.${r.int(200, 999)}.${r.digits(4)}`, mobile: false },
    { text: `+44 20 ${r.digits(4)} ${r.digits(4)}`, mobile: false },
  ],
  ja: (r) => [
    { text: `+81 3-${r.digits(4)}-${r.digits(4)}`, mobile: false },
    { text: `090-${r.digits(4)}-${r.digits(4)}`, mobile: false },
  ],
  zh: (r) => [
    { text: `+86 138 ${r.digits(4)} ${r.digits(4)}`, mobile: false },
    { text: `021-${r.digits(4)} ${r.digits(4)}`, mobile: false },
  ],
};
const PHONE_LABELS = ["", "", "M. ", "Mobile: ", "T ", "Tel. ", "Fax ", "휴대폰 ", "전화 ", "携帯 ", "手机 ", "电话 ", "传真 ", "HP "];
const TLDS = ["com", "co.kr", "io", "jp", "cn", "net", "ai", "org"];
const JUNK = ["|||", "© 2026", "~ * ~", "QR", "■■■", "www", "...", "·", "#", "THANK YOU", "Since 1998", "ISO 9001"];

function email(r: Rng): string {
  const local = r.pick(["jane", "hong.gd", "a.b+exchange", "sales", "minsu_kim", "j-doe", "CEO", "x9"]) + (r.bool(0.3) ? String(r.int(1, 99)) : "");
  const dom = `${r.pick(["acme", "linkos", "medi-partners", "hanbit", "globex", "mirai"])}.${r.pick(TLDS)}`;
  return r.bool(0.15) ? `${local}@${dom}`.toUpperCase() : `${local}@${dom}`;
}

function website(r: Rng): string {
  return r.pick([`www.${r.pick(["acme", "linkos", "hanbit"])}.${r.pick(["com", "io", "co.kr"])}`, `https://${r.pick(["acme", "mirai"])}.${r.pick(["ai", "jp"])}/team`, `${r.pick(["linkos", "globex"])}.com`]);
}

function noisyConfidence(r: Rng): number | undefined {
  return r.pick([undefined, r.next(), r.int(50, 100), Number.NaN, -0.3, 1.7, 250, 0, 1, Number.POSITIVE_INFINITY]);
}

function noiseWs(r: Rng, s: string): string {
  if (!r.bool(0.25)) return s;
  return r.pick([`  ${s}  `, s.replace(/ /g, "   "), `\t${s}`, s.replace(/ /g, " \t "), `${s}\n`]);
}

interface Card {
  lang: Lang;
  lines: OcrLine[];
  cleanEmails: string[];
  cleanPhones: string[];
}

function makeCard(r: Rng, i: number): Card {
  const lang = (["ko", "en", "ja", "zh"] as const)[i % 4]!;
  const name = NAMES[lang](r);
  const title = r.pick(TITLES[lang]);
  const out: string[] = [];
  const layout = r.int(0, 5);
  if (layout === 0) out.push(`${name} ${title}`);
  else if (layout === 1) out.push(`${name}, ${title}`);
  else if (layout === 2) out.push(`${name} | ${r.pick(DEPTS[lang])} | ${title}`);
  else if (layout === 3) out.push(`${name} · ${title}, ${r.pick(TITLES[lang])}`);
  else out.push(name, r.bool(0.5) ? `${r.pick(DEPTS[lang])} ${title}` : title);
  out.push(COMPANIES[lang](r));
  const cleanEmails: string[] = [];
  const cleanPhones: string[] = [];
  const e = email(r);
  if (r.bool(0.85)) {
    out.push(r.bool(0.7) ? e : `E. ${e}`);
    cleanEmails.push(e);
  }
  for (const p of r.subset(PHONES[lang](r)).slice(0, 3)) {
    out.push(`${r.pick(PHONE_LABELS)}${p.text}`);
    cleanPhones.push(p.text);
  }
  if (r.bool(0.6)) out.push(website(r));
  if (r.bool(0.3)) out.push(r.pick(["linkedin.com/in/jane-doe", "@linkos_ai", "github.com/hong-gd", "instagram.com/acme.labs"]));
  if (r.bool(0.7)) out.push(r.pick(ADDRESSES[lang]));
  for (let j = r.int(0, 3); j > 0; j--) out.push(r.pick(JUNK));
  if (r.bool(0.2)) out.push("");
  // OCR confusions on a random non-channel line (O↔0, l↔1) — channel lines stay clean so recall stays checkable
  const ordered = r.bool(0.5) ? out : r.shuffle(out);
  const lines: OcrLine[] = ordered.map((text) => {
    const isChannel = cleanEmails.some((x) => text.includes(x)) || cleanPhones.some((x) => text.includes(x));
    let t = text;
    if (!isChannel && r.bool(0.1)) t = t.replace(/o/g, "0").replace(/l/g, "1");
    const y0 = r.int(0, 600);
    return { text: isChannel ? t : noiseWs(r, t), confidence: noisyConfidence(r), bbox: r.bool(0.6) ? { x0: r.int(0, 50), y0, x1: r.int(100, 900), y1: y0 + r.int(8, 80) } : undefined };
  });
  return { lang, lines, cleanEmails, cleanPhones };
}

const CARDS = cases(2000, 101, makeCard);

describe("QA · OCR business-card parser (2,000 generated cards)", () => {
  it.each(CARDS)("card #$i is grounded, bounded and complete", ({ c }) => {
    const res = parseBusinessCard(c.lines);
    expect(["ko", "en", "ja", "zh", "mixed"]).toContain(res.language);
    for (const f of res.fields) {
      const src = collapse(c.lines[f.sourceLine]?.text ?? "");
      expect(f.value.length, `${f.key} empty`).toBeGreaterThan(0);
      // rule 6: the value must literally exist in the OCR source line (no joined/re-ordered fragments)
      expect(src.includes(f.value), `${f.key}="${f.value}" not in "${src}"`).toBe(true);
      expect(Number.isFinite(f.confidence)).toBe(true);
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
      expect(f.provenance).toBe("ocr");
      if (f.key === "email") expect(f.normalized).toBe(normalizeEmail(f.value));
      if (["phone", "mobile", "fax"].includes(f.key)) expect(f.value.replace(/\D/g, "").length).toBeGreaterThanOrEqual(8);
    }
    expect(() => assertGrounded(res.fields, c.lines)).not.toThrow();
    // no exact duplicates of (key, value)
    const keys = res.fields.map((f) => `${f.key}\u0000${f.value}`);
    expect(new Set(keys).size).toBe(keys.length);
    // recall on clean channel lines
    const emails = res.fields.filter((f) => f.key === "email").map((f) => f.value);
    for (const e of c.cleanEmails) expect(emails).toContain(e);
    const phones = res.fields.filter((f) => ["phone", "mobile", "fax"].includes(f.key)).map((f) => f.value);
    for (const p of c.cleanPhones) expect(phones.some((v) => v.includes(p) || p.includes(v)), `phone ${p} missing in ${JSON.stringify(phones)}`).toBe(true);
    // unassigned lines are real input lines
    for (const u of res.unassigned) expect(collapse(c.lines[u.line]!.text)).toBe(u.text);
  });

  it.each([
    { name: "empty", lines: [] },
    { name: "only blanks", lines: [{ text: "" }, { text: "   " }, { text: "\t\n" }] },
    // API contract caps OCR input at 120 lines × 500 chars (capture + guest parse routes)
    { name: "max-size card", lines: Array.from({ length: 120 }, (_, i) => ({ text: (i % 2 ? "1-" : "x").repeat(250).slice(0, 500) })) },
    { name: "regex-hostile", lines: [{ text: "(((((((((((((((((((((((((((((a" }, { text: "+".repeat(500) }, { text: "1-".repeat(400) }] },
    { name: "emoji + rtl", lines: [{ text: "😀 Jane Doe 😀" }, { text: "مرحبا CEO" }, { text: "jane@😀.com" }] },
    { name: "null-ish confidences", lines: [{ text: "홍길동 대표", confidence: Number.NaN }, { text: "a@b.co", confidence: -1e9 }] },
  ])("degenerate input: $name", ({ lines }) => {
    const res = parseBusinessCard(lines as OcrLine[]);
    expect(() => assertGrounded(res.fields, lines as OcrLine[])).not.toThrow();
    for (const f of res.fields) expect(f.confidence).toBeGreaterThanOrEqual(0);
  });

  // regression: "Name, Title, Title" must not produce a jobTitle that is a re-joined string absent from the card
  it.each([
    ["Jane Doe, CEO, Founder"],
    ["홍길동 | 마케팅팀 | 팀장"],
    ["John Smith · CTO, Co-Founder"],
  ])("multi-part name/title line stays grounded: %s", (text) => {
    const lines = [{ text }, { text: "Acme Labs" }];
    const res = parseBusinessCard(lines);
    for (const f of res.fields) expect(text.includes(f.value) || "Acme Labs".includes(f.value), `${f.key}=${f.value}`).toBe(true);
    expect(res.fields.find((f) => f.key === "jobTitle")).toBeTruthy();
  });
});

const BADGES = cases(400, 202, (r, i) => {
  const lang = (["ko", "en", "ja", "zh"] as const)[i % 4]!;
  const lines: OcrLine[] = [];
  if (r.bool(0.6)) lines.push({ text: r.pick(["SPEAKER", "VISITOR", "참관객", "연사", "EXHIBITOR", "PRESS"]) });
  if (r.bool(0.5)) lines.push({ text: r.pick(["COEX Medical Expo 2026", "AI Summit Seoul", "부스 B-12", "Hall C"]) });
  const y = r.int(10, 100);
  lines.push({ text: NAMES[lang](r), bbox: { x0: 0, y0: y, x1: 400, y1: y + r.int(40, 90) }, confidence: noisyConfidence(r) });
  lines.push({ text: COMPANIES[lang](r), bbox: { x0: 0, y0: y + 100, x1: 400, y1: y + 130 } });
  if (r.bool(0.6)) lines.push({ text: r.pick(TITLES[lang]), bbox: { x0: 0, y0: y + 140, x1: 300, y1: y + 160 } });
  if (r.bool(0.4)) lines.push({ text: email(r) });
  return r.shuffle(lines);
});

describe("QA · badge parser (400 generated badges)", () => {
  it.each(BADGES)("badge #$i is grounded", ({ c }) => {
    const res = parseBadge(c);
    for (const f of res.fields) {
      expect(collapse(c[f.sourceLine]!.text).includes(f.value), `${f.key}=${f.value}`).toBe(true);
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
    // the badge type is metadata, never a contact field
    if (res.badgeType) {
      const leaked = res.fields.filter((f) => f.value === res.badgeType && ["fullName", "company", "jobTitle"].includes(f.key));
      expect(leaked, `badge type leaked: ${JSON.stringify(c.map((l) => l.text))} → ${JSON.stringify(res.fields.map((f) => [f.key, f.value]))}`).toEqual([]);
    }
  });
});
