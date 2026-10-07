// F-021 / F-022 card design templates + F-036 CTA icons — integration tests against real PostgreSQL
// (DATABASE_URL=…/linkos_test_t). Save/load, validation (unknown template → 400), guest landing payload, Idempotency-Key.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_t";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { getBankIcon } = await import("@linkos/domain/iconBank");
const { card, handoff, identity, living, withIdempotency, closePool, q, one } = api;

const ctx = (userId: string | null) => ({ userId, ip: "10.0.0.7", userAgent: "Mozilla/5.0 (iPhone) Safari/605", requestId: "t" });
const consents = [
  { type: "terms" as const, granted: true },
  { type: "privacy" as const, granted: true },
  { type: "age_14" as const, granted: true },
];
const base = {
  name: "홍길동", company: "링코스랩", jobTitle: "대표", headline: null, bioShort: null, bioLong: null, keywords: ["의료AI"], industries: ["헬스케어"], regions: [],
  theme: "ink", matchingOptIn: true, deep: {}, offers: [], needs: [], variants: [],
  fields: [
    { type: "email", value: "ceo@linkos.test", visibility: "business" },
    { type: "mobile", value: "010-1234-5678", visibility: "trusted" },
  ],
};

async function signUp(email: string) {
  const { devCode } = await identity.requestOtp(ctx(null), email);
  return identity.verifyOtp(ctx(null), email, devCode!, consents);
}
const parse = (body: unknown) => card.profileInput.parse(body);

let userId = "";
let profileId = "";

beforeAll(async () => {
  await migrate();
  await q("TRUNCATE users, organizations, companies, exchange_sessions, outbox_events, audit_logs, rate_limits, idempotency_keys, otp_codes, events CASCADE");
  userId = (await signUp(`tpl${Date.now()}@linkos.test`)).user.id;
});
afterAll(async () => {
  await closePool();
});

describe("F-021 migration 0012", () => {
  it("adds template_id / template_options to profiles (additive, with defaults)", async () => {
    const cols = await q<{ column_name: string; column_default: string | null }>(
      "SELECT column_name, column_default FROM information_schema.columns WHERE table_name='profiles' AND column_name IN ('template_id','template_options') ORDER BY column_name",
    );
    expect(cols.map((c) => c.column_name)).toEqual(["template_id", "template_options"]);
    const cons = await q<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conrelid='profiles'::regclass AND conname LIKE 'profiles_template%' ORDER BY conname");
    expect(cons.map((c) => c.conname)).toEqual(["profiles_template_id_format", "profiles_template_options_object"]);
  });
});

