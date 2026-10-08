// WCAG 2 A/AA automated audit (axe) on public pages in light + dark mode — design system §5 접근성 규칙.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`a11y (${scheme})`, () => {
    test.use({ colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });
    for (const path of ["/", "/login", "/c", "/legal/terms", "/x/not-a-real-token"]) {
      test(`axe: ${path} has no WCAG A/AA violations`, async ({ page }) => {
        await page.goto(path);
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      });
    }
  });
}
