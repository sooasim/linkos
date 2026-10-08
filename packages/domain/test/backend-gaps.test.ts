// Whitepaper gap closure, backend round 2 (pure logic): §3.1 exchange paths (F-037~F-064) · F-092 restrictedFieldRatio ·
// F-096 / F-089 brief facts.
import { describe, expect, it } from "vitest";
import {
  EXCHANGE_STATES,
  type ExchangeState,
  InvalidTransitionError,
  canTransition,
  creationPath,
  isCompleted,
  isTerminal,
  priorMeetingFacts,
  privacyPenalty,
  recentProfileChanges,
  replyPath,
  restrictedFieldRatio,
  reviewPath,
  syncOutcome,
  walkTransitions,
} from "../src/index";

describe("§3.1 exchange state machine paths (F-037~F-064)", () => {
  it("creation passes DISCOVERING: CREATED → DISCOVERING → CHANNEL_SELECTED (or stays DISCOVERING without a plan)", () => {
    expect(walkTransitions("CREATED", creationPath(true)).map((s) => s.to)).toEqual(["DISCOVERING", "CHANNEL_SELECTED"]);
    expect(walkTransitions("CREATED", creationPath(false)).map((s) => s.to)).toEqual(["DISCOVERING"]);
  });

  it("walkTransitions validates every hop up front and skips no-op hops", () => {
    expect(walkTransitions("RECEIVER_OPENED", ["RECEIVER_OPENED", "CONSENT_PENDING"])).toEqual([{ from: "RECEIVER_OPENED", to: "CONSENT_PENDING" }]);
    expect(() => walkTransitions("CHANNEL_SELECTED", ["EXCHANGED"])).toThrow(InvalidTransitionError);
    expect(() => walkTransitions("CLAIM_PENDING", ["SYNCED"])).toThrow(InvalidTransitionError);
  });

  it("a reply always passes RECEIVER_OPENED and CONSENT_PENDING from every open state", () => {
    const open = EXCHANGE_STATES.filter((s) => !isCompleted(s) && !isTerminal(s));
    for (const from of open) {
      for (const completes of [true, false]) {
        for (const claimIssued of [true, false]) {
          const path = replyPath(from, { completes, claimIssued });
          const to = walkTransitions(from, path).map((x) => x.to);
          expect([from, ...to], `${from}`).toContain("CONSENT_PENDING"); // visited (or already there)
          if (!["RECEIVER_OPENED", "CONSENT_PENDING"].includes(from)) expect(to[0]).toBe("RECEIVER_OPENED");
          const last = to.at(-1);
          expect(last).toBe(!completes ? "RECEIVER_OPENED" : claimIssued ? "CLAIM_PENDING" : "EXCHANGED");
        }
      }
    }
  });

  it("review (보낼 필드 미리보기) enters CONSENT_PENDING from open states only", () => {
    expect(reviewPath("CHANNEL_SELECTED")).toEqual(["RECEIVER_OPENED", "CONSENT_PENDING"]);
    expect(reviewPath("RECEIVER_OPENED")).toEqual(["CONSENT_PENDING"]);
    expect(reviewPath("CONSENT_PENDING")).toEqual([]);
    for (const s of ["EXCHANGED", "CLAIM_PENDING", "CLAIMED", "SYNCED", "EXPIRED", "REVOKED", "CANCELLED"] as ExchangeState[]) expect(reviewPath(s), s).toBeNull();
    for (const s of EXCHANGE_STATES) {
      const p = reviewPath(s);
      if (p) expect(() => walkTransitions(s, p)).not.toThrow();
    }
  });

  it("SYNCED only after EXCHANGED/CLAIMED; CLAIM_PENDING defers (cannot skip CLAIMED)", () => {
    expect(syncOutcome("EXCHANGED")).toBe("SYNCED");
    expect(syncOutcome("CLAIMED")).toBe("SYNCED");
    expect(syncOutcome("CLAIM_PENDING")).toBe("defer");
    for (const s of ["CREATED", "DISCOVERING", "CHANNEL_SELECTED", "OFFERED", "RECEIVER_OPENED", "CONSENT_PENDING", "SYNCED", "EXPIRED", "REVOKED"] as ExchangeState[]) expect(syncOutcome(s), s).toBeNull();
    for (const s of EXCHANGE_STATES) if (syncOutcome(s) === "SYNCED") expect(canTransition(s, "SYNCED")).toBe(true);
  });
});

