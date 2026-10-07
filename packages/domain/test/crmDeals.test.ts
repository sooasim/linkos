// F-121 HubSpot Company/Deal pure logic + F-060 Apple display-name helpers.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HUBSPOT_PIPELINE,
  HUBSPOT_OBJECT_DEFAULTS,
  applyObjectMapping,
  buildDealProperties,
  canApproveDeal,
  companyDomain,
  formatAppleName,
  isApplePrivateRelay,
  hostDomain,
  validateObjectMapping,
  validatePipelineConfig,
} from "../src";

describe("F-121 company domain dedupe key", () => {
  it("normalizes urls, emails and www", () => {
    expect(hostDomain("https://www.Acme.co.kr/about?x=1")).toBe("acme.co.kr");
    expect(hostDomain("Kim@Sales.Acme.io")).toBe("sales.acme.io");
    expect(hostDomain("not a domain")).toBeNull();
    expect(hostDomain("")).toBeNull();
  });
  it("prefers company domain → website → work email, never free-mail or Apple relay", () => {
    expect(companyDomain({ domain: null, website: "acme.io", email: "a@other.io" })).toBe("acme.io");
    expect(companyDomain({ email: "kim@gmail.com" })).toBeNull();
    expect(companyDomain({ email: "x@privaterelay.appleid.com" })).toBeNull();
    expect(companyDomain({ website: "https://naver.com", email: "kim@acme.kr" })).toBe("acme.kr");
  });
});

describe("F-121/F-127 company & deal mapping", () => {
  it("defaults are valid; required/reserved/duplicate/unknown are rejected", () => {
    expect(validateObjectMapping("company", HUBSPOT_OBJECT_DEFAULTS.company)).toEqual({ ok: true, errors: [] });
    expect(validateObjectMapping("deal", HUBSPOT_OBJECT_DEFAULTS.deal)).toEqual({ ok: true, errors: [] });
    expect(validateObjectMapping("deal", [{ local: "amount", remote: "amount" }]).errors).toContain("missing_required:dealname");
    expect(validateObjectMapping("deal", [{ local: "dealName", remote: "dealname" }, { local: "description", remote: "dealstage" }]).errors).toContain("reserved_remote:dealstage");
    expect(validateObjectMapping("company", [{ local: "companyName", remote: "name" }, { local: "website", remote: "NAME" }]).errors).toContain("duplicate_remote:NAME");
    expect(validateObjectMapping("company", [{ local: "email", remote: "name" }]).errors).toContain("unknown_local:email");
  });
  it("omits empty values and reports a missing required value", () => {
    expect(applyObjectMapping("company", HUBSPOT_OBJECT_DEFAULTS.company, { companyName: "Acme", domain: "acme.io", website: "" })).toEqual({ values: { name: "Acme", domain: "acme.io" }, missingRequired: [] });
    expect(applyObjectMapping("company", HUBSPOT_OBJECT_DEFAULTS.company, { companyName: " " }).missingRequired).toEqual(["name"]);
  });
  it("deal properties carry pipeline + mapped stage; closedate as UTC midnight; invalid amount dropped", () => {
    const r = buildDealProperties(HUBSPOT_OBJECT_DEFAULTS.deal, DEFAULT_HUBSPOT_PIPELINE, { name: "Acme PoC", amount: "1200000", closeDate: "2026-12-01", stage: "proposal" });
    expect(r.properties).toEqual({ dealname: "Acme PoC", amount: "1200000", closedate: "2026-12-01T00:00:00.000Z", pipeline: "default", dealstage: "presentationscheduled" });
    expect(buildDealProperties(HUBSPOT_OBJECT_DEFAULTS.deal, DEFAULT_HUBSPOT_PIPELINE, { name: "x", amount: "abc", stage: "won" }).properties).not.toHaveProperty("amount");
  });
  it("pipeline config validation", () => {
    expect(validatePipelineConfig(DEFAULT_HUBSPOT_PIPELINE).ok).toBe(true);
    const bad = validatePipelineConfig({ pipeline: "p 1", stages: { ...DEFAULT_HUBSPOT_PIPELINE.stages, won: "", bogus: "x" } });
    expect(bad.errors).toEqual(expect.arrayContaining(["invalid_pipeline", "invalid_stage:won", "unknown_stage:bogus"]));
  });
  it("approval gate: only the exact draft version the user saw; never twice; never a discarded deal", () => {
    expect(canApproveDeal({ status: "draft", version: 2 }, 2)).toEqual({ ok: true });
    expect(canApproveDeal({ status: "draft", version: 3 }, 2)).toEqual({ ok: false, reason: "stale_version" });
    expect(canApproveDeal({ status: "approved", version: 2 }, 2)).toEqual({ ok: false, reason: "already_approved" });
    expect(canApproveDeal({ status: "discarded", version: 2 }, 2)).toEqual({ ok: false, reason: "discarded" });
    expect(canApproveDeal({ status: "synced", version: 2 }, 2)).toEqual({ ok: false, reason: "already_synced" }); // edits turn it back into a draft
  });
});

describe("F-060 Apple name/relay helpers", () => {
  it("formats first-login names (Korean family-name first), strips control chars", () => {
    expect(formatAppleName({ firstName: "민지", lastName: "박" })).toBe("박민지");
    expect(formatAppleName({ firstName: "Jane", lastName: "Appleseed" })).toBe("Jane Appleseed");
    expect(formatAppleName({ firstName: "<b>Jo\u0000", lastName: "" })).toBe("bJo");
    expect(formatAppleName({})).toBeNull();
    expect(formatAppleName(null)).toBeNull();
  });
  it("detects private relay addresses", () => {
    expect(isApplePrivateRelay("abc123@privaterelay.appleid.com")).toBe(true);
    expect(isApplePrivateRelay("kim@acme.io")).toBe(false);
  });
});
