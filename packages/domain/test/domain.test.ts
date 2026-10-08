import { describe, expect, it } from "vitest";
import { generateExchangeCode,
  acceptsReply,
  assertGrounded,
  canSee,
  canStartRecording,
  canTransition,
  contactsRevealed,
  diffContacts,
  filterFieldsByAudience,
  findDuplicates,
  generateShortCode,
  generateToken,
  hashToken,
  isWellFormedToken,
  mergeContacts,
  missingRequiredConsents,
  needsReview,
  nextChannel,
  normalizePhone,
  normalizeShortCode,
  normalizeUrl,
  parseBusinessCard,
  planChannels,
  DEFAULT_CAPABILITIES,
  rankMatches,
  redact,
  toCsv,
  toVCard,
  type ContactLike,
} from "../src";

describe("F-050 token security", () => {
  it("generates >=128-bit url-safe tokens without PII and hashes them", async () => {
    const t = generateToken();
    expect(t.length).toBeGreaterThanOrEqual(22);
    expect(isWellFormedToken(t)).toBe(true);
    expect(new Set(Array.from({ length: 500 }, () => generateToken())).size).toBe(500);
    const h = await hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
  });
  it("rejects weak tokens", () => {
    expect(() => generateToken(8)).toThrow();
    expect(isWellFormedToken("short")).toBe(false);
  });
  it("F-045 exchange codes are 4 random digits; input is normalized", () => {
    const seen = new Set<string>();
    const firstDigit = new Array(10).fill(0);
    for (let i = 0; i < 5000; i++) {
      const c = generateExchangeCode();
      expect(c).toMatch(/^\d{4}$/);
      expect(normalizeShortCode(c)).toBe(c);
      seen.add(c);
      firstDigit[Number(c[0])]++;
    }
    expect(seen.size).toBeGreaterThan(3500); // ~3,935 distinct expected out of 10,000 for 5,000 uniform draws
    for (const n of firstDigit) expect(n).toBeGreaterThan(350); // uniform: ~500 each; leading zeros allowed
    expect(normalizeShortCode("12 34")).toBe("1234");
    expect(normalizeShortCode("12-34")).toBe("1234");
    expect(normalizeShortCode("１２３４")).toBe("1234");
    expect(normalizeShortCode("lk.to/0427")).toBe("0427");
    expect(normalizeShortCode("https://linkos.app/c/0427")).toBe("0427");
    for (const bad of ["123", "12345", "12a4", "ABC234", "", "    "]) expect(normalizeShortCode(bad)).toBeNull();
  });
  it("event join codes stay 6 chars from an unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) expect(generateShortCode()).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
  });
});