describe("F-092 restrictedFieldRatio (field ACL → privacy_penalty)", () => {
  const fields = [{ visibility: "public" as const }, { visibility: "business" as const }, { visibility: "trusted" as const }, { visibility: "private" as const }];
  it("is the hidden share for the audience; private always hidden; owner sees all", () => {
    expect(restrictedFieldRatio(fields, "public")).toBe(0.75);
    expect(restrictedFieldRatio(fields, "business")).toBe(0.5);
    expect(restrictedFieldRatio(fields, "partner")).toBe(0.25);
    expect(restrictedFieldRatio(fields, "owner")).toBe(0);
    expect(restrictedFieldRatio([], "public")).toBe(0);
  });
  it("feeds privacyPenalty monotonically", () => {
    const cand = (r: number) => ({ id: "c", name: "c", offers: [], needs: [], privacy: { restrictedFieldRatio: r } });
    const pub = privacyPenalty(cand(restrictedFieldRatio(fields, "public")), 0);
    const biz = privacyPenalty(cand(restrictedFieldRatio(fields, "business")), 0);
    expect(pub).toBeGreaterThan(biz);
    expect(privacyPenalty(cand(restrictedFieldRatio(fields, "owner")), 0)).toBe(0);
  });
});

describe("F-096 / F-089 brief facts (never fabricated)", () => {
  it("copies stored meeting card content and labels the transcript summary with its provenance", () => {
    const f = priorMeetingFacts({
      id: "m1",
      title: "1차",
      startedAt: "2026-09-01T01:00:00.000Z",
      createdAt: "2026-08-30T00:00:00.000Z",
      summary: { decisions: ["A", "", "B"], promises: [{ text: "견적", by: "them" }, { text: " " }], discussion: ["일정"], ai: { summary: "요약", provenance: "rules", recordingId: "r1" } },
    });
    expect(f).toEqual({
      meetingId: "m1",
      title: "1차",
      at: "2026-09-01T01:00:00.000Z",
      decisions: ["A", "B"],
      promises: [{ text: "견적", by: "them" }],
      discussion: ["일정"],
      transcriptSummary: { text: "요약", provenance: "rules", recordingId: "r1" },
      transcriptExcerpt: [],
      source: "meeting_card",
    });
  });
  it("falls back to verbatim transcript lines only when nothing else was stored; empty stays empty", () => {
    const lines = [{ id: "1", text: "안녕하세요" }, { id: "2", text: " " }, { id: "3", text: "다음 주 견적" }];
    const f = priorMeetingFacts({ id: "m", title: "t", startedAt: null, createdAt: new Date("2026-01-01T00:00:00Z"), summary: null }, lines);
    expect(f.transcriptExcerpt).toEqual([{ segmentId: "1", text: "안녕하세요" }, { segmentId: "3", text: "다음 주 견적" }]);
    expect(f.at).toBe("2026-01-01T00:00:00.000Z");
    expect(priorMeetingFacts({ id: "m", title: "t", startedAt: null, createdAt: "2026-01-01T00:00:00Z", summary: {} }).transcriptExcerpt).toEqual([]);
    expect(priorMeetingFacts({ id: "m", title: "t", startedAt: null, createdAt: "2026-01-01T00:00:00Z", summary: { decisions: ["x"] } }, lines).transcriptExcerpt).toEqual([]);
  });
  it("recentProfileChanges: since-filtered, newest first, one per field and source, linked-profile changes labelled", () => {
    const since = new Date("2026-09-01T00:00:00Z");
    const out = recentProfileChanges(
      [
        { field: "jobTitle", old_value: "과장", new_value: "차장", source: "user", changed_at: "2026-09-02T00:00:00Z" },
        { field: "jobTitle", old_value: "차장", new_value: "부장", source: "sync", changed_at: "2026-09-05T00:00:00Z" },
        { field: "email", old_value: "a", new_value: "b", source: "user", changed_at: "2026-08-01T00:00:00Z" },
        { field: "phone", old_value: "1", new_value: "1", source: "user", changed_at: "2026-09-03T00:00:00Z" },
      ],
      [{ changes: [{ field: "company", from: "옛", to: "새" }], created_at: "2026-09-04T00:00:00Z" }],
      since,
    );
    expect(out).toEqual([
      { field: "jobTitle", from: "차장", to: "부장", at: "2026-09-05T00:00:00.000Z", source: "contact_history", origin: "sync" },
      { field: "company", from: "옛", to: "새", at: "2026-09-04T00:00:00.000Z", source: "linked_profile", origin: "living_update" },
    ]);
  });
});
