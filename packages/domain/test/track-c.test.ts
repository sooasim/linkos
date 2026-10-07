// Track C pure logic: F-014/F-144 badge OCR, F-082/F-083 transcript + diarization grouping,
// F-084~F-086 evidence linking, F-052/F-150/F-178/F-179 offline outbox.
import { describe, expect, it } from "vitest";
import {
  assertGrounded,
  backoffMs,
  classifyRequest,
  conflictFields,
  createOutboxItem,
  decide,
  dominantLanguage,
  durationToMs,
  enqueue,
  extractCommitments,
  groupWordsIntoSegments,
  linkEvidence,
  MAX_ATTEMPTS,
  offsetSegments,
  type OutboxItem,
  parseBadge,
  readyItems,
  resolveConflict,
  summarize,
  transcriptText,
} from "../src";

const box = (y0: number, h: number) => ({ x0: 10, y0, x1: 300, y1: y0 + h });

describe("F-014/F-144 badge OCR layout", () => {
  it("maps the tallest name line, company and title; badge type is metadata only", () => {
    const lines = [
      { text: "AI SUMMIT SEOUL 2026", confidence: 92, bbox: box(5, 30) },
      { text: "김민준", confidence: 95, bbox: box(80, 70) },
      { text: "메디파트너스", confidence: 90, bbox: box(170, 30) },
      { text: "사업개발 팀장", confidence: 88, bbox: box(210, 24) },
      { text: "SPEAKER", confidence: 97, bbox: box(300, 40) },
      { text: "mj@medi.test", confidence: 90, bbox: box(350, 18) },
    ];
    const r = parseBadge(lines);
    const get = (k: string) => r.fields.find((f) => f.key === k)?.value;
    expect(get("fullName")).toBe("김민준");
    expect(get("company")).toBe("메디파트너스");
    expect(get("jobTitle")).toBe("사업개발 팀장");
    expect(get("email")).toBe("mj@medi.test");
    expect(r.badgeType).toBe("SPEAKER");
    expect(r.fields.some((f) => f.value === "SPEAKER" || f.value.includes("SUMMIT"))).toBe(false);
    assertGrounded(r.fields, lines);
  });

  it("works for Latin badges without boxes (first name-like line) and never invents values", () => {
    const lines = [{ text: "VISITOR" }, { text: "Jane Doe" }, { text: "Acme Labs Inc." }, { text: "Head of Partnerships" }];
    const r = parseBadge(lines);
    expect(r.fields.find((f) => f.key === "fullName")?.value).toBe("Jane Doe");
    expect(r.fields.find((f) => f.key === "company")?.value).toBe("Acme Labs Inc.");
    expect(r.fields.find((f) => f.key === "jobTitle")?.value).toBe("Head of Partnerships");
    expect(r.badgeType).toBe("VISITOR");
    assertGrounded(r.fields, lines);
  });
});

describe("F-082/F-083 transcript segments", () => {
  it("parses Google durations and groups words by speaker / pause", () => {
    expect(durationToMs("1.250s")).toBe(1250);
    expect(durationToMs({ seconds: "2", nanos: 500_000_000 })).toBe(2500);
    const words = [
      { word: "안녕하세요", startMs: 0, endMs: 600, speaker: "1", confidence: 0.9 },
      { word: "반갑습니다", startMs: 650, endMs: 1200, speaker: "1", confidence: 0.8 },
      { word: "네", startMs: 1400, endMs: 1600, speaker: "2" },
      { word: "제안서", startMs: 1700, endMs: 2100, speaker: "2" },
      { word: "보내드리겠습니다.", startMs: 2150, endMs: 2900, speaker: "2" },
      { word: "다음", startMs: 9000, endMs: 9300, speaker: "2" }, // long pause → new segment
    ];
    const segs = groupWordsIntoSegments(words);
    expect(segs.map((s) => [s.speaker, s.text])).toEqual([
      ["1", "안녕하세요 반갑습니다"],
      ["2", "네 제안서 보내드리겠습니다."],
      ["2", "다음"],
    ]);
    expect(segs[0]!.confidence).toBeCloseTo(0.85, 3);
    expect(offsetSegments(segs, 60_000)[1]!.startMs).toBe(61_400);
    expect(dominantLanguage(["ko-KR", "en-US", "ko-kr", null])).toBe("ko-kr");
    expect(transcriptText([{ speaker: "S1", text: "hi" }])).toBe("S1: hi");
  });

  it("extracts grounded commitments with segment evidence and links claims back to segments", () => {
    const segs = [
      { id: 11, speaker: "S1", text: "오늘 논의 감사합니다. 3개 병원 파일럿으로 진행하기로 했습니다." },
      { id: 12, speaker: "S2", text: "제가 제안서를 금요일까지 보내드리겠습니다. 가격은 어떻게 될까요?" },
      { id: 13, speaker: "S1", text: "I'll share the data sample by next week." },
      { id: 14, speaker: "S2", text: "날씨가 좋네요." },
    ];
    const c = extractCommitments(segs);
    expect(c.decisions.map((d) => d.text)).toEqual(["3개 병원 파일럿으로 진행하기로 했습니다."]);
    expect(c.decisions[0]!.segmentIds).toEqual([11]);
    expect(c.actionItems.map((a) => [a.text, a.dueHint, a.segmentIds[0]])).toEqual([
      ["제가 제안서를 금요일까지 보내드리겠습니다.", "금요일", 12],
      ["I'll share the data sample by next week.", "by next week", 13],
    ]);
    // every extracted text is verbatim from its segment (no fabrication)
    for (const a of [...c.decisions, ...c.actionItems]) expect(segs.find((s) => s.id === a.segmentIds[0])!.text).toContain(a.text);

    expect(linkEvidence("제안서 송부 (금요일)", segs)).toEqual([12]);
    expect(linkEvidence("Share data sample", segs)).toEqual([13]);
    expect(linkEvidence("완전히 무관한 문장 xyz", segs)).toEqual([]);
  });
});

