// F-087 일정 후보 / F-107 캘린더 예약 / F-108 일정 승인 — 순수 일정 계산 (타임존, 가용 슬롯, 한국어 일정 표현 파서).
// 파서는 텍스트에 있는 날짜 표현만 해석한다. 날짜 표현이 없으면 후보를 만들지 않는다(사실 생성 금지).

export interface Interval {
  start: Date;
  end: Date;
}

export interface WeeklyWindow {
  /** 0 = Sunday … 6 = Saturday (local to the page time zone) */
  weekday: number;
  /** minutes after local midnight */
  start: number;
  end: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    dtf(tz);
    return true;
  } catch {
    return false;
  }
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(date: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = Object.fromEntries(dtf(tz).formatToParts(date).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: WD[parts.weekday!] ?? 0 };
}

/** Offset (minutes) of tz at the given instant: local = utc + offset. */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

/** Local wall-clock (y, m, d, minuteOfDay) in tz → UTC instant. Handles DST by re-evaluating the offset. */
export function zonedToUtc(year: number, month: number, day: number, minuteOfDay: number, tz: string): Date {
  const naive = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  let guess = new Date(naive - tzOffsetMinutes(new Date(naive), tz) * 60000);
  const off2 = tzOffsetMinutes(guess, tz);
  guess = new Date(naive - off2 * 60000);
  return guess;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Add `days` calendar days to a local date in tz. */
function addLocalDays(y: number, m: number, d: number, days: number): { year: number; month: number; day: number } {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export interface SlotOptions {
  windows: WeeklyWindow[];
  tz: string;
  from: Date;
  days: number;
  durationMin: number;
  stepMin?: number;
  bufferMin?: number;
  minNoticeMin?: number;
  busy: Interval[];
  now?: Date;
  limit?: number;
}

/** F-107: free slots = weekly availability windows − busy intervals (± buffer) − min notice. */
export function computeFreeSlots(o: SlotOptions): Interval[] {
  const step = o.stepMin ?? Math.min(o.durationMin, 30);
  const buffer = (o.bufferMin ?? 0) * 60000;
  const notBefore = (o.now ?? new Date()).getTime() + (o.minNoticeMin ?? 0) * 60000;
  const busy = o.busy.map((b) => ({ start: new Date(b.start.getTime() - buffer), end: new Date(b.end.getTime() + buffer) }));
  const start = zonedParts(o.from, o.tz);
  const out: Interval[] = [];
  for (let i = 0; i < o.days; i++) {
    const day = addLocalDays(start.year, start.month, start.day, i);
    const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
    for (const w of o.windows.filter((x) => x.weekday === weekday).sort((a, b) => a.start - b.start)) {
      for (let m = w.start; m + o.durationMin <= w.end; m += step) {
        const s = zonedToUtc(day.year, day.month, day.day, m, o.tz);
        const slot = { start: s, end: new Date(s.getTime() + o.durationMin * 60000) };
        if (s.getTime() < notBefore) continue;
        if (busy.some((b) => overlaps(slot, b))) continue;
        out.push(slot);
        if (o.limit && out.length >= o.limit) return out;
      }
    }
  }
  return out;
}

export function validateWindows(windows: WeeklyWindow[]): string[] {
  const errors: string[] = [];
  for (const w of windows) {
    if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) errors.push("weekday");
    if (w.start < 0 || w.end > 24 * 60 || w.start >= w.end) errors.push(`range:${w.weekday}`);
  }
  for (let d = 0; d < 7; d++) {
    const ws = windows.filter((w) => w.weekday === d).sort((a, b) => a.start - b.start);
    for (let i = 1; i < ws.length; i++) if (ws[i]!.start < ws[i - 1]!.end) errors.push(`overlap:${d}`);
  }
  return errors;
}

export const DEFAULT_WINDOWS: WeeklyWindow[] = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: 10 * 60, end: 17 * 60 }));

// ---------- F-087 schedule hint parser (Korean + English) ----------
export interface ScheduleCandidate {
  start: Date;
  end: Date;
  confidence: number;
  matched: string;
}

const KO_WD: Record<string, number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const EN_WD: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseTime(s: string): { minutes: number; matched: string } | null {
  let m = s.match(/(오전|오후|아침|낮|저녁|밤)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*(반))?/);
  if (m) {
    let h = Number(m[2]);
    const min = m[4] ? 30 : Number(m[3] ?? 0);
    const ap = m[1];
    if ((ap === "오후" || ap === "저녁" || ap === "밤") && h < 12) h += 12;
    if (ap === "낮" && h < 7) h += 12;
    if (!ap && h >= 1 && h <= 6) h += 12; // "3시" in a business context = 15:00
    if (h > 23 || min > 59) return null;
    return { minutes: h * 60 + min, matched: m[0] };
  }
  m = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return { minutes: Number(m[1]) * 60 + Number(m[2]), matched: m[0] };
  m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3]!.toLowerCase() === "pm") h += 12;
    return { minutes: h * 60 + Number(m[2] ?? 0), matched: m[0] };
  }
  if (/점심/.test(s)) return { minutes: 12 * 60, matched: "점심" };
  if (/저녁/.test(s)) return { minutes: 18 * 60, matched: "저녁" };
  if (/오전/.test(s)) return { minutes: 10 * 60, matched: "오전" };
  if (/오후/.test(s)) return { minutes: 14 * 60, matched: "오후" };
  return null;
}

