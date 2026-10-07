// 100-environment critical journey (playwright.matrix.config.ts → docs/QA_MATRIX.md).
// Per environment: landing → login → guest landing /x/{token} (FCP budget) → manual reply → localized "done" → claim CTA
// → signed-in app home. Global assertions: no page errors, no console errors, no failed same-origin requests,
// no horizontal overflow, images and fonts loaded.
import { type APIRequestContext, type BrowserContext, type Page, type TestInfo, expect, request as pwRequest, test } from "@playwright/test";
import { GUEST_MESSAGES, SCANNER_MESSAGES, pickLocale } from "../../packages/domain/src/i18n";
import { type NetworkProfile, SLOW_3G } from "./environments";

const PORT = Number(process.env.E2E_PORT ?? 3401);
const BASE = `http://localhost:${PORT}`;
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const CONSENTS = ["terms", "privacy", "age_14"].map((type) => ({ type, granted: true }));

async function signup(): Promise<{ api: APIRequestContext; id: string; name: string }> {
  const api = await pwRequest.newContext({ baseURL: BASE });
  const email = `m${uniq()}@matrix.test`;
  const otp = await (await api.post("/api/v1/auth/otp", { data: { email } })).json();
  const r = await api.post("/api/v1/auth/verify", { data: { email, code: otp.devCode, consents: CONSENTS } });
  expect(r.ok(), await r.text()).toBe(true);
  const me = await (await api.get("/api/v1/me")).json();
  const name = `매트릭스${uniq().slice(-4)}`;
  const p = await api.post("/api/v1/profiles", {
    data: { name, company: "링코스랩", jobTitle: "대표", fields: [{ type: "email", value: `${uniq()}@matrix.test`, visibility: "business" }, { type: "other", label: "secret", value: "MATRIX-PRIVATE", visibility: "private" }], offers: ["의료 AI"], needs: ["유통"] },
  });
  expect(p.status(), await p.text()).toBe(201);
  return { api, id: me.user.id, name };
}

interface Monitor {
  problems: string[];
  allowNetworkErrors: boolean;
}

/** Collect page errors, console errors, failed same-origin requests and HTTP ≥ 400 on same-origin URLs. */
function monitor(page: Page): Monitor {
  const m: Monitor = { problems: [], allowNetworkErrors: false };
  const sameOrigin = (u: string) => u.startsWith(BASE);
  page.on("pageerror", (e) => m.problems.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const t = msg.text();
    // Chromium logs every offline fetch as a console error while the network is deliberately cut
    if (m.allowNetworkErrors && /ERR_INTERNET_DISCONNECTED|Failed to (load resource|fetch)/.test(t)) return;
    m.problems.push(`console.error: ${t.slice(0, 300)}`);
  });
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "";
    if (!sameOrigin(r.url())) return;
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(f)) return; // navigation/prefetch cancelled by the next navigation
    if (m.allowNetworkErrors && /ERR_INTERNET_DISCONNECTED/.test(f)) return;
    m.problems.push(`requestfailed: ${r.method()} ${r.url().slice(BASE.length)} ${f}`);
  });
  page.on("response", (r) => {
    if (sameOrigin(r.url()) && r.status() >= 400) m.problems.push(`http ${r.status()}: ${r.request().method()} ${r.url().slice(BASE.length)}`);
  });
  return m;
}

async function throttle(page: Page, network: NetworkProfile) {
  if (network !== "slow3g") return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", SLOW_3G);
}

async function assertLayout(page: Page, where: string) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bodyW: document.body.scrollWidth }));
  expect(r.sw, `${where}: horizontal overflow (scrollWidth ${r.sw} > innerWidth ${r.iw})`).toBeLessThanOrEqual(r.iw + 1);
}

async function assertAssets(page: Page, where: string) {
  const r = await page.evaluate(async () => {
    await document.fonts.ready;
    const broken = Array.from(document.images)
      .filter((img) => img.loading !== "lazy" && img.complete && img.naturalWidth === 0 && !img.src.startsWith("blob:"))
      .map((img) => img.currentSrc || img.src);
    return { broken, fontStatus: document.fonts.status, // next/font's "<family> Fallback" faces are local() metric shims (e.g. local("Arial")); they legitimately
      // fail on machines without that system font and are not downloads
      faces: Array.from(document.fonts).filter((f) => f.status === "error" && !/ Fallback$/.test(f.family)).map((f) => f.family) };
  });
  expect(r.broken, `${where}: broken images`).toEqual([]);
  expect(r.fontStatus, `${where}: fonts`).toBe("loaded");
  expect(r.faces, `${where}: font faces failed`).toEqual([]);
}

function network(info: TestInfo): NetworkProfile {
  return (info.project.metadata as { network: NetworkProfile }).network;
}

