// Settings / Org / Team / Messages / Card editor gaps over real HTTP + UI:
// F-137 F-166 내 활동 기록 · F-125 UX-023 내보내기 기간·보고서 · F-110 푸시 기록 · F-129 조직 삭제 · F-134 F-138 내 멤버십 설정
// F-076 팀 메모 삭제 · F-106 초안 삭제 · F-031 상대별 보기 미리보기
import { type Page, expect, test } from "@playwright/test";
import pg from "pg";

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const DB = process.env.DATABASE_URL ?? "postgres://linkos:linkos@localhost:5432/linkos";

async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

async function signIn(page: Page, email: string, next = "/app") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("이메일").fill(email);
  await page.getByRole("button", { name: "코드 받기" }).click();
  const code = (await page.getByTestId("dev-code").locator("b").textContent())!.trim();
  await page.getByLabel("6자리 코드").fill(code);
  await page.getByRole("button", { name: "로그인" }).click();
  const consent = page.getByRole("button", { name: "전체 동의" });
  const target = new RegExp(next.replace(/[/?]/g, "\\$&"));
  await Promise.race([consent.waitFor(), page.waitForURL(target)]);
  if (await consent.isVisible()) {
    await consent.click();
    await page.getByRole("button", { name: "동의하고 가입 완료" }).click();
  }
  await page.waitForURL(target);
}

async function post(page: Page, path: string, data: unknown) {
  const r = await page.request.post(`/api/v1${path}`, { data, headers: { "idempotency-key": `e2e-${uniq()}` } });
  expect(r.ok(), `${path} → ${r.status()}`).toBeTruthy();
  return r.json();
}

test.describe.configure({ mode: "serial" });

test("F-137/F-166 activity log + F-125 export period/report + F-110 push history", async ({ page }) => {
  const email = `settings${uniq()}@linkos.test`;
  await signIn(page, email);
  await post(page, "/exports", { format: "csv", fields: ["fullName"] });
  const [u] = await sql<{ id: string }>("SELECT id FROM users WHERE email=$1", [email]);
  await sql("INSERT INTO push_notifications (user_id, kind, title, status, error) VALUES ($1,'followup','후속 리마인더 e2e','skipped','no_subscription')", [u!.id]);

  await page.goto("/app/settings");
  await expect(page.getByRole("link", { name: "동기화 대기열" })).toHaveAttribute("href", "/app/sync");

  // 내 활동 기록: friendly Korean action label
  const log = page.getByTestId("activity-log");
  await expect(log).toContainText("내보내기 파일 생성");

  // 내보내기: report types limit the formats; custom period needs valid dates
  await page.getByTestId("export-report-meetings").click();
  await expect(page.getByRole("radio", { name: "vCard" })).toHaveCount(0);
  await page.getByRole("radio", { name: "CSV" }).click();
  await page.getByText("직접 지정").click();
  await expect(page.getByTestId("export-file")).toBeDisabled();
  await page.getByLabel("시작일").fill("2026-01-01");
  await expect(page.getByTestId("export-file")).toBeEnabled();
  await page.getByText("최근 30일").click();
  const reqP = page.waitForRequest((r) => r.url().endsWith("/api/v1/exports") && r.method() === "POST");
  const dlP = page.waitForEvent("download");
  await page.getByTestId("export-file").click();
  const body = (await reqP).postDataJSON();
  expect(body.report).toBe("meetings");
  expect(typeof body.since).toBe("string");
  const dl = await dlP;
  expect(dl.suggestedFilename()).toMatch(/^linkos-meetings-.*\.csv$/);

  // F-110 push history with a human reason
  const hist = page.getByTestId("push-history");
  await expect(hist).toContainText("후속 리마인더 e2e");
  await expect(hist).toContainText("알림을 켠 기기 없음");
});

