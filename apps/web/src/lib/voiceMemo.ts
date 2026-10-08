// F-080 음성 메모 구조화 — deterministic, on-device extractor (no network, no model).
// Pulls to-do-like sentences and their due dates out of a dictated/typed note so the UI can offer them as
// follow-up suggestions. It never invents content: every title is the user's own sentence (trimmed), and a due
// date is only set when the sentence names one. Nothing is created here — the UI asks for confirmation per item.
// Pure functions only (unit-tested in tests/e2e/i18n-app-voice.spec.ts).

export type MemoTodoKind = "send_material" | "meeting_request" | "check_in" | "custom";

export interface MemoTodo {
  /** stable within one extraction (index-based) */
  id: string;
  /** the user's own sentence, trimmed (max 200 chars — the follow-up title limit) */
  title: string;
  kind: MemoTodoKind;
  /** ISO timestamp (09:00 local on the due day) or null when the sentence names no date */
  dueAt: string | null;
  /** the phrase the date came from, e.g. "다음 주 화요일" / "by Friday" */
  dueText: string | null;
  /** which rule matched — shown as the "자동 추출" reason */
  cue: string;
}

// ---- action cues (ko + en). Order matters only for the reported cue. ----
const ACTION_CUES: RegExp[] = [
  /하기로|기로\s*했|기로\s*함|기로\s*약속/,
  /보내(?:기|드리기|\s*드리기|드릴게|줄게|야|기로|겠)|보낼게|보낼\s*것/,
  /전달(?:하기|드리기|할게|해야|하기로)?/,
  /공유(?:하기|드리기|할게|해야|하기로)/,
  /연락(?:하기|드리기|할게|해야|하기로|\s*드리기)/,
  /(?:미팅|회의|약속|일정|통화|콜)\s*(?:잡기|잡을|잡아|잡자|잡기로|하기로|예정)/,
  /(?:확인|검토|준비|정리|작성|소개|회신|답장|답변|제출)(?:하기|해야|할게|드리기|하기로|해\s*주기|해\s*드리기)/,
  /해야\s*(?:함|한다|해|돼|됨|겠)|할\s*것|할\s*일|잊지\s*말기/,
  /\b(?:send|share|follow[\s-]?up|email|call|schedule|book|set up|prepare|review|introduce|reply|remind)\b/i,
  /\b(?:need to|have to|will|to-?do|must|should)\b/i,
];

const SEND_RE = /보내|전달|자료|제안서|견적|소개서|공유|deck|proposal|quote|send|share|material/i;
const MEET_RE = /미팅|회의|만나|만남|약속|일정|통화|콜|meeting|meet|schedule|call|book|lunch|coffee|점심|커피|식사/i;
const CHECKIN_RE = /안부|연락|check[\s-]?in|catch up|reach out/i;

const PAST_RE = /(?:았|었|였|했|웠|났|갔|왔)(?:다|어요|어|음|습니다|었다|던)|\b(?:met|was|were|did|had|went|talked)\b/i;