describe("exchange state machine (백서 3.1)", () => {
  it("follows the happy path", () => {
    const path = ["CREATED", "CHANNEL_SELECTED", "OFFERED", "RECEIVER_OPENED", "CONSENT_PENDING", "EXCHANGED", "CLAIM_PENDING", "CLAIMED", "SYNCED"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });
  it("supports CHANNEL_FAILED -> NEXT_CHANNEL and blocks illegal moves", () => {
    expect(canTransition("OFFERED", "CHANNEL_FAILED")).toBe(true);
    expect(canTransition("CHANNEL_FAILED", "CHANNEL_SELECTED")).toBe(true);
    expect(canTransition("CREATED", "CLAIMED")).toBe(false);
    expect(canTransition("EXCHANGED", "REVOKED")).toBe(false);
    expect(canTransition("OFFERED", "REVOKED")).toBe(true);
  });
  it("rejects replies after expiry or completion", () => {
    const future = new Date(Date.now() + 60_000);
    expect(acceptsReply("RECEIVER_OPENED", future)).toBe(true);
    expect(acceptsReply("RECEIVER_OPENED", new Date(Date.now() - 1))).toBe(false);
    expect(acceptsReply("EXCHANGED", future)).toBe(false);
    expect(acceptsReply("REVOKED", future)).toBe(false);
  });
});

describe("F-048 handoff ladder — QR is always the final fallback", () => {
  it("web sender to unknown receiver: os_share → short_code → qr", () => {
    const ladder = planChannels({ ...DEFAULT_CAPABILITIES, webShare: true, camera: true });
    expect(ladder).toEqual(["os_share", "short_code", "qr"]);
  });
  it("installed apps nearby: BLE first", () => {
    const ladder = planChannels({ ...DEFAULT_CAPABILITIES, installedApp: true, nativeBle: true, receiverHasApp: true, nfcAccessoryEnabled: true });
    expect(ladder[0]).toBe("ble_proximity");
    expect(ladder).toContain("nfc_accessory");
    expect(ladder.at(-1)).toBe("qr");
  });
  it("never puts QR first when any other channel exists, and qr never fails over", () => {
    const ladder = planChannels(DEFAULT_CAPABILITIES);
    expect(ladder[0]).not.toBe("qr");
    expect(ladder.at(-1)).toBe("qr");
    expect(nextChannel(ladder, "short_code", "timeout")).toBe("qr");
    expect(nextChannel(ladder, "qr", "failed")).toBe("qr");
    expect(nextChannel(ladder, "os_share", "success")).toBeNull();
  });
  it("offline with apps uses a local signed receipt", () => {
    expect(planChannels({ ...DEFAULT_CAPABILITIES, online: false, installedApp: true, nativeBle: true })).toEqual(["local_receipt", "qr"]);
  });
  it("never offers browser-to-browser BLE when no native app", () => {
    const ladder = planChannels({ ...DEFAULT_CAPABILITIES, webShare: true, receiverMode: "web_exchange_screen" });
    expect(ladder).not.toContain("ble_proximity");
    expect(ladder[0]).toBe("web_rendezvous");
  });
});

describe("F-016/F-017 OCR parser never fabricates", () => {
  const korean = [
    { text: "(주)링코스랩", confidence: 0.93 },
    { text: "홍길동 대표이사", confidence: 0.95, bbox: { x0: 0, y0: 0, x1: 100, y1: 40 } },
    { text: "M. 010-1234-5678", confidence: 0.91 },
    { text: "T. 02-555-1234  F. 02-555-1235", confidence: 0.9 },
    { text: "gildong.hong@linkos.ai", confidence: 0.97 },
    { text: "서울특별시 강남구 테헤란로 123, 10층", confidence: 0.88 },
    { text: "www.linkos.ai", confidence: 0.92 },
  ];
  it("extracts typed Korean fields with provenance and confidence", () => {
    const r = parseBusinessCard(korean);
    const get = (k: string) => r.fields.find((f) => f.key === k);
    expect(get("company")?.value).toBe("(주)링코스랩");
    expect(get("fullName")?.value).toBe("홍길동");
    expect(get("jobTitle")?.value).toBe("대표이사");
    expect(get("mobile")?.normalized).toBe("+821012345678");
    expect(get("phone")?.value).toBe("02-555-1234");
    expect(get("fax")?.value).toBe("02-555-1235");
    expect(get("email")?.normalized).toBe("gildong.hong@linkos.ai");
    expect(get("address")?.value).toContain("테헤란로");
    expect(get("website")?.normalized).toBe("https://linkos.ai");
    expect(r.language).toBe("ko");
    for (const f of r.fields) {
      expect(f.provenance).toBe("ocr");
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
    expect(() => assertGrounded(r.fields, korean)).not.toThrow();
  });
  it("extracts English card", () => {
    const lines = [
      { text: "Jane Doe" , bbox: { x0: 0, y0: 0, x1: 200, y1: 50 } },
      { text: "Head of Partnerships" },
      { text: "Acme Robotics Inc." },
      { text: "jane@acme.io" },
      { text: "+1 (415) 555-0199" },
    ];
    const r = parseBusinessCard(lines);
    const get = (k: string) => r.fields.find((f) => f.key === k)?.value;
    expect(get("fullName")).toBe("Jane Doe");
    expect(get("jobTitle")).toBe("Head of Partnerships");
    expect(get("company")).toBe("Acme Robotics Inc.");
    expect(get("email")).toBe("jane@acme.io");
    expect(r.fields.some((f) => f.key === "phone" || f.key === "mobile")).toBe(true);
  });
  it("returns nothing for empty / garbage input instead of guessing", () => {
    const r = parseBusinessCard([{ text: "" }, { text: "~~ ## ::" }]);
    expect(r.fields).toHaveLength(0);
  });
  it("F-018 flags low confidence fields for review", () => {
    const r = parseBusinessCard([{ text: "김철수", confidence: 0.4 }]);
    expect(r.fields[0] && needsReview(r.fields[0])).toBe(true);
  });
});

describe("normalization", () => {
  it("phones and urls", () => {
    expect(normalizePhone("010-1234-5678")).toBe("+821012345678");
    expect(normalizePhone("+82 10 1234 5678")).toBe("+821012345678");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizeUrl("WWW.Example.com/")).toBe("https://example.com");
  });
});

describe("F-020/F-021 duplicates and merge", () => {
  const existing = [
    { id: "a", fullName: "홍길동", company: "링코스랩", email: "hong@linkos.ai" },
    { id: "b", fullName: "Jane Doe", company: "Acme", phone: "+1 415 555 0199" },
    { id: "c", fullName: "김영희", company: "다른회사" },
  ];
  it("email exact match is auto-mergeable; fuzzy is candidate only", () => {
    const d1 = findDuplicates({ fullName: "홍 길 동", email: "HONG@linkos.ai" }, existing);
    expect(d1[0]?.contact.id).toBe("a");
    expect(d1[0]?.autoMergeable).toBe(true);
    const d2 = findDuplicates({ fullName: "홍길동", company: "(주)링코스랩" }, existing);
    expect(d2[0]?.contact.id).toBe("a");
    expect(d2[0]?.autoMergeable).toBe(false);
    expect(findDuplicates({ fullName: "박민수", company: "XYZ" }, existing)).toHaveLength(0);
  });
  it("field-level merge with choices", () => {
    const p: ContactLike = { fullName: "홍길동", company: "링코스랩", jobTitle: "팀장", email: "a@x.io" };
    const s = { fullName: "홍길동", company: "링코스", jobTitle: "대표", phone: "010-1111-2222" };
    expect(diffContacts(p, s).filter((d) => d.differs).map((d) => d.field)).toEqual(["company", "jobTitle", "email", "phone"]);
    const m = mergeContacts(p, s, { jobTitle: "secondary" });
    expect(m.jobTitle).toBe("대표");
    expect(m.company).toBe("링코스랩");
    expect(m.phone).toBe("010-1111-2222");
  });
});

describe("F-034 field ACL", () => {
  const fields = [
    { k: "a", visibility: "public" as const },
    { k: "b", visibility: "business" as const },
    { k: "c", visibility: "trusted" as const },
    { k: "d", visibility: "partner" as const },
    { k: "e", visibility: "private" as const },
  ];
  it("filters by audience; private never leaks", () => {
    expect(filterFieldsByAudience(fields, "public").map((f) => f.k)).toEqual(["a"]);
    expect(filterFieldsByAudience(fields, "business").map((f) => f.k)).toEqual(["a", "b"]);
    expect(filterFieldsByAudience(fields, "partner").map((f) => f.k)).toEqual(["a", "b", "c", "d"]);
    expect(canSee("private", "partner")).toBe(false);
    expect(canSee("private", "owner")).toBe(true);
  });
});

describe("Need↔Offer match (백서 7)", () => {
  it("ranks explainable matches labeled ai_inferred", () => {
    const me = { id: "me", name: "me", offers: ["의료 영상 AI 솔루션"], needs: ["병원 유통 파트너", "시리즈A 투자"], industries: ["헬스케어"] };
    const pool = [
      { id: "1", name: "VC", offers: ["시리즈A 투자 및 후속 투자"], needs: ["헬스케어 스타트업 딜소싱"], industries: ["헬스케어"] },
      { id: "2", name: "Baker", offers: ["빵 납품"], needs: ["매장 인테리어"] },
      { id: "3", name: "Opt", offers: ["시리즈A 투자"], needs: [], matchingOptOut: true },
    ];
    const r = rankMatches(me, pool);
    expect(r[0]?.candidateId).toBe("1");
    expect(r[0]?.provenance).toBe("ai_inferred");
    expect(r[0]?.reasons.length).toBeGreaterThan(0);
    expect(r.find((m) => m.candidateId === "3")).toBeUndefined();
    expect(r.find((m) => m.candidateId === "2")).toBeUndefined();
  });
});

describe("consent + recording gate", () => {
  it("signup requires terms/privacy/age; marketing optional", () => {
    expect(missingRequiredConsents([{ type: "terms", granted: true }])).toEqual(["privacy", "age_14"]);
  });
  it("F-084 recording cannot start without consent", () => {
    expect(canStartRecording({ ownerConsented: false, participantsAcknowledged: true, policy: "all_party" }).ok).toBe(false);
    expect(canStartRecording({ ownerConsented: true, participantsAcknowledged: false, policy: "all_party" }).ok).toBe(false);
    expect(canStartRecording({ ownerConsented: true, participantsAcknowledged: true, policy: "all_party" }).ok).toBe(true);
  });
});

describe("PII redaction", () => {
  it("masks emails, phones, tokens and sensitive keys", () => {
    const out = JSON.stringify(redact({ msg: "call 010-1234-5678 or hong@linkos.ai token AbCdEfGhIjKlMnOpQrStUvWx", email: "x@y.io", n: 3 }));
    expect(out).not.toContain("1234-5678");
    expect(out).not.toContain("hong@linkos.ai");
    expect(out).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
    expect(out).toContain("[redacted]");
  });
});

describe("intro consent", () => {
  it("never reveals contacts before both parties accept", () => {
    expect(contactsRevealed("PARTY_A_ACCEPTED")).toBe(false);
    expect(contactsRevealed("ROOM_CREATED")).toBe(true);
  });
});

describe("export formats", () => {
  it("vCard and CSV (with formula-injection guard)", () => {
    const v = toVCard({ fullName: "홍길동", company: "링코스, 랩", email: "a@b.io" });
    expect(v).toContain("FN:홍길동");
    expect(v).toContain("ORG:링코스\\, 랩");
    const csv = toCsv([{ name: "=HYPERLINK(1)", c: 'a"b' }], ["name", "c"]);
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain('"a""b"');
  });
});
