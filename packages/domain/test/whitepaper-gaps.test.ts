// Whitepaper gap closure (pure logic): F-139 CRM sync policy · §20 audit hash chain · §20 RUM · F-188 §23 KPIs
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUDIT_GENESIS_HASH,
  type AuditChainRow,
  GUEST_LANDING_ROUTE,
  auditChainHash,
  crmSyncDecision,
  finishAuditVerify,
  initialAuditVerifyState,
  kpiRate,
  matchToMeeting,
  mergePolicies,
  normalizeVitalsRoute,
  parseVitalSample,
  quantile,
  retentionStep,
  shouldSampleVitals,
  stableStringify,
  verifyAuditSegment,
} from "../src/index";

describe("F-139 CRM sync required policy", () => {
  const company = { scope: "org", ownership: "company" };
  it("only company-owned org contacts are required to sync", () => {
    expect(crmSyncDecision({}, company, ["hubspot"])).toEqual({ required: false, provider: null, violation: null });
    expect(crmSyncDecision({ requireCrmSync: true }, { scope: "personal", ownership: "personal" }, [])).toMatchObject({ required: false });
    expect(crmSyncDecision({ requireCrmSync: true }, { scope: "org", ownership: "personal" }, [])).toMatchObject({ required: false });
  });
  it("picks the first connected allowed provider, or reports crm_not_connected", () => {
    expect(crmSyncDecision({ requireCrmSync: true }, company, ["salesforce", "hubspot"])).toEqual({ required: true, provider: "salesforce", violation: null });
    expect(crmSyncDecision({ requireCrmSync: true, crmSyncProviders: ["hubspot"] }, company, ["salesforce", "hubspot"])).toMatchObject({ provider: "hubspot" });
    expect(crmSyncDecision({ requireCrmSync: true, crmSyncProviders: ["hubspot"] }, company, ["salesforce"])).toEqual({ required: true, provider: null, violation: "crm_not_connected" });
    expect(crmSyncDecision({ requireCrmSync: true }, company, [])).toMatchObject({ violation: "crm_not_connected" });
  });
  it("mergePolicies keeps the strictest CRM requirement (provider intersection)", () => {
    expect(mergePolicies([{}, { requireCrmSync: true }])).toMatchObject({ requireCrmSync: true });
    expect(mergePolicies([{ requireCrmSync: true, crmSyncProviders: ["hubspot", "salesforce"] }, { requireCrmSync: true, crmSyncProviders: ["salesforce"] }]).crmSyncProviders).toEqual(["salesforce"]);
    expect(mergePolicies([{ requireCrmSync: false, crmSyncProviders: ["hubspot"] }]).requireCrmSync).toBeUndefined();
  });
});

describe("§20 audit hash chain", () => {
  const base = (seq: number, extra: Partial<AuditChainRow> = {}): Omit<AuditChainRow, "prevHash" | "hash"> => ({
    chainSeq: seq,
    id: String(100 + seq),
    organizationId: null,
    actorUserId: "8f9b3c1e-0000-4000-8000-000000000001",
    action: `test.action_${seq}`,
    entityType: "user",
    entityId: null,
    metadata: { b: 1, a: [1, { y: 2, x: "z" }] },
    createdAt: "2026-10-08T01:02:03.456Z",
    ...extra,
  });
  function chain(n: number): AuditChainRow[] {
    const out: AuditChainRow[] = [];
    let prev = AUDIT_GENESIS_HASH;
    for (let i = 1; i <= n; i++) {
      const r = base(i);
      const hash = auditChainHash(prev, r);
      out.push({ ...r, prevHash: prev, hash });
      prev = hash;
    }
    return out;
  }

  it("stableStringify is key-order independent", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, null] } })).toBe(stableStringify({ a: { c: [3, null], d: 2 }, b: 1 }));
  });

  it("hash is SHA-256(prev ‖ \\n ‖ canonical) — identical to node:crypto", () => {
    const r = base(1);
    const canonical = stableStringify([1, "101", null, r.actorUserId, r.action, "user", null, r.metadata, r.createdAt]);
    expect(auditChainHash(AUDIT_GENESIS_HASH, r)).toBe(createHash("sha256").update(`${AUDIT_GENESIS_HASH}\n${canonical}`).digest("hex"));
  });

  it("an intact chain verifies (also when streamed in segments)", () => {
    const rows = chain(10);
    const tomb = new Map<number, string>();
    let st = initialAuditVerifyState();
    for (const seg of [rows.slice(0, 3), rows.slice(3, 7), rows.slice(7)]) {
      const r = verifyAuditSegment(st, seg, tomb);
      expect(r.ok).toBe(true);
      st = r.state;
    }
    expect(finishAuditVerify(st, 10, tomb)).toMatchObject({ ok: true, state: { checked: 10 } });
  });

  it("detects an edited field, a forged rehash, a deleted row and a reorder", () => {
    const rows = chain(6);
    const tomb = new Map<number, string>();
    const edited = rows.map((r) => (r.chainSeq === 3 ? { ...r, action: "tampered" } : r));
    expect(verifyAuditSegment(initialAuditVerifyState(), edited, tomb).break).toMatchObject({ chainSeq: 3, reason: "hash_mismatch" });
    // attacker recomputes row 3's own hash but cannot fix row 4's prev link without rewriting the rest
    const forged = edited.map((r) => (r.chainSeq === 3 ? { ...r, hash: auditChainHash(r.prevHash!, r) } : r));
    expect(verifyAuditSegment(initialAuditVerifyState(), forged, tomb).break).toMatchObject({ chainSeq: 4, reason: "prev_hash_mismatch" });
    const deleted = rows.filter((r) => r.chainSeq !== 2);
    expect(verifyAuditSegment(initialAuditVerifyState(), deleted, tomb).break).toMatchObject({ chainSeq: 2, reason: "missing_row" });
    const swapped = [rows[0]!, rows[2]!, rows[1]!, ...rows.slice(3)];
    expect(verifyAuditSegment(initialAuditVerifyState(), swapped, tomb).ok).toBe(false);
    // tail truncation is caught by finish when a tombstone/anchor names a later seq
    expect(finishAuditVerify(verifyAuditSegment(initialAuditVerifyState(), rows.slice(0, 4), tomb).state, 6, tomb).break).toMatchObject({ chainSeq: 5, reason: "missing_row" });
  });

  it("authorized purges leave tombstones that keep the chain verifiable", () => {
    const rows = chain(6);
    const tomb = new Map([2, 3].map((s) => [s, rows[s - 1]!.hash!] as [number, string]));
    const r = verifyAuditSegment(initialAuditVerifyState(), rows.filter((x) => x.chainSeq !== 2 && x.chainSeq !== 3), tomb);
    expect(r).toMatchObject({ ok: true, state: { checked: 4, tombstones: 2 } });
    // a fake tombstone hash does not satisfy the next row's prev link
    const bad = new Map([[2, rows[1]!.hash!], [3, "f".repeat(64)]]);
    expect(verifyAuditSegment(initialAuditVerifyState(), rows.filter((x) => x.chainSeq !== 2 && x.chainSeq !== 3), bad).break).toMatchObject({ chainSeq: 4, reason: "prev_hash_mismatch" });
  });
});