const KO_DOW = ["일", "월", "화", "수", "목", "금", "토"];
const EN_DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const EN_DOW_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function at9(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 9, 0, 0, 0);
}
/** Monday of the week containing d (weeks start Monday). */
function mondayOf(d: Date): Date {
  const dow = d.getDay(); // 0 = Sun
  return addDays(d, dow === 0 ? -6 : 1 - dow);
}
/** Next occurrence of weekday `dow` strictly after `now`. */
function nextDow(now: Date, dow: number): Date {
  let diff = (dow - now.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(now, diff);
}
/** Weekday `dow` in the week after now's week. */
function dowNextWeek(now: Date, dow: number): Date {
  const mon = addDays(mondayOf(now), 7);
  return addDays(mon, dow === 0 ? 6 : dow - 1);
}
/** Weekday `dow` in now's week (falls back to the next occurrence when it has already passed). */
function dowThisWeek(now: Date, dow: number): Date {
  const d = addDays(mondayOf(now), dow === 0 ? 6 : dow - 1);
  return d.getTime() < at9(now).getTime() - 864e5 / 2 ? nextDow(now, dow) : d;
}
function monthDay(now: Date, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let d = new Date(now.getFullYear(), month - 1, day, 9, 0, 0, 0);
  if (d.getMonth() !== month - 1) return null; // e.g. 2/31
  if (d.getTime() < at9(now).getTime()) d = new Date(now.getFullYear() + 1, month - 1, day, 9, 0, 0, 0);
  return d;
}

/** Find a due date in one sentence. Returns the date and the matched phrase, or null. */
export function findDue(sentence: string, now: Date): { date: Date; text: string } | null {
  const s = sentence;
  let m: RegExpExecArray | null;

  // ISO-ish absolute dates: 2026-10-20 / 2026.10.20 / 2026/10/20
  if ((m = /(20\d{2})[-./](\d{1,2})[-./](\d{1,2})/.exec(s))) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0, 0);
    if (d.getMonth() === Number(m[2]) - 1) return { date: d, text: m[0] };
  }
  // 10월 20일
  if ((m = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(s))) {
    const d = monthDay(now, Number(m[1]), Number(m[2]));
    if (d) return { date: d, text: m[0] };
  }
  // 10/20 (not part of a longer number or fraction-like pattern)
  // (no lookbehind: older iOS Safari cannot parse it)
  if ((m = /(^|[^\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/.exec(s))) {
    const d = monthDay(now, Number(m[2]), Number(m[3]));
    if (d) return { date: d, text: `${m[2]}/${m[3]}` };
  }
  // 다음 주 화요일 / 담주 화욜 / 이번 주 금요일 / 금요일
  if ((m = /(다음\s*주|담주|차주|이번\s*주|금주)?\s*([월화수목금토일])\s*요일/.exec(s))) {
    const dow = KO_DOW.indexOf(m[2]!);
    const which = (m[1] ?? "").replace(/\s/g, "");
    const date = /다음주|담주|차주/.test(which) ? dowNextWeek(now, dow) : /이번주|금주/.test(which) ? dowThisWeek(now, dow) : nextDow(now, dow);
    return { date, text: m[0].trim() };
  }
  // next friday / this friday / by friday / on fri
  if ((m = new RegExp(`\\b(next|this|by|on)?\\s*(${EN_DOW.join("|")}|${EN_DOW_SHORT.join("|")})\\b`, "i").exec(s))) {
    const word = m[2]!.toLowerCase();
    const dow = EN_DOW.indexOf(word) >= 0 ? EN_DOW.indexOf(word) : EN_DOW_SHORT.indexOf(word);
    const which = (m[1] ?? "").toLowerCase();
    const date = which === "next" ? dowNextWeek(now, dow) : which === "this" ? dowThisWeek(now, dow) : nextDow(now, dow);
    return { date, text: m[0].trim() };
  }
  // N일 후/뒤/내, N주 후/뒤, in N days/weeks
  if ((m = /(\d{1,2})\s*일\s*(?:후|뒤|내|이내)/.exec(s))) return { date: addDays(now, Number(m[1])), text: m[0] };
  if ((m = /(\d{1,2})\s*주\s*(?:후|뒤|내|이내)/.exec(s))) return { date: addDays(now, Number(m[1]) * 7), text: m[0] };
  if ((m = /\bin\s+(\d{1,2})\s+days?\b/i.exec(s))) return { date: addDays(now, Number(m[1])), text: m[0] };
  if ((m = /\bin\s+(\d{1,2})\s+weeks?\b/i.exec(s))) return { date: addDays(now, Number(m[1]) * 7), text: m[0] };
  // relative words
  if ((m = /모레|내일모레/.exec(s))) return { date: addDays(now, 2), text: m[0] };
  if ((m = /내일|\btomorrow\b/i.exec(s))) return { date: addDays(now, 1), text: m[0] };
  if ((m = /오늘|\btoday\b|\btonight\b/i.exec(s))) return { date: at9(now), text: m[0] };
  if ((m = /다음\s*주|담주|차주|\bnext week\b/i.exec(s))) return { date: addDays(mondayOf(now), 7), text: m[0] };
  if ((m = /이번\s*주|금주|\bthis week\b/i.exec(s))) return { date: dowThisWeek(now, 5), text: m[0] };
  if ((m = /주말|\bweekend\b/i.exec(s))) return { date: dowThisWeek(now, 6), text: m[0] };
  if ((m = /월말|이번\s*달\s*(?:안|내|중)|\bend of (?:the )?month\b/i.exec(s))) return { date: new Date(now.getFullYear(), now.getMonth() + 1, 0, 9, 0, 0, 0), text: m[0] };
  if ((m = /다음\s*달|\bnext month\b/i.exec(s))) return { date: new Date(now.getFullYear(), now.getMonth() + 1, 1, 9, 0, 0, 0), text: m[0] };
  return null;
}

/** Split a memo into sentences (punctuation, line breaks, and Korean connective "~고," / "그리고"). */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .replace(/([.!?。])\s+/g, "$1\n")
    .split(/\n+|\s*[;•·]\s*|,\s*(?:그리고|and then|also)\s+|\s+그리고\s+/i)
    .map((x) => x.trim().replace(/^(?:[-*•]|\d{1,2}[.)])\s+/, "").trim())
    .filter((x) => x.length >= 2);
}

function kindOf(s: string): MemoTodoKind {
  if (SEND_RE.test(s)) return "send_material";
  if (MEET_RE.test(s)) return "meeting_request";
  if (CHECKIN_RE.test(s)) return "check_in";
  return "custom";
}

function cleanTitle(s: string): string {
  return s.replace(/[.!?。]+$/u, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Extract follow-up suggestions from a memo. Deterministic for a given (text, now). */
export function extractTodos(text: string, now: Date = new Date()): MemoTodo[] {
  const out: MemoTodo[] = [];
  const seen = new Set<string>();
  splitSentences(text).forEach((sentence, i) => {
    const action = ACTION_CUES.find((re) => re.test(sentence));
    const due = findDue(sentence, now);
    if (!action && !due) return;
    // a date alone is not a to-do when the sentence reports something that already happened ("오늘 코엑스에서 만났다")
    if (!action && PAST_RE.test(sentence)) return;
    const title = cleanTitle(sentence);
    if (!title || seen.has(title)) return;
    seen.add(title);
    out.push({
      id: `todo-${i}`,
      title,
      kind: kindOf(sentence),
      dueAt: due ? due.date.toISOString() : null,
      dueText: due ? due.text : null,
      cue: action ? (action.exec(sentence)?.[0] ?? "").trim() : (due?.text ?? ""),
    });
  });
  return out.slice(0, 10);
}

/** "mm:ss" for the dictation timer. */
export function formatElapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