/**
 * Parse a next-meeting hint ("다음 주 화요일 오후 3시", "10/20 14:00", "내일", "next Tuesday 3pm").
 * Returns up to 3 candidates; empty when the text contains no date expression.
 */
export function parseScheduleHint(hint: string, now: Date, tz: string, durationMin = 60): ScheduleCandidate[] {
  const s = hint.trim();
  if (!s) return [];
  const today = zonedParts(now, tz);
  const time = parseTime(s);
  const days: { year: number; month: number; day: number; confidence: number; matched: string }[] = [];

  let m: RegExpMatchArray | null;
  if ((m = s.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/))) {
    days.push({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), confidence: 0.9, matched: m[0] });
  } else if ((m = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/)) || (m = s.match(/(?<![\d:])(\d{1,2})\/(\d{1,2})(?![\d:])/))) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    let year = today.year;
    if (month < today.month || (month === today.month && day < today.day)) year += 1;
    days.push({ year, month, day, confidence: 0.85, matched: m[0] });
  } else if ((m = s.match(/(오늘|내일|모레|글피|today|tomorrow)/i))) {
    const off = { 오늘: 0, today: 0, 내일: 1, tomorrow: 1, 모레: 2, 글피: 3 }[m[1]!.toLowerCase() as "오늘"] ?? 0;
    days.push({ ...addLocalDays(today.year, today.month, today.day, off), confidence: 0.85, matched: m[0] });
  } else if ((m = s.match(/(다음\s*주|담주|차주|이번\s*주|next\s+week|this\s+week|next)?\s*([일월화수목금토])요일/)) || (m = s.match(/(next|this)?\s*\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/i))) {
    const wd = KO_WD[m[2]!] ?? EN_WD[m[2]!.toLowerCase()]!;
    const qual = (m[1] ?? "").replace(/\s+/g, "").toLowerCase();
    let off: number;
    if (/다음주|담주|차주|nextweek|^next$/.test(qual)) {
      // weekday of the following week (Mon-based weeks)
      const mondayOffset = ((1 - today.weekday + 7) % 7) || 7;
      off = mondayOffset + ((wd + 6) % 7);
    } else if (/이번주|thisweek|^this$/.test(qual)) {
      off = (wd - today.weekday + 7) % 7;
    } else {
      off = (wd - today.weekday + 7) % 7 || 7;
    }
    days.push({ ...addLocalDays(today.year, today.month, today.day, off), confidence: 0.8, matched: m[0] });
  } else if ((m = s.match(/(다음\s*주|담주|차주|next\s+week)/i))) {
    const mondayOffset = ((1 - today.weekday + 7) % 7) || 7;
    for (const extra of [1, 2, 3]) days.push({ ...addLocalDays(today.year, today.month, today.day, mondayOffset + extra), confidence: 0.4, matched: m[0] });
  } else if ((m = s.match(/(\d{1,2})\s*(?:일|주|days?|weeks?)\s*(?:후|뒤|later|from now)/i))) {
    const unit = /주|week/i.test(m[0]) ? 7 : 1;
    days.push({ ...addLocalDays(today.year, today.month, today.day, Number(m[1]) * unit), confidence: 0.7, matched: m[0] });
  }
  if (!days.length) return [];

  const out: ScheduleCandidate[] = [];
  for (const d of days) {
    if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31) continue;
    const times = time ? [time.minutes] : days.length > 1 ? [10 * 60] : [10 * 60, 14 * 60, 16 * 60];
    for (const t of times) {
      const start = zonedToUtc(d.year, d.month, d.day, t, tz);
      if (start.getTime() < now.getTime()) continue;
      out.push({ start, end: new Date(start.getTime() + durationMin * 60000), confidence: time ? d.confidence : Math.min(d.confidence, 0.5), matched: [d.matched, time?.matched].filter(Boolean).join(" ") });
    }
  }
  return out.slice(0, 3);
}

/** F-105: due dates for a follow-up sequence at 09:00 local, moved off weekends. */
export function sequenceDueDates(start: Date, offsets: number[], tz: string, hourLocal = 9): Date[] {
  const p = zonedParts(start, tz);
  return offsets.map((off) => {
    let d = addLocalDays(p.year, p.month, p.day, off);
    let wd = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
    while (off > 0 && (wd === 0 || wd === 6)) {
      d = addLocalDays(d.year, d.month, d.day, 1);
      wd = (wd + 1) % 7;
    }
    const at = zonedToUtc(d.year, d.month, d.day, hourLocal * 60, tz);
    return off === 0 && at < start ? start : at;
  });
}