describe("F-052/F-150/F-178/F-179 offline outbox", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const mk = (n: number, method: string, path: string, body: unknown, now = n) => createOutboxItem({ id: `q${n}`, method, path, body, idempotencyKey: `k${n}`, now })!;

  it("only queues whitelisted writes and assigns per-entity keys", () => {
    expect(classifyRequest("POST", "/contacts")?.kind).toBe("contact");
    expect(classifyRequest("PATCH", `/contacts/${id(1)}`)).toEqual({ kind: "contact_update", entityKey: `contact:${id(1)}` });
    expect(classifyRequest("POST", `/contacts/${id(1)}/notes`)?.entityKey).toBe(`contact:${id(1)}`);
    expect(classifyRequest("POST", `/events/${id(2)}/leads`)?.kind).toBe("event_lead");
    expect(classifyRequest("POST", "/capture/commit")?.kind).toBe("scan");
    expect(classifyRequest("POST", "/exchange/sessions")).toBeNull();
    expect(classifyRequest("DELETE", `/contacts/${id(1)}`)).toBeNull();
    expect(mk(1, "POST", "/contacts", {}).entityKey).toBe("new:q1");
  });

  it("coalesces unsent PATCHes and keeps the original base version", () => {
    let items: OutboxItem[] = [];
    items = enqueue(items, mk(1, "PATCH", `/contacts/${id(1)}`, { jobTitle: "이사", version: 3 }));
    items = enqueue(items, mk(2, "PATCH", `/contacts/${id(1)}`, { email: "a@b.c", version: 4 }));
    expect(items).toHaveLength(1);
    expect(items[0]!.body).toEqual({ jobTitle: "이사", email: "a@b.c", version: 3 });
    expect(items[0]!.idempotencyKey).toBe("k1");
  });

  it("replays in order per entity and blocks later writes behind an unresolved one", () => {
    const a = mk(1, "PATCH", `/contacts/${id(1)}`, { version: 1 });
    const b = { ...mk(2, "POST", `/contacts/${id(1)}/notes`, { body: "x" }) };
    const c = mk(3, "POST", "/contacts", { fullName: "A" });
    expect(readyItems([c, b, a], 10).map((i) => i.id)).toEqual(["q1", "q3"]);
    const parked = { ...a, status: "conflict" as const };
    expect(readyItems([parked, b, c], 10).map((i) => i.id)).toEqual(["q3"]);
    const later = { ...c, nextAttemptAt: 100 };
    expect(readyItems([later], 10)).toEqual([]);
  });

  it("decides done / retry with backoff / conflict / failed from the replay response", () => {
    const it0 = mk(1, "PATCH", `/contacts/${id(1)}`, { jobTitle: "x", version: 2 });
    expect(decide(it0, { status: 201 }, 0).action).toBe("done");
    const r = decide(it0, { networkError: true }, 1000, 0.5);
    expect(r.action).toBe("retry");
    if (r.action === "retry") expect(r.item.nextAttemptAt).toBe(1000 + backoffMs(1, 0.5));
    const r429 = decide(it0, { status: 429, body: { code: "rate_limited" }, retryAfterSec: 30 }, 0);
    expect(r429.action === "retry" && r429.item.nextAttemptAt).toBe(30_000);
    expect(decide(it0, { status: 503 }, 0).action).toBe("retry");
    const conflict = decide(it0, { status: 409, body: { code: "version_conflict", message: "m", details: { serverVersion: 5, current: { jobTitle: "y" } } } }, 0);
    expect(conflict.action).toBe("conflict");
    if (conflict.action === "conflict") {
      expect(conflict.item.conflict).toEqual({ serverVersion: 5, current: { jobTitle: "y" } });
      expect(conflictFields(conflict.item.body as Record<string, unknown>, conflict.item.conflict!.current as Record<string, unknown>)).toEqual([{ field: "jobTitle", mine: "x", server: "y" }]);
      const mine = resolveConflict(conflict.item, "mine", 50, "k-new")!;
      expect(mine).toMatchObject({ status: "pending", attempts: 0, idempotencyKey: "k-new", body: { jobTitle: "x", version: 5 } });
      expect(resolveConflict(conflict.item, "theirs", 50, "k-new")).toBeNull();
    }
    expect(decide(it0, { status: 400, body: { code: "validation_failed" } }, 0).action).toBe("failed");
    expect(decide({ ...it0, attempts: MAX_ATTEMPTS - 1 }, { status: 500 }, 0).action).toBe("failed");
    expect(backoffMs(30, 0.99)).toBeLessThanOrEqual(5 * 60_000 * 1.2);
    expect(summarize([it0, { ...it0, status: "conflict" }, { ...it0, status: "failed" }])).toEqual({ pending: 1, conflicts: 1, failed: 1 });
  });
});
