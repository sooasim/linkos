// UI/UX v2 역할별 콘솔(/console) — 4역할 × 6화면 = 24 대시보드.
// prototype/assets/dashboard-suite.js 를 그대로 옮긴 정적 클라이언트 데모(실제 API/DB/결제/AI 미연동)라
// 로그인 없이 모든 라우트가 렌더되고, 핵심 화면 내 상호작용과 WCAG A/AA(디자인 시스템 §5)를 검증한다.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const T = "hankook";
const C = "seoulbiz";

// [route, 페이지 제목(h1)] — 24개 화면 + 콘솔 랜딩. 라우트는 uiux/SCREEN_CATALOG.csv Target_Route 를
// /console 접두사 아래 그대로 옮긴 것.
const SCREENS: [string, string][] = [
  ["/console", "역할별 대시보드 콘솔"],
  // 일반 회원 U-M01~06
  ["/console/app", "반갑습니다, 김회원님"],
  ["/console/app/meetings", "나의 모임과 1:1"],
  ["/console/app/referrals", "사업 소개 · 승인 현황"],
  ["/console/app/directory", "기업 탐색"],
  ["/console/app/company", "내 기업 프로필"],
  ["/console/app/settings/privacy", "공개 · 동의 설정"],
  // 챕터 운영자 U-C01~06
  [`/console/t/${T}/ch/${C}/dashboard`, "챕터 운영 현황"],
  [`/console/t/${T}/ch/${C}/members`, "회원 · 승인 심사"],
  [`/console/t/${T}/ch/${C}/meetings`, "모임 · 출석 운영"],
  [`/console/t/${T}/ch/${C}/referrals`, "소개 · 후속관리 데스크"],
  [`/console/t/${T}/ch/${C}/visitors`, "방문자 · 게스트 운영"],
  [`/console/t/${T}/ch/${C}/reports`, "챕터 성과 분석"],
  // 기관 관리자 U-T01~06
  [`/console/t/${T}/dashboard`, "기관 관리 대시보드"],
  [`/console/t/${T}/chapters`, "챕터 운영 현황"],
  [`/console/t/${T}/billing`, "구독 · 청구 관리"],
  [`/console/t/${T}/policies`, "운영 정책 · 권한"],
  [`/console/t/${T}/branding`, "화이트라벨 · 브랜드 설정"],
  [`/console/t/${T}/insights`, "기관 통합 성과"],
  // 플랫폼 관리자 U-P01~06
  ["/console/p/admin", "플랫폼 운영 개요"],
  ["/console/p/admin/tenants", "운영기관 계약 관리"],
  ["/console/p/admin/support", "지원 · 신고 티켓"],
  ["/console/p/admin/security", "보안 · 감사 이벤트"],
  ["/console/p/admin/health", "서비스 상태 · 운영 지표"],
  ["/console/p/admin/releases", "배포 · 변경 승인"],
];