describe("§20 RUM web vitals", () => {
  it.each([
    ["/x/AbCdEfGhIjKlMnOpQrStUvWx", GUEST_LANDING_ROUTE],
    ["/x/AbCdEfGhIjKlMnOpQrStUvWx?utm=1#top", GUEST_LANDING_ROUTE],
    ["/c/1234", "/c/[code]"],
    ["/r/ABCD1234", "/r/[code]"],
    ["/p/kim-ceo", "/p/[slug]"],
    ["/app/people/2b1f0b5e-8a4c-4a5b-9e0d-1c2d3e4f5a6b", "/app/people/[id]"],
    ["/app/meetings/12", "/app/meetings/[n]"],
    ["/app/x/kim@example.com", "/app/x/[x]"],
    ["/", "/"],
    ["/app/scan", "/app/scan"],
  ])("normalizes %s → %s (no ids/tokens/PII)", (path, route) => {
    expect(normalizeVitalsRoute(path)).toBe(route);
  });

  it("validates samples and drops malformed/out-of-range ones", () => {
    expect(parseVitalSample({ name: "LCP", value: 1834.2, rating: "good", navigationType: "navigate", path: "/x/AbCdEfGhIjKlMnOpQrStUvWx" })).toEqual({ route: GUEST_LANDING_ROUTE, metric: "LCP", value: 1834.2, rating: "good", navType: "navigate" });
    expect(parseVitalSample({ name: "CLS", value: 0.02, rating: "good", path: "/" })).toMatchObject({ metric: "CLS", navType: null });
    expect(parseVitalSample({ name: "FID", value: 3, rating: "good", path: "/" })).toBeNull();
    expect(parseVitalSample({ name: "LCP", value: -1, rating: "good", path: "/" })).toBeNull();
    expect(parseVitalSample({ name: "LCP", value: 1e9, rating: "good", path: "/" })).toBeNull();
    expect(parseVitalSample({ name: "LCP", value: 100, rating: "great", path: "/" })).toBeNull();
    expect(parseVitalSample({ name: "LCP", value: 100, rating: "good" })).toBeNull();
    expect(parseVitalSample("LCP")).toBeNull();
  });

  it("sampling honours the rate", () => {
    expect(shouldSampleVitals(0, () => 0)).toBe(false);
    expect(shouldSampleVitals(0.25, () => 0.1)).toBe(true);
    expect(shouldSampleVitals(0.25, () => 0.3)).toBe(false);
  });
});

describe("F-188 §23 KPI helpers", () => {
  it("kpiRate / retentionStep / matchToMeeting / quantile", () => {
    expect(kpiRate(1, 3)).toBe(33.3);
    expect(kpiRate(1, 0)).toBeNull();
    expect(retentionStep({ previousActive: 4, retained: 3, currentActive: 10 })).toEqual({ previousActive: 4, retained: 3, currentActive: 10, retentionRate: 75, churned: 1 });
    expect(matchToMeeting(8, 2)).toEqual({ matches: 8, matchesWithMeeting: 2, matchToMeetingRate: 25 });
    expect(quantile([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25);
    expect(quantile([], 0.75)).toBeNull();
  });
});
