/**
 * 운영 콘솔 셸 — M12 (P-160 접근 제한 · P-165/P-166 기록 안내).
 *
 * ## 왜 403 이 아니라 404 인가
 *
 * 역할이 없으면 `notFound()` 다. 403 은 "여기 무언가 있다"를 알려 주고, 운영 콘솔의 존재·경로 모양은
 * 공격자에게 그 자체로 쓸모 있는 정보다 (보안정책 §2 "관리자 내부 오남용"). 숨기는 비용이 0 이므로 숨긴다.
 *
 * ## UI 는 권한을 판단하지 않는다 (전략 §3)
 *
 * 여기서 역할을 보는 것은 **메뉴를 그릴지**를 정하는 표시 판단이다. 실제 차단은 각 모듈 함수의
 * `mustCan()` 이고, 이 레이아웃을 우회해 `/api/v1/admin/**` 를 직접 불러도 같은 판정에 막힌다.
 * 즉 이 분기가 보안 경계가 아니라는 점이 중요하다 — 경계는 모듈에 있다.
 *
 * ## 감사 안내를 상시 띄우는 이유 (M12 / P-165)
 *
 * 경고가 아니라 **사실 안내**다. 기술백서 §5 는 운영자 접근에 "목적·승인·시간 제한·감사로그"를
 * 요구하는데, 기록이 남는다는 것을 운영자가 알고 일하는 것 자체가 통제의 일부다. 숨기면 통제가 아니라 함정이 된다.
 */

import { identity } from "@proplus/api";
import type { PlatformRole } from "@proplus/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/server";

export const metadata: Metadata = {
  title: "운영 콘솔",
  // 운영 콘솔은 색인될 이유가 없다. 경로가 검색에 걸리면 위 404 전략이 무의미해진다.
  robots: { index: false, follow: false },
};

/**
 * 다섯 항목 모두 `reviewer` 와 `admin` 에게 동일하게 열린다 — `acl.ts` 의
 * `PLATFORM_CAPABILITIES`(evidence.review · report.handle · audit.read · admin.access)가
 * 두 역할을 구분하지 않기 때문이다. 그래서 여기에는 `admin` 전용 항목이 없다.
 *
 * 역할로 갈리는 기능은 플랫폼 권한 변경(P-171, `admin.setPlatformRole` — 모듈이 `platformRole === 'admin'`
 * 를 한 번 더 본다)뿐이고 전용 화면이 아직 없다. 없는 화면을 메뉴에 걸지 않는다(브랜드 §5).
 */
const NAV = [
  { href: "/admin", label: "운영 KPI", note: "P-172" },
  { href: "/admin/queue", label: "검토 큐", note: "P-160" },
  { href: "/admin/appeals", label: "이의제기", note: "P-168" },
  { href: "/admin/reports", label: "신고", note: "P-167" },
  { href: "/admin/audit", label: "감사로그", note: "P-166" },
] as const;

const ROLE_LABEL_KO: Readonly<Record<PlatformRole, string>> = {
  none: "권한 없음",
  reviewer: "검증자",
  admin: "플랫폼 관리자",
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await getViewer();
  const principal = await identity.principalFor(userId);
  const role = principal.platformRole;
  if (role !== "reviewer" && role !== "admin") notFound();

  return (
    <div className="min-h-dvh bg-[var(--bg-sunk)]">
      <header className="border-b border-[var(--line)] bg-[var(--bg-elev)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-5 pt-4 sm:px-8">
          <Link href="/admin" className="display text-[20px]">
            PROPLUS
          </Link>
          <span className="text-[14px] font-semibold text-[var(--fg-mute)]">운영 콘솔</span>
          {/* 역할은 텍스트로 적는다 — 색이나 위치만으로 "지금 무슨 권한인지"를 말하지 않는다 (브랜드 §7). */}
          <span className="chip font-semibold">{ROLE_LABEL_KO[role]}</span>
          <Link href="/" className="ml-auto text-[13.5px] text-[var(--fg-mute)] hover:text-[var(--fg)]">
            콘솔 나가기
          </Link>
        </div>

        {/*
          현재 항목 표시(aria-current)를 넣지 않았다: 레이아웃은 서버 컴포넌트라 경로를 알 수 없고,
          그것만을 위해 셸 전체를 클라이언트로 내리면 운영 콘솔의 첫 렌더에 불필요한 JS 가 붙는다.
          대신 각 페이지가 보이는 <h1> 으로 지금 어디인지 말한다.
        */}
        <nav aria-label="운영 콘솔 메뉴" className="mx-auto max-w-6xl px-5 sm:px-8">
          <ul className="flex flex-wrap gap-1 py-2">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="inline-flex min-h-11 items-center rounded-full px-3.5 text-[14.5px] font-semibold text-[var(--fg-mute)] hover:bg-[var(--bg-sunk)] hover:text-[var(--accent-text)]"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      {/* 아이콘 + 텍스트. 아이콘만으로는 전달되지 않고, 색만으로도 전달되지 않아야 한다 (P-193). */}
      <div className="border-b border-[var(--line)] bg-[var(--accent-soft)]">
        <p className="mx-auto flex max-w-6xl items-start gap-2.5 px-5 py-3 text-[13.5px] leading-relaxed text-[var(--accent-text)] sm:px-8">
          <svg
            className="mt-[2px] size-4 flex-none"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="8" cy="8" r="6.4" />
            <line x1="8" y1="7.2" x2="8" y2="11.4" />
            <circle cx="8" cy="4.9" r="0.75" fill="currentColor" stroke="none" />
          </svg>
          <span>
            이 화면의 모든 조회와 승인은 감사로그에 기록됩니다. 개인 데이터 조회에는 접근 사유를 입력해야 하고,
            기록은 수정·삭제할 수 없습니다.
          </span>
        </p>
      </div>

      <main id="main" className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-10">
        {children}
      </main>
    </div>
  );
}