describe("F-021 save/load card template", () => {
  it("creates a profile with a template and options, loads them back", async () => {
    const p = await card.saveProfile(ctx(userId), parse({ ...base, templateId: "clinic-clean", templateOptions: { accent: "#1D4ED8", monogram: "홍", icon: "i:stethoscope", fieldIcons: { email: "e:📧" }, keywordBadges: { 의료AI: "i:ai-sparkle" }, sectionIcons: { projects: "e:🚀" } } }));
    profileId = p.id;
    expect(p.templateId).toBe("clinic-clean");
    expect(p.templateOptions).toMatchObject({ accent: "#1D4ED8", monogram: "홍", icon: "i:stethoscope" });
    const row = await one<{ template_id: string; template_options: Record<string, unknown> }>("SELECT template_id, template_options FROM profiles WHERE id=$1", [p.id]);
    expect(row?.template_id).toBe("clinic-clean");
    expect(row?.template_options.fieldIcons).toEqual({ email: "e:📧" });
    // DB-level guard as defence in depth
    await expect(q("UPDATE profiles SET template_id='Bad Id' WHERE id=$1", [p.id])).rejects.toThrow(/profiles_template_id_format/);
  });

  it("projects a render-ready design (template + resolved glyphs) into the public card", async () => {
    const p = (await card.loadProfile(profileId))!;
    const pub = card.projectCard(p, "public");
    expect(pub.templateId).toBe("clinic-clean");
    expect(pub.design?.template?.id).toBe("clinic-clean");
    expect(pub.design?.accent).toBe("#1D4ED8");
    expect(pub.design?.icon).toMatchObject({ kind: "icon", d: getBankIcon("stethoscope")!.d });
    expect(pub.design?.fieldIcons.email).toMatchObject({ kind: "emoji", char: "📧" });
    expect(pub.design?.sectionIcons.projects).toMatchObject({ kind: "emoji", char: "🚀" });
    // ACL still applies: the trusted mobile number is not in the public projection
    expect(pub.fields.map((f) => f.type)).toEqual([]);
  });

  it("keeps the template when templateId is omitted, clears it with null, and emits profile.updated with 'template'", async () => {
    const v1 = (await card.loadProfile(profileId))!.version;
    const kept = await card.saveProfile(ctx(userId), parse({ ...base, headline: "판독 시간을 절반으로", version: v1 }), profileId);
    expect(kept.templateId).toBe("clinic-clean");
    expect(kept.templateOptions.accent).toBe("#1D4ED8");

    const switched = await card.saveProfile(ctx(userId), parse({ ...base, templateId: "noir-gold-foil", templateOptions: { accent: "#D8D2C4" }, version: kept.version }), profileId);
    expect(switched.templateId).toBe("noir-gold-foil");
    const ev = await one<{ payload: { changed_fields: string[] } }>(
      "SELECT payload FROM outbox_events WHERE event_type='profile.updated' AND aggregate_id=$1 ORDER BY created_at DESC LIMIT 1",
      [profileId],
    );
    expect(ev?.payload.changed_fields).toContain("template");

    const cleared = await card.saveProfile(ctx(userId), parse({ ...base, templateId: null, templateOptions: {}, version: switched.version }), profileId);
    expect(cleared.templateId).toBeNull();
    expect(card.projectCard(cleared, "public").design).toBeNull();
  });
});

describe("F-021 validation → 400", () => {
  it("rejects an unknown template id", async () => {
    await expect(card.saveProfile(ctx(userId), parse({ ...base, templateId: "no-such-template" }), profileId)).rejects.toMatchObject({ status: 400, code: "unknown_template" });
    await expect(card.saveProfile(ctx(userId), parse({ ...base, templateId: "no-such-template" }))).rejects.toMatchObject({ status: 400, code: "unknown_template" });
  });

  it("rejects malformed ids and unknown option keys at the schema", () => {
    expect(card.profileInput.safeParse({ ...base, templateId: "Bad Id!" }).success).toBe(false);
    expect(card.profileInput.safeParse({ ...base, templateId: "swiss-grid", templateOptions: { color: "#fff" } }).success).toBe(false);
    expect(card.profileInput.safeParse({ ...base, templateId: "swiss-grid", templateOptions: { icon: "javascript:alert(1)" } }).success).toBe(false);
  });

  it("rejects accents outside the template palette, unknown icons and multi-grapheme emoji", async () => {
    const cur = (await card.loadProfile(profileId))!;
    const bad = async (templateOptions: Record<string, unknown>, templateId = "swiss-grid") =>
      card.saveProfile(ctx(userId), parse({ ...base, templateId, templateOptions, version: cur.version }), profileId);
    await expect(bad({ accent: "#123456" })).rejects.toMatchObject({ status: 400, code: "invalid_card_design", details: { errors: ["accent_not_allowed"] } });
    await expect(bad({ icon: "i:does-not-exist" })).rejects.toMatchObject({ status: 400, details: { errors: ["icon_unknown"] } });
    await expect(bad({ icon: "e:🚀🚀" })).rejects.toMatchObject({ status: 400, details: { errors: ["icon_unknown"] } });
    await expect(bad({ fieldIcons: { email: "e:x" } })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ monogram: "ABCD" })).rejects.toMatchObject({ status: 400, details: { errors: ["monogram_invalid"] } });
    // nothing was written
    expect((await card.loadProfile(profileId))!.version).toBe(cur.version);
  });

  it("re-checks a kept accent against a newly chosen template", async () => {
    const cur = (await card.loadProfile(profileId))!;
    const withAccent = await card.saveProfile(ctx(userId), parse({ ...base, templateId: "swiss-grid", templateOptions: { accent: "#1D4ED8" }, version: cur.version }), profileId);
    // switch template but omit templateOptions → stored accent #1D4ED8 is not in noir-gold-foil's palette
    await expect(card.saveProfile(ctx(userId), parse({ ...base, templateId: "noir-gold-foil", version: withAccent.version }), profileId)).rejects.toMatchObject({ status: 400, details: { errors: ["accent_not_allowed"] } });
  });
});

