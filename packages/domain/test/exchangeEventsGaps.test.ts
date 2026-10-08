// F-142 참가자 CSV 파서 · UX-015 마커 타임라인 · F-090 녹음 정책 기본값
import { describe, expect, it } from "vitest";
import { MAX_ATTENDEE_ROWS, interleaveMarkers, parseAttendeeCsv, parseDelimited, recordingPolicyDefault, registrantKeySource } from "../src/index";

describe("F-142 parseAttendeeCsv", () => {
  it("reads Korean headers, quoted cells and a BOM", () => {
    const r = parseAttendeeCsv('﻿이름,이메일,회사,직책\r\n홍길동,HONG@Example.com,"링코스, 주식회사",대표\r\n"김 ""영희""",,메디,\n');
    expect(r.header).toBe(true);
    expect(r.rows).toEqual([
      { fullName: "홍길동", email: "hong@example.com", company: "링코스, 주식회사", jobTitle: "대표" },
      { fullName: '김 "영희"', email: null, company: "메디", jobTitle: null },
    ]);
    expect(r.errors).toEqual([]);
  });

  it("accepts tab-separated paste with English headers in any order", () => {
    const r = parseAttendeeCsv("Company\tName\tE-mail\tTitle\nAcme\tJane Doe\tjane@acme.io\tCTO");
    expect(r.rows).toEqual([{ fullName: "Jane Doe", email: "jane@acme.io", company: "Acme", jobTitle: "CTO" }]);
  });

  it("falls back to name,email,company,title without a header", () => {
    const r = parseAttendeeCsv("이몽룡,lee@a.kr,남원상사,이사");
    expect(r.header).toBe(false);
    expect(r.rows[0]).toEqual({ fullName: "이몽룡", email: "lee@a.kr", company: "남원상사", jobTitle: "이사" });
  });

  it("reports missing names, invalid e-mails and duplicates with line numbers", () => {
    const r = parseAttendeeCsv("name,email\n,x@y.io\n홍길동,not-an-email\n성춘향,chun@a.kr\n성춘향2,CHUN@a.kr\n");
    expect(r.rows.map((x) => x.fullName)).toEqual(["성춘향"]);
    expect(r.errors).toEqual([
      { line: 2, reason: "missing_name" },
      { line: 3, reason: "invalid_email" },
      { line: 5, reason: "duplicate" },
    ]);
  });

  it("a header without a name column yields no rows (never treats header words as names)", () => {
    const r = parseAttendeeCsv("회사,이메일\n무명사,a@b.io");
    expect(r.rows).toEqual([]);
    expect(r.errors).toEqual([{ line: 2, reason: "missing_name" }]);
  });

  it("caps the number of rows", () => {
    const text = ["name", ...Array.from({ length: MAX_ATTENDEE_ROWS + 5 }, (_, i) => `p${i}`)].join("\n");
    const r = parseAttendeeCsv(text);
    expect(r.rows).toHaveLength(MAX_ATTENDEE_ROWS);
    expect(r.errors).toEqual([{ line: MAX_ATTENDEE_ROWS + 2, reason: "too_many_rows" }]);
  });

  it("strips the formula guard our own CSV export adds", () => {
    expect(parseAttendeeCsv("name,company\n'=Bob,'+Co").rows[0]).toMatchObject({ fullName: "=Bob", company: "+Co" });
  });

  it("registrant key prefers the normalized e-mail, else name + company", () => {
    expect(registrantKeySource({ fullName: "A", email: " Hong@Example.COM ", company: null })).toBe("email:hong@example.com");
    expect(registrantKeySource({ fullName: "홍 길 동", email: null, company: "(주)링코스" })).toBe(registrantKeySource({ fullName: "홍길동", email: null, company: "링코스" }));
  });

  it("parseDelimited keeps newlines inside quotes", () => {
    expect(parseDelimited('a,"b\nc"\nd,e')).toEqual([["a", "b\nc"], ["d", "e"]]);
  });
});

describe("UX-015 interleaveMarkers", () => {
  const seg = (id: string, recordingId: string, startMs: number) => ({ id, recordingId, startMs });
  it("orders by recording, then time; a marker precedes a segment at the same ms", () => {
    const out = interleaveMarkers(
      [seg("s1", "r1", 0), seg("s2", "r1", 5000), seg("s3", "r2", 0)],
      [
        { id: "m1", recordingId: "r1", offsetMs: 5000, label: "가격" },
        { id: "m2", recordingId: "r2", offsetMs: 100, label: null },
        { id: "m3", recordingId: null, offsetMs: 1, label: "기타" },
      ],
      ["r1", "r2"],
    );
    expect(out.map((x) => x.item.id)).toEqual(["s1", "m1", "s2", "s3", "m2", "m3"]);
    expect(out[1]!.kind).toBe("marker");
  });
  it("shows markers even before any segment is transcribed", () => {
    expect(interleaveMarkers([], [{ id: "m", recordingId: "r", offsetMs: 10, label: null }], ["r"]).map((x) => x.kind)).toEqual(["marker"]);
  });
});

describe("F-090 recordingPolicyDefault", () => {
  it("org policy locks all-party consent", () => {
    expect(recordingPolicyDefault({ orgRequiresAllParty: true, current: "one_party_notice" })).toEqual({ policy: "all_party", locked: true, source: "org" });
  });
  it("keeps the meeting's recorded policy, else defaults to all_party", () => {
    expect(recordingPolicyDefault({ current: "one_party_notice" })).toEqual({ policy: "one_party_notice", locked: false, source: "meeting" });
    expect(recordingPolicyDefault({ current: null })).toEqual({ policy: "all_party", locked: false, source: "default" });
  });
});
