// F-112 card translations (real PostgreSQL): owner-reviewed en/ja lines are stored with their source text;
// public projections drop lines whose source changed and never translate names or contact fields.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test";
process.env.RATE_LIMIT_DISABLED = "1";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { card, identity, closePool } = api;

const ctx = (userId: string | null) => ({ userId, ip: "10.7.0.2", userAgent: "test", requestId: "t" });
const consents = ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true }));
const stamp = Date.now();
const base = {
  name: "김번역", company: "링코스랩", jobTitle: "대표", headline: "의료 AI 스타트업", bioShort: "병원 데이터를 연결합니다", bioLong: null,
  keywords: [], industries: [], regions: [], theme: "ink" as const, matchingOptIn: true, deep: {},
  fields: [{ type: "email" as const, label: null, value: `kim${stamp}@x.io`, visibility: "public" as const }],
  offers: ["PoC 협업"], needs: ["투자 유치"], variants: [],
};
const reviewedAt = new Date().toISOString();
const en = {
  fields: { jobTitle: { src: "대표", text: "CEO" }, headline: { src: "의료 AI 스타트업", text: "Medical AI startup" }, bioShort: { src: "병원 데이터를 연결합니다", text: "We connect hospital data" } },
  offers: [{ src: "PoC 협업", text: "PoC collaboration" }], needs: [{ src: "투자 유치", text: "Fundraising" }],
  provenance: "ai_inferred" as const, model: "test", reviewedAt,
};

let userId: string;
beforeAll(async () => {
  await migrate();
  const email = `tr${stamp}@card-translations.test`;
  const { devCode } = await identity.requestOtp(ctx(null), email);
  userId = (await identity.verifyOtp(ctx(null), email, devCode!, consents)).user.id;
});
afterAll(async () => closePool());

describe("F-112 card translations", () => {
  it("are stored with the card, kept when omitted, and projected for viewers", async () => {
    const created = await card.saveProfile(ctx(userId), card.profileInput.parse({ ...base, translations: { en } }));
    expect(created.translations.en?.fields.jobTitle).toEqual({ src: "대표", text: "CEO" });
    const pub = card.projectCard(created, "public");
    expect(pub.translations?.en).toMatchObject({ jobTitle: "CEO", headline: "Medical AI startup", bioShort: "We connect hospital data", offers: ["PoC collaboration"], needs: ["Fundraising"], provenance: "ai_inferred" });
    expect(pub.translations?.ja).toBeUndefined();
    expect(JSON.stringify(pub.translations)).not.toContain("김번역"); // names are never part of a translation

    // saving without `translations` keeps them
    const kept = await card.saveProfile(ctx(userId), card.profileInput.parse({ ...base, version: created.version }), created.id);
    expect(kept.translations.en?.fields.headline?.text).toBe("Medical AI startup");
  });

  it("drop stale lines once the owner edits the original text", async () => {
    const p = await card.saveProfile(ctx(userId), card.profileInput.parse({ ...base, translations: { en } }));
    const edited = await card.saveProfile(ctx(userId), card.profileInput.parse({ ...base, headline: "헬스케어 데이터 플랫폼", version: p.version }), p.id);
    const pub = card.projectCard(edited, "public");
    expect(pub.translations?.en?.headline).toBeUndefined(); // source changed → old translation hidden
    expect(pub.translations?.en?.jobTitle).toBe("CEO");
    expect(pub.translations?.en?.offers).toEqual(["PoC collaboration"]); // owner-entered offers are confirmed; source unchanged
  });

  it("reject untranslatable fields and clear with {}", async () => {
    expect(() => card.profileInput.parse({ ...base, translations: { en: { ...en, fields: { name: { src: "김번역", text: "Kim" } } } } })).toThrow();
    expect(() => card.profileInput.parse({ ...base, translations: { fr: en } })).toThrow();
    const p = await card.saveProfile(ctx(userId), card.profileInput.parse({ ...base, translations: { en } }));
    const cleared = await card.saveProfile(ctx(userId), card.profileInput.parse({ ...base, translations: {}, version: p.version }), p.id);
    expect(cleared.translations).toEqual({});
    // an unconfirmed (AI-suggested) offer is not public, so neither is its translation
    expect(card.publicTranslations({ en }, { jobTitle: "대표", headline: null, bioShort: null, offers: [], needs: [] }).en?.offers).toEqual([]);
    expect(card.projectCard(cleared, "public").translations).toEqual({});
  });
});