function settle(m: Monitor, where: string) {
  expect(m.problems, `${where}: ${m.problems.join("\n")}`).toEqual([]);
}

test("landing and login render cleanly", async ({ page }, info) => {
  const m = monitor(page);
  await throttle(page, network(info));
  await page.goto("/", { waitUntil: "load" });
  await expect(page.locator('a[href="/login"]').filter({ hasText: "무료로 시작하기" }).first()).toBeVisible();
  await expect(page.locator("h1").first()).toBeVisible();
  await assertLayout(page, "landing");
  await assertAssets(page, "landing");

  await page.goto("/login", { waitUntil: "load" });
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#email")).toBeEditable();
  await assertLayout(page, "login");
  await assertAssets(page, "login");
  settle(m, "landing/login");
});

test("guest exchange → done → claim CTA, then signed-in app home", async ({ page, context }, info) => {
  const net = network(info);
  const locale = pickLocale(String(info.project.use.locale ?? "ko-KR"));
  const msg = GUEST_MESSAGES[locale];
  const scan = SCANNER_MESSAGES[locale];
  const sender = await signup();
  const s = await (await sender.api.post("/api/v1/exchange/sessions", { data: { capabilities: { webShare: true } } })).json();
  expect(s.token).toBeTruthy();

  const m = monitor(page);
  await throttle(page, net);
  await page.goto(`/x/${s.token}`, { waitUntil: "domcontentloaded" });
  // LCP-ish budget: navigation → first contentful paint
  const fcp = await page.waitForFunction(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null, null, { timeout: 30_000 }).then((h) => h.jsonValue() as Promise<number>);
  info.annotations.push({ type: "fcp_ms", description: String(Math.round(fcp)) });
  expect(fcp, `FCP ${Math.round(fcp)}ms over budget (${net})`).toBeLessThan(net === "slow3g" ? 6000 : 2500);
  await expect(page.getByRole("heading", { name: new RegExp(sender.name) }).first()).toBeVisible();
  await expect(page.getByText("MATRIX-PRIVATE")).toHaveCount(0); // private field never on the guest landing
  await expect(page.getByTestId("qr-fallback")).toHaveCount(0); // rule 3: no QR on the receiver's first screen
  await page.waitForLoadState("load");
  await assertLayout(page, "guest landing");
  await assertAssets(page, "guest landing");

  await page.getByTestId("reply-cta").click();
  const manual = page.getByTestId("manual-entry");
  await expect(manual).toHaveText(scan.manual); // capture step speaks the guest's language
  await assertLayout(page, "guest capture");
  await manual.click();
  await page.locator('input[name="fullName"]').fill(`게스트 ${uniq().slice(-4)}`);
  await page.locator('input[name="email"]').fill(`g${uniq()}@matrix.test`);
  await expect(page.getByTestId("send-cta")).toBeDisabled(); // consent first
  await page.locator('input[name="consent"]').check();
  await assertLayout(page, "guest review");

  if (net === "offline-then-online") {
    m.allowNetworkErrors = true;
    await context.setOffline(true);
    await page.getByTestId("send-cta").click();
    await expect(page.locator("main p[role=alert]")).toHaveText(msg.networkError);
    await context.setOffline(false);
    m.allowNetworkErrors = false;
  }
  await page.getByTestId("send-cta").click();
  await expect(page.getByRole("heading", { name: `${msg.doneTitle} ${msg.doneEm}` })).toBeVisible();
  await expect(page.getByTestId("claim-cta")).toBeVisible(); // rule 2: claim only after the exchange
  await expect(page.getByTestId("claim-cta")).toHaveText(new RegExp(msg.claimCta));
  await assertLayout(page, "guest done");
  settle(m, "guest");

  // signed-in app home with the sender's session
  const state = await sender.api.storageState();
  await signedIn(context, state.cookies);
  const home = monitor(page);
  await page.goto("/app", { waitUntil: "load" });
  await expect(page.locator("h1").first()).toContainText(sender.name);
  await assertLayout(page, "app home");
  await assertAssets(page, "app home");
  settle(home, "app home");
  // malformed / unknown ids are client errors, never 500 (QA BUG-12)
  expect((await page.request.get("/api/v1/contacts/not-a-uuid")).status()).toBe(404);
  expect((await page.request.get(`/api/v1/contacts/${crypto.randomUUID()}`)).status()).toBe(404);
  await sender.api.dispose();
});

async function signedIn(context: BrowserContext, cookies: Awaited<ReturnType<APIRequestContext["storageState"]>>["cookies"]) {
  await context.clearCookies();
  await context.addCookies(cookies.map((c) => ({ ...c, sameSite: c.sameSite ?? "Lax" })));
}