describe("F-021 guest landing + public profile render the template", () => {
  it("carries the design in the exchange landing payload and on /p/{slug}", async () => {
    const cur = (await card.loadProfile(profileId))!;
    await card.saveProfile(ctx(userId), parse({ ...base, templateId: "dancheong-band", templateOptions: { icon: "i:hanok-roof" }, version: cur.version }), profileId);
    const s = await handoff.createExchangeSession(ctx(userId), { capabilities: {}, group: false, context: {} });
    const landing = await handoff.openGuestLanding(s.token, ctx(null), "anon-tpl");
    expect(landing.sender.templateId).toBe("dancheong-band");
    expect(landing.sender.design?.template?.layout).toBe("classic");
    expect(landing.sender.design?.icon?.kind).toBe("icon");
    // business-audience exchange card shows the business email but never the trusted mobile
    expect(landing.sender.fields.map((f) => f.type)).toEqual(["email"]);

    const pub = await card.getPublicProfileBySlug(cur.slug, null);
    expect(pub.design?.template?.id).toBe("dancheong-band");
  });
});

describe("Idempotency-Key on create/update with template fields", () => {
  it("replays the same response for the same key and rejects a different body", async () => {
    const body = { ...base, name: "멱등 테스트", templateId: "swiss-grid", templateOptions: { accent: "#C8321B" } };
    const run = () => withIdempotency(`profile-create:${userId}`, "idem-tpl-1", body, async () => ({ status: 201, body: await card.saveProfile(ctx(userId), parse(body)) }));
    const a = await run();
    const b = await run();
    expect(b.replayed).toBe(true);
    expect(b.body.id).toBe(a.body.id);
    expect((await q("SELECT 1 FROM profiles WHERE user_id=$1 AND name='멱등 테스트'", [userId])).length).toBe(1);
    await expect(
      withIdempotency(`profile-create:${userId}`, "idem-tpl-1", { ...body, templateId: "blueprint" }, async () => ({ status: 201, body: null })),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
  });
});

describe("F-036 Action CTA icons", () => {
  it("stores bank icons/emoji per CTA and exposes resolved glyphs publicly", async () => {
    const input = living.actionCtasInput.parse({ booking: { enabled: true, url: "https://cal.linkos.test/x", icon: "i:calendar" }, quote: { enabled: true, icon: "e:🧾" }, proposal: { enabled: false }, nda: { enabled: true } });
    await living.setActionCtas(ctx(userId), profileId, input);
    const pub = await living.getActionCtas(profileId);
    expect(pub.actions.map((a) => a.kind)).toEqual(["booking", "quote", "nda"]);
    expect(pub.actions[0]!.glyph).toMatchObject({ kind: "icon", d: getBankIcon("calendar")!.d });
    expect(pub.actions[1]!.glyph).toMatchObject({ kind: "emoji", char: "🧾" });
    expect(pub.actions[2]!.glyph).toBeNull();
  });
  it("rejects unknown CTA icons", () => {
    expect(living.actionCtasInput.safeParse({ quote: { enabled: true, icon: "i:nope" } }).success).toBe(false);
    expect(living.actionCtasInput.safeParse({ quote: { enabled: true, icon: "e:🧾🧾" } }).success).toBe(false);
  });
});
