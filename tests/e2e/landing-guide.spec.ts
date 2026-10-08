// Landing 06 전체 기능 · 07 사용 방법 · 08 FAQ — the catalog must cover every Feature ID in the registry and the guide
// must cover every screen, so adding a feature or a page without documenting it on the main page fails here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "@playwright/test";
import { parse } from "yaml";
import { FEATURE_GROUPS } from "../../apps/web/src/app/_landing/features";
import { FAQ, GUIDE } from "../../apps/web/src/app/_landing/guide";

const ROOT = join(__dirname, "..", "..");
const APP_DIR = join(ROOT, "apps/web/src/app");
// Operator console (platform admins only, 404 for everyone else) — listed in the catalog, not in the user guide.
const NOT_USER_FACING = new Set(["/app/admin", "/legal/privacy", "/legal/terms"]);

function pageRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "api" || name.startsWith("_")) continue;
      out.push(...pageRoutes(p));
    } else if (name === "page.tsx") {
      const r = "/" + relative(APP_DIR, dir).split(sep).join("/");
      out.push(r === "/" ? "/" : r);
    }
  }
  return out;
}

const catalogIds = new Set(FEATURE_GROUPS.flatMap((g) => g.items.flatMap((i) => i.ids)));
const guideRoutes = new Set(GUIDE.flatMap((p) => p.topics.flatMap((t) => t.routes.map((r) => r.split("?")[0]))));
const topics = GUIDE.flatMap((p) => p.topics);

test("catalog lists every Feature ID in the registry and every X-extra", () => {
  const registry = parse(readFileSync(join(ROOT, "dd/LINKOS_Product_Blueprint_v1/03_FEATURE_REGISTRY.yaml"), "utf8")) as { features: { id: string }[] };
  const ids = registry.features.map((f) => f.id);
  expect(ids.length).toBe(197);
  expect(ids.filter((id) => !catalogIds.has(id))).toEqual([]);
  const extras = [...readFileSync(join(ROOT, "docs/TRACEABILITY.md"), "utf8").matchAll(/^\| (X-\d{3}) \|/gm)].map((m) => m[1]);
  expect(extras.length).toBeGreaterThan(0);
  expect(extras.filter((id) => !catalogIds.has(id))).toEqual([]);
  expect([...catalogIds].filter((id) => !ids.includes(id) && !extras.includes(id))).toEqual([]);
});

test("guide has a topic for every user-facing screen", () => {
  const routes = pageRoutes(APP_DIR).filter((r) => r !== "/" && !NOT_USER_FACING.has(r));
  expect(routes.length).toBeGreaterThan(30);
  expect(routes.filter((r) => !guideRoutes.has(r))).toEqual([]);
  expect(new Set(topics.map((t) => t.id)).size).toBe(topics.length);
  for (const t of topics) expect(t.steps.length, t.id).toBeGreaterThan(0);
});

test("landing renders features, the full guide and FAQ without login", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 2, name: /필요한 모든 것/ })).toBeVisible();
  await expect(page.locator("[data-feature-group]")).toHaveCount(FEATURE_GROUPS.length);
  await expect(page.locator("[data-guide-topic]")).toHaveCount(topics.length);
  await expect(page.locator("#faq details")).toHaveCount(FAQ.length);

  // core flows start open; the rest expand on tap (native <details>, works without JS)
  await expect(page.locator("#guide-send")).toHaveAttribute("open", "");
  const scan = page.locator("#guide-scan");
  await expect(scan).not.toHaveAttribute("open", "");
  await scan.locator("summary").click();
  await expect(scan).toHaveAttribute("open", "");
  await expect(scan.getByText("인맥에 저장", { exact: true }).first()).toBeVisible();

  // table of contents jumps to a topic
  await page.getByRole("navigation", { name: "사용 방법 목차" }).getByRole("link", { name: "4자리 코드 · 받기 모드로 받기" }).click();
  await expect(page).toHaveURL(/#guide-code$/);

  // still the same hero CTA, and the long content never scrolls sideways on phones
  await expect(page.locator('a[href="/login"]').filter({ hasText: "무료로 시작하기" }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
