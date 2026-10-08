// F-142 참가자 등록 — CSV/붙여넣기 파서 (pure, no I/O).
// Accepts comma / tab / semicolon separated text (Excel "CSV UTF-8", Google Sheets copy-paste), quoted cells,
// a UTF-8 BOM, and Korean/English headers. Without a recognizable header the column order is name, email, company, title.
import { nameKey, normalizeCompanyName, normalizeEmail } from "./normalize";

export const MAX_ATTENDEE_ROWS = 2000;

export interface AttendeeRow {
  fullName: string;
  email: string | null;
  company: string | null;
  jobTitle: string | null;
}

export interface AttendeeParseResult {
  rows: AttendeeRow[];
  errors: { line: number; reason: "missing_name" | "invalid_email" | "duplicate" | "too_many_rows" }[];
  /** true when the first line was recognized as a header */
  header: boolean;
}

type Col = keyof AttendeeRow;
const HEADER_ALIASES: Record<Col, string[]> = {
  fullName: ["name", "fullname", "full name", "이름", "성명", "성함", "참가자", "참가자명"],
  email: ["email", "e-mail", "mail", "이메일", "메일", "전자우편"],
  company: ["company", "organization", "organisation", "org", "회사", "회사명", "소속", "기관"],
  jobTitle: ["title", "jobtitle", "job title", "position", "role", "직책", "직함", "직위", "직급"],
};

function headerCol(cell: string): Col | null {
  const c = cell.trim().toLowerCase().replace(/[_]/g, " ").replace(/\s+/g, " ");
  for (const [k, aliases] of Object.entries(HEADER_ALIASES) as [Col, string[]][]) if (aliases.includes(c) || aliases.includes(c.replace(/\s/g, ""))) return k;
  return null;
}

function detectDelimiter(firstLine: string): string {
  const counts = [",", "\t", ";"].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

/** Minimal RFC 4180 reader: quoted cells may contain the delimiter, "" escapes and newlines. */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const d = delimiter ?? detectDelimiter(src.split(/\r?\n/, 1)[0] ?? "");
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (ch === d) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out.filter((r) => r.some((c) => c.trim() !== ""));
}

const clean = (v: string | undefined, max: number) => {
  // strip the CSV-injection guard our own exports add (toCsv prefixes formula characters with ')
  const s = (v ?? "").trim().replace(/^'(?=[=+\-@])/, "").replace(/\s+/g, " ");
  return s ? s.slice(0, max) : null;
};

export function parseAttendeeCsv(text: string): AttendeeParseResult {
  const table = parseDelimited(text);
  const errors: AttendeeParseResult["errors"] = [];
  if (!table.length) return { rows: [], errors, header: false };
  const mapped = table[0]!.map(headerCol);
  // any recognized column name means the first line is a header (a header without a name column → every row is missing_name)
  const header = mapped.some(Boolean);
  const cols: (Col | null)[] = header ? mapped : ["fullName", "email", "company", "jobTitle"];
  const rows: AttendeeRow[] = [];
  const seen = new Set<string>();
  const body = header ? table.slice(1) : table;
  body.forEach((cells, i) => {
    const line = i + (header ? 2 : 1);
    if (rows.length >= MAX_ATTENDEE_ROWS) {
      if (!errors.some((e) => e.reason === "too_many_rows")) errors.push({ line, reason: "too_many_rows" });
      return;
    }
    const get = (k: Col) => {
      const idx = cols.indexOf(k);
      return idx >= 0 ? cells[idx] : undefined;
    };
    const fullName = clean(get("fullName"), 120);
    if (!fullName) return void errors.push({ line, reason: "missing_name" });
    const rawEmail = clean(get("email"), 200);
    const email = rawEmail ? normalizeEmail(rawEmail) : null;
    if (rawEmail && !email) return void errors.push({ line, reason: "invalid_email" });
    const row: AttendeeRow = { fullName, email, company: clean(get("company"), 160), jobTitle: clean(get("jobTitle"), 160) };
    const key = registrantKeySource(row);
    if (seen.has(key)) return void errors.push({ line, reason: "duplicate" });
    seen.add(key);
    rows.push(row);
  });
  return { rows, errors, header };
}

/**
 * Stable identity of a registrant within one event (hashed before storage): the normalized e-mail, or
 * name + company when the organizer has no e-mail. Re-importing the same list updates instead of duplicating.
 */
export function registrantKeySource(row: Pick<AttendeeRow, "fullName" | "email" | "company">): string {
  const email = row.email ? normalizeEmail(row.email) : null;
  if (email) return `email:${email}`;
  return `name:${nameKey(row.fullName)}|${row.company ? normalizeCompanyName(row.company) : ""}`;
}
