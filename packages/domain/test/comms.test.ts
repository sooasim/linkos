// Track B pure logic: F-111 templates, F-105 sequences, F-087/F-107 scheduling, ICS, F-106 MIME, F-127 field mapping, F-123 webhooks.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAPPINGS,
  applyMapping,
  buildIcs,
  buildMimeMessage,
  computeFreeSlots,
  encodeHeader,
  foldLine,
  isPrivateAddress,
  isRetryableStatus,
  parseScheduleHint,
  renderTemplate,
  sequenceDueDates,
  shortMessage,
  splitName,
  templateVariables,
  tzOffsetMinutes,
  validateMapping,
  validateTemplate,
  validateWebhookUrl,
  validateWindows,
  webhookRetryDelaySec,
  zonedParts,
  zonedToUtc,
} from "../src";

const SEOUL = "Asia/Seoul";

describe("F-111 템플릿", () => {
  it("renders known variables and reports missing ones without inventing values", () => {
    const t = "{{name}}님, {{place}}에서 반가웠습니다. {{myName}} 드림";
    expect(templateVariables(t)).toEqual(["name", "place", "myName"]);
    const r = renderTemplate(t, { name: "김민수", myName: "이지은" });
    expect(r.text).toBe("김민수님, 에서 반가웠습니다. 이지은 드림");
    expect(r.missing).toEqual(["place"]);
  });
  it("rejects unknown variables at save time", () => {
    expect(validateTemplate(["{{name}} {{salary}}"])).toEqual({ ok: false, unknown: ["salary"] });
    expect(validateTemplate(["{{ firstName }}"]).ok).toBe(true);
  });
  it("splits Korean and western names", () => {
    expect(splitName("김민수")).toEqual({ last: "김", first: "민수" });
    expect(splitName("John Ronald Smith")).toEqual({ first: "John Ronald", last: "Smith" });
    expect(splitName("Cher")).toEqual({ first: "", last: "Cher" });
  });
});

describe("F-105 후속 메시지", () => {
  it("short messenger drafts cut at a sentence boundary", () => {
    const s = shortMessage("안녕하세요 김민수님. 어제 행사에서 뵙게 되어 반가웠습니다. 다음 주에 자료를 보내드리겠습니다. 좋은 하루 보내세요.", 50);
    expect(s.length).toBeLessThanOrEqual(50);
    expect(s.endsWith(".")).toBe(true);
  });
  it("sequence due dates skip weekends at 09:00 local", () => {
    const fri = new Date("2026-10-09T03:00:00Z"); // Fri 12:00 KST
    const [d0, d1, d3] = sequenceDueDates(fri, [0, 1, 3], SEOUL);
    expect(d0!.toISOString()).toBe(fri.toISOString());
    expect(zonedParts(d1!, SEOUL)).toMatchObject({ weekday: 1, hour: 9 }); // Sat → Mon
    expect(zonedParts(d3!, SEOUL)).toMatchObject({ weekday: 1, day: 12 });
  });
});