test("F-106 discard a draft from the list and from the composer", async ({ page }) => {
  await signIn(page, `drafts${uniq()}@linkos.test`);
  await post(page, "/messages", { toAddress: "a@example.com", subject: "목록에서 지울 초안", body: "본문 A" });
  await post(page, "/messages", { toAddress: "b@example.com", subject: "편집기에서 지울 초안", body: "본문 B" });
  await page.goto("/app/messages");
  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "‘목록에서 지울 초안’ 초안 삭제" }).click();
  await expect(page.getByText("목록에서 지울 초안")).toHaveCount(0);
  await page.getByText("편집기에서 지울 초안").click();
  await page.getByTestId("discard-draft").click();
  await expect(page.getByText("초안이 없어요")).toBeVisible();
});

test("F-031 card editor previews the variant per audience with field ACL", async ({ page }) => {
  await signIn(page, `variant${uniq()}@linkos.test`);
  await post(page, "/profiles", {
    name: "미리보기왕",
    company: "링코스랩",
    headline: "기본 한 줄",
    fields: [
      { type: "email", value: `pv${uniq()}@linkos.test`, visibility: "business" },
      { type: "mobile", value: "010-7777-8888", visibility: "trusted" },
    ],
    offers: [],
    needs: [],
    variants: [{ audience: "investor", headline: "투자자용 한 줄" }],
  });
  await page.goto("/app/me/edit");
  const pv = page.getByTestId("variant-preview");
  await expect(pv).toContainText("투자자용 한 줄");
  await expect(pv).toContainText("이 상대용 변형이 적용돼요");
  await expect(pv).not.toContainText("010-7777-8888");
  await pv.getByLabel("상대의 공개범위 단계").selectOption("trusted");
  await expect(pv).toContainText("010-7777-8888");
  await pv.getByRole("radio", { name: "고객" }).click();
  await expect(pv).toContainText("기본 카드가 보여요");
  await expect(pv).toContainText("기본 한 줄");
});

test("F-134/F-138 membership prefs, F-076 team note delete, F-129 org delete (typed name)", async ({ page }) => {
  await signIn(page, `orgowner${uniq()}@linkos.test`);
  const name = `삭제 테스트 ${uniq()}`;
  const o = await post(page, "/orgs", { name });
  await post(page, "/orgs/active", { orgId: o.id });
  const c = await post(page, "/contacts", { fullName: "팀 공유 상대" });
  await post(page, `/orgs/${o.id}/contacts`, { contactIds: [c.contactId], asCompanyLead: false });
  await post(page, `/orgs/${o.id}/contacts/${c.contactId}/notes`, { body: "지울 팀 메모" });

  // 내 멤버십 설정
  await page.goto("/app/org");
  const prefs = page.getByTestId("membership-prefs");
  const optOut = prefs.getByLabel(/개인 인맥 제외/);
  await expect(optOut).not.toBeChecked();
  const patched = page.waitForResponse((r) => r.url().endsWith(`/orgs/${o.id}/members/me`) && r.request().method() === "PATCH");
  await optOut.check();
  expect((await patched).ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId("membership-prefs").getByLabel(/개인 인맥 제외/)).toBeChecked();

  // 팀 메모 삭제 (confirm)
  await page.goto("/app/team");
  await page.getByRole("button", { name: /팀 공유 상대/ }).click();
  await expect(page.getByTestId("team-note")).toContainText("지울 팀 메모");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "팀 메모 삭제" }).click();
  await expect(page.getByTestId("team-note")).toHaveCount(0);

  // 조직 삭제 — typed-name confirmation
  await page.goto("/app/org/settings");
  const dz = page.getByTestId("org-danger-zone");
  await dz.getByRole("button", { name: "조직 삭제…" }).click();
  await dz.getByLabel(/조직 이름/).fill("틀린 이름");
  await expect(dz.getByTestId("org-delete-confirm")).toBeDisabled();
  await dz.getByLabel(/조직 이름/).fill(name);
  await dz.getByTestId("org-delete-confirm").click();
  await page.waitForURL(/\/app\/org$/);
  expect(await sql("SELECT 1 FROM organizations WHERE id=$1", [o.id])).toHaveLength(0);
  expect(await sql("SELECT 1 FROM audit_logs WHERE action='org.deleted' AND entity_id=$1", [o.id])).toHaveLength(1);
});