test.describe("console · 24 역할 대시보드 렌더", () => {
  for (const [path, heading] of SCREENS) {
    test(`renders ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      // 셸 화면(랜딩 제외)에는 "가상 데이터" 고지 배너가 항상 보여야 한다.
      if (path !== "/console") {
        await expect(page.getByText("UI/UX 정적 데모")).toBeVisible();
      }
    });
  }
});

test.describe("console · 화면 내 상호작용", () => {
  // 비타협 원칙: 연락처는 양측(A·B) 승인 전에는 화면에 렌더링조차 되지 않는다.
  test("회원 소개 쌍방 승인 전에는 연락처가 잠겨 있고, 승인 후에만 공개된다", async ({ page }) => {
    await page.goto("/console/app/referrals");
    await expect(page.getByText("🔒 잠김")).toBeVisible();
    await expect(page.getByText("demo@company.invalid")).toHaveCount(0);

    await page.getByRole("button", { name: "A 승인 시연" }).click();
    await page.getByRole("button", { name: "B 승인 시연" }).click();

    await expect(page.getByText("demo@company.invalid")).toBeVisible();
    await expect(page.getByText("🔒 잠김")).toHaveCount(0);
    await expect(page.getByText("가상 연락 경로 열림")).toBeVisible();
  });

  // 탐색은 공개 동의된 합성 기업만 보여주며, 검색은 클라이언트에서 즉시 필터링한다.
  test("기업 탐색 검색이 합성 기업 목록을 필터링한다", async ({ page }) => {
    await page.goto("/console/app/directory");
    await expect(page.getByText("가상AI랩")).toBeVisible();

    await page.locator("#directorySearch").fill("제조");
    await expect(page.getByText("가상그린산업")).toBeVisible();
    await expect(page.getByText("가상AI랩")).toHaveCount(0);

    await page.getByRole("button", { name: "초기화" }).click();
    await expect(page.getByText("가상AI랩")).toBeVisible();
  });

  // 목적별 동의 토글은 데모 상태만 바꾸며, 서버 기록은 생성하지 않는다는 고지를 띄운다.
  test("동의 토글이 데모 고지 토스트를 띄운다", async ({ page }) => {
    await page.goto("/console/app/settings/privacy");
    await page.getByRole("checkbox", { name: "광고성 이메일" }).check();
    await expect(page.getByRole("status")).toContainText("선택 동의 시연 값만");
  });

  // 역할 전환은 시연용 드롭다운이며(실제 권한 전환 아님), 선택 시 해당 역할 라우트로 이동한다.
  test("역할 드롭다운으로 플랫폼 콘솔로 전환한다", async ({ page }) => {
    await page.goto("/console/app");
    await page.getByLabel("시연용 역할 선택").selectOption("platform");
    await expect(page).toHaveURL(/\/console\/p\/admin$/);
    await expect(page.getByRole("heading", { level: 1, name: "플랫폼 운영 개요" })).toBeVisible();
  });

  // 회원 승인은 검토 사유가 필수이며, 입력 후에만 상태가 바뀐다.
  test("챕터 회원 승인은 사유 입력을 요구하고 처리 후 상태를 바꾼다", async ({ page }) => {
    await page.goto(`/console/t/${T}/ch/${C}/members`);
    await page.getByRole("button", { name: "승인", exact: true }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // 사유가 비어 있으면 차단된다.
    await dialog.getByRole("button", { name: "시연 처리" }).click();
    await expect(page.getByRole("status")).toContainText("검토 사유");
    await expect(dialog).toBeVisible();

    // 사유 입력 후 처리하면 모달이 닫히고 상태 변경 고지가 뜬다.
    await page.locator("#approveReason").fill("업종 중복 없음 확인");
    await dialog.getByRole("button", { name: "시연 처리" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("시연 상태를 변경");
  });

  // 모달 포커스 트랩: Escape 로 닫힌다.
  test("모달은 Escape 로 닫힌다", async ({ page }) => {
    await page.goto(`/console/t/${T}/ch/${C}/members`);
    await page.getByRole("button", { name: "회원 초대" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  // CSV 내보내기는 집계값만 담은 고정 파일명을 내려받는다(실사용자 정보 없음).
  test("챕터 리포트 CSV 내보내기는 집계 전용 파일을 내려받는다", async ({ page }) => {
    await page.goto(`/console/t/${T}/ch/${C}/reports`);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "CSV 시연 내보내기" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("LINKOS_DEMO_AGGREGATE_ONLY.csv");
  });
});

// 디자인 시스템 §5: 색 대비 AA, 포커스 링, 아이콘 aria-label. 역할별 대표 화면을 라이트/다크에서 감사한다.
const A11Y_PATHS = [
  "/console",
  "/console/app",
  "/console/app/settings/privacy",
  `/console/t/${T}/ch/${C}/dashboard`,
  `/console/t/${T}/dashboard`,
  "/console/p/admin",
];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`console a11y (${scheme})`, () => {
    test.use({ colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });
    for (const path of A11Y_PATHS) {
      test(`axe: ${path} has no WCAG A/AA violations`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      });
    }
  });
}
