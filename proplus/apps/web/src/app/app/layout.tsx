/**
 * P-180 워크스페이스 셸 (`/app/**`).
 *
 * ## 여기서 하는 판단과 하지 않는 판단
 *
 * **하는 것**: 비로그인이면 로그인 화면으로 보낸다. 역할에 따라 "운영 콘솔" 링크를 노출할지 고른다.
 * **하지 않는 것**: 권한 계산. `identity.principalFor()` 가 돌려주는 것은 "지금 이 사람의 역할"이라는
 * **사실**이고, 링크를 숨기는 것은 접근 제어가 아니라 **표시** 결정이다. 실제 차단은 각 API·모듈이
 * `can()` 으로 한다 (전략 §3 계층 규칙: UI 는 서버가 걸러 준 것만 그린다).
 * 그래서 이 파일에 `platformRole === 'admin'` 같은 **능력 판정식**을 쓰지 않는다 — 역할이 있으면
 * 링크를 보여 주고, 권한이 없으면 그 화면이 403 을 돌려주는 것을 그대로 보여 준다.
 *
 * `main` 의 `id="main"` 은 루트 레이아웃의 "본문으로 건너뛰기" 링크가 가리키는 지점이다(P-193).
 * 워크스페이스 하위 페이지는 자기 `<main>` 을 만들지 않는다 — 중첩되면 랜드마크가 두 개가 된다.
 */

import { identity } from "@proplus/api";
import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { SignOutButton } from "@/components/SignOutButton";
import { getViewer, safeNext } from "@/lib/server";

/** 워크스페이스 내비게이션. 경로는 CONTRACTS §`@proplus/web` 라우트의 `app/app/**` 목록과 같다. */
const NAV = [
  { href: "/app", label: "홈", note: "요약" },
  { href: "/app/profile", label: "프로필", note: "공개 페이지" },
  { href: "/app/evidence", label: "검증", note: "증거·배지" },
  { href: "/app/leads", label: "상담", note: "문의 처리" },
  { href: "/app/offers", label: "상품", note: "서비스 카드" },
  { href: "/app/analytics", label: "분석", note: "조회·전환" },
  { href: "/app/settings", label: "설정", note: "세션·계정" },
] as const;

/**
 * 로그인 후 돌아올 경로.
 *
 * 레이아웃은 현재 경로를 인자로 받지 못한다(Next 16 의 layout 에는 pathname prop 이 없다).
 * 클라이언트 내비게이션에서는 Next 가 `next-url` 요청 헤더를 붙여 주므로 그때만 그 값을 쓰고,
 * 주소를 직접 열어 들어온 경우에는 `/app` 으로 떨어뜨린다 — **틀린 곳으로 보내는 것보다
 * 덜 구체적인 곳으로 보내는 쪽이 안전하다.** 값은 `safeNext()` 를 거쳐 open redirect 를 막는다.
 */
async function returnPath(): Promise<string> {
  const h = await headers();
  return safeNext(h.get("next-url"), "/app");
}

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await getViewer();
  if (!userId) {
    redirect(`/login?next=${encodeURIComponent(await returnPath())}`);
  }

  const principal = await identity.principalFor(userId);
  // 운영 콘솔은 역할이 있는 사람에게만 **보여 준다**. 접근 자체는 /admin 과 그 API 가 막는다.
  const showAdminLink = principal.platformRole !== "none";

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-0 px-4 sm:px-6 lg:flex-row lg:gap-8 lg:px-8">
      {/* ── 사이드 내비 ────────────────────────────────────────
          모바일에서는 가로 스크롤 줄로 접힌다. 주요 행동(상담·프로필)이 엄지에 닿는 위치에
          오도록 본문을 위로 올리고, 내비는 상단에 얇게 둔다 (브랜드 §7 모바일 우선). */}
      <aside className="shrink-0 border-b border-[var(--line)] py-4 lg:w-[232px] lg:border-b-0 lg:py-8">
        <div className="flex items-center justify-between gap-3 lg:block">
          <Link href="/" className="display text-[20px] tracking-tight">
            PROPLUS
          </Link>
          <p className="hidden text-[12px] text-[var(--fg-mute)] lg:mt-1 lg:block">워크스페이스</p>
        </div>

        <nav aria-label="워크스페이스 메뉴" className="mt-4 lg:mt-7">
          <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
            {NAV.map((item) => (
              <li key={item.href} className="shrink-0">
                <Link
                  href={item.href}
                  className="flex min-h-11 items-center gap-2 rounded-[10px] px-3 text-[14.5px] font-medium text-[var(--fg)] hover:bg-[var(--bg-sunk)]"
                >
                  <span>{item.label}</span>
                  <span className="hidden text-[12px] font-normal text-[var(--fg-mute)] lg:inline">{item.note}</span>
                </Link>
              </li>
            ))}
            {showAdminLink ? (
              <li className="shrink-0">
                <Link
                  href="/admin"
                  className="flex min-h-11 items-center gap-2 rounded-[10px] px-3 text-[14.5px] font-medium text-[var(--accent-text)] hover:bg-[var(--accent-soft)]"
                >
                  <span>운영 콘솔</span>
                  {/* 역할을 색으로만 말하지 않는다 (브랜드 §7). */}
                  <span className="hidden text-[12px] font-normal text-[var(--fg-mute)] lg:inline">검증·신고</span>
                </Link>
              </li>
            ) : null}
          </ul>
        </nav>

        <div className="mt-5 hidden lg:block">
          <hr className="rule" />
          <div className="mt-5">
            <SignOutButton />
          </div>
        </div>
      </aside>

      <main id="main" className="min-w-0 flex-1 py-7 lg:py-10">
        {children}

        {/* 모바일에서는 로그아웃을 본문 끝에 둔다 — 상단 내비에 섞으면 실수로 눌리기 쉽다. */}
        <div className="mt-12 lg:hidden">
          <hr className="rule" />
          <div className="mt-6 max-w-xs">
            <SignOutButton />
          </div>
        </div>
      </main>
    </div>
  );
}
