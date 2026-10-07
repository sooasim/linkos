// ICS (RFC 5545) — 모든 일정의 폴백 다운로드. 캘린더 연동이 없어도 사용자는 .ics 로 자기 캘린더에 넣을 수 있다.

export interface IcsEvent {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  organizer?: { name?: string | null; email: string } | null;
  attendees?: { name?: string | null; email: string }[];
  sequence?: number;
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  dtstamp?: Date;
}

export function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

const enc = new TextEncoder();

/** Fold content lines at 75 octets without splitting a UTF-8 sequence (RFC 5545 3.1). */
export function foldLine(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

function param(name: string | null | undefined) {
  return name ? `;CN="${name.replace(/["\r\n;:,]/g, " ").trim()}"` : "";
}

export function buildIcs(events: IcsEvent | IcsEvent[], opts: { method?: "PUBLISH" | "REQUEST" } = {}): string {
  const list = Array.isArray(events) ? events : [events];
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//LINKOS//Scheduling//KO", "CALSCALE:GREGORIAN", `METHOD:${opts.method ?? "PUBLISH"}`];
  for (const e of list) {
    if (/[\r\n]/.test(e.uid)) throw new Error("invalid uid");
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${icsDate(e.dtstamp ?? new Date())}`, `DTSTART:${icsDate(e.start)}`, `DTEND:${icsDate(e.end)}`, `SUMMARY:${icsEscape(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
    if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
    if (e.url) lines.push(`URL:${e.url.replace(/[\r\n]/g, "")}`);
    if (e.organizer && !/[\r\n]/.test(e.organizer.email)) lines.push(`ORGANIZER${param(e.organizer.name)}:mailto:${e.organizer.email}`);
    for (const a of e.attendees ?? []) if (!/[\r\n]/.test(a.email)) lines.push(`ATTENDEE${param(a.name)};ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${a.email}`);
    lines.push(`SEQUENCE:${e.sequence ?? 0}`, `STATUS:${e.status ?? "CONFIRMED"}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