describe("F-087 / F-107 scheduling", () => {
  const now = new Date("2026-10-07T01:00:00Z"); // Wed 10:00 KST
  it("time zone math is DST-safe", () => {
    expect(tzOffsetMinutes(now, SEOUL)).toBe(540);
    expect(zonedToUtc(2026, 10, 20, 15 * 60, SEOUL).toISOString()).toBe("2026-10-20T06:00:00.000Z");
    // New York: 2026-11-01 is the DST end day
    expect(zonedToUtc(2026, 11, 2, 9 * 60, "America/New_York").toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(zonedToUtc(2026, 10, 30, 9 * 60, "America/New_York").toISOString()).toBe("2026-10-30T13:00:00.000Z");
  });
  it("parses Korean next-meeting hints", () => {
    const [c] = parseScheduleHint("다음 주 화요일 오후 3시", now, SEOUL);
    expect(c!.start.toISOString()).toBe("2026-10-13T06:00:00.000Z");
    expect(c!.confidence).toBeGreaterThan(0.7);
    expect(parseScheduleHint("10/20 14:00", now, SEOUL)[0]!.start.toISOString()).toBe("2026-10-20T05:00:00.000Z");
    expect(parseScheduleHint("내일 오전 10시 30분", now, SEOUL)[0]!.start.toISOString()).toBe("2026-10-08T01:30:00.000Z");
    expect(parseScheduleHint("금요일", now, SEOUL)).toHaveLength(3); // no time → 3 time options, low confidence
    expect(parseScheduleHint("금요일", now, SEOUL)[0]!.confidence).toBeLessThanOrEqual(0.5);
    expect(parseScheduleHint("next Tuesday 3pm", now, SEOUL)[0]!.start.toISOString()).toBe("2026-10-13T06:00:00.000Z");
    expect(parseScheduleHint("다음 주", now, SEOUL)).toHaveLength(3);
  });
  it("never invents a date when the hint has none", () => {
    expect(parseScheduleHint("곧 다시 뵙죠", now, SEOUL)).toEqual([]);
    expect(parseScheduleHint("", now, SEOUL)).toEqual([]);
  });
  it("free slots = availability − busy − notice", () => {
    const slots = computeFreeSlots({
      windows: [{ weekday: 4, start: 10 * 60, end: 12 * 60 }], // Thu 10–12
      tz: SEOUL,
      from: now,
      days: 7,
      durationMin: 30,
      busy: [{ start: new Date("2026-10-08T01:30:00Z"), end: new Date("2026-10-08T02:00:00Z") }], // Thu 10:30–11:00 KST
      now,
    });
    expect(slots.map((s) => zonedParts(s.start, SEOUL).hour * 60 + zonedParts(s.start, SEOUL).minute)).toEqual([600, 660, 690]);
    expect(validateWindows([{ weekday: 1, start: 600, end: 540 }])).toContain("range:1");
    expect(validateWindows([{ weekday: 1, start: 600, end: 700 }, { weekday: 1, start: 650, end: 800 }])).toContain("overlap:1");
  });
});

describe("ICS fallback", () => {
  it("escapes, folds at 75 octets and uses UTC", () => {
    const ics = buildIcs({ uid: "c1@linkos", start: new Date("2026-10-20T06:00:00Z"), end: new Date("2026-10-20T07:00:00Z"), summary: "미팅; 파일럿, 논의", description: "줄1\n줄2 ".repeat(20), attendees: [{ name: "김민수", email: "kim@a.io" }], dtstamp: new Date("2026-10-07T00:00:00Z") });
    expect(ics).toContain("DTSTART:20261020T060000Z");
    expect(ics).toContain("SUMMARY:미팅\\; 파일럿\\, 논의");
    expect(ics).toContain('ATTENDEE;CN="김민수";ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:kim@a.io');
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(foldLine("가".repeat(40)).split("\r\n ").join("")).toBe("가".repeat(40));
  });
});

describe("F-106 MIME", () => {
  it("encodes UTF-8 subject/body and blocks header injection", () => {
    const raw = buildMimeMessage({ to: "kim@a.io", toName: "김민수", subject: "만나서 반가웠습니다", body: "안녕하세요\n감사합니다", date: new Date("2026-10-07T00:00:00Z") });
    expect(raw).toMatch(/^To: =\?UTF-8\?B\?.+\?= <kim@a\.io>\r\n/);
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    const body = raw.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("안녕하세요\r\n감사합니다");
    expect(() => buildMimeMessage({ to: "a@b.io\r\nBcc: x@y.io", subject: "x", body: "y" })).toThrow();
    expect(() => encodeHeader("hi\r\nBcc: x@y.io")).toThrow();
  });
});

describe("F-127 field mapping", () => {
  const c = { id: "11111111-1111-1111-1111-111111111111", fullName: "김민수", company: "링코스", email: "kim@a.io", phone: null, jobTitle: "" };
  it("defaults are valid and empty values are never pushed", () => {
    for (const [p, objs] of Object.entries(DEFAULT_MAPPINGS)) for (const [o, e] of Object.entries(objs)) expect(validateMapping(p as "hubspot", o as "contact", e!)).toEqual({ ok: true, errors: [] });
    const r = applyMapping("salesforce", "lead", DEFAULT_MAPPINGS.salesforce.lead!, c);
    expect(r.values).toEqual({ FirstName: "민수", LastName: "김", Company: "링코스", Email: "kim@a.io" });
    expect(r.missingRequired).toEqual([]);
    expect(applyMapping("salesforce", "lead", DEFAULT_MAPPINGS.salesforce.lead!, { ...c, company: null }).missingRequired).toEqual(["Company"]);
  });
  it("rejects invalid custom mappings", () => {
    expect(validateMapping("salesforce", "contact", [{ local: "email", remote: "Email" }]).errors).toContain("missing_required:LastName");
    expect(validateMapping("hubspot", "contact", [{ local: "email", remote: "e mail" }, { local: "phone", remote: "x" }, { local: "fullName", remote: "X" }]).errors).toEqual(["invalid_remote:e mail", "duplicate_remote:X"]);
    expect(validateMapping("hubspot", "lead", []).errors).toContain("unsupported_object:lead");
  });
});

describe("F-123 webhooks", () => {
  it("SSRF guard and retry policy", () => {
    expect(validateWebhookUrl("https://hooks.zapier.com/hooks/catch/1/abc").ok).toBe(true);
    for (const bad of ["http://hooks.example.com", "https://127.0.0.1/x", "https://10.0.0.5/", "https://[::1]/", "https://169.254.169.254/latest", "https://user:pw@example.com/", "https://localhost/", "https://example.com:22/"]) expect(validateWebhookUrl(bad).ok).toBe(false);
    expect(validateWebhookUrl("http://127.0.0.1:4000/x", { allowPrivate: true }).ok).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.0.1")).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(null)).toBe(true);
    expect([1, 2, 3].map(webhookRetryDelaySec)).toEqual([30, 60, 120]);
    expect(webhookRetryDelaySec(30)).toBe(21600);
  });
});
