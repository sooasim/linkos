"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";

const TABS: { href: string; label: string; icon: IconName }[] = [
  { href: "/app", label: "홈", icon: "home" },
  { href: "/app/people", label: "인맥", icon: "people" },
  { href: "/app/exchange", label: "교환", icon: "exchange" },
  { href: "/app/ai", label: "AI", icon: "spark" },
  { href: "/app/me", label: "나", icon: "me" },
];

/** 주요 행동은 한 손 엄지 영역(하단)에 — 가운데 교환 버튼이 가장 크다. */
export function Dock() {
  const path = usePathname();
  const active = (href: string) => (href === "/app" ? path === "/app" : path.startsWith(href));
  return (
    <nav aria-label="주요 메뉴" className="fixed inset-x-0 bottom-0 z-40 px-4 safe-bottom lg:hidden">
      <ul className="dock mx-auto flex max-w-md items-center justify-between rounded-[28px] px-2 py-1.5">
        {TABS.map((t) =>
          t.icon === "exchange" ? (
            <li key={t.href}>
              <Link href={t.href} aria-label="교환" className="-mt-7 grid size-16 place-items-center rounded-full bg-[var(--color-signal)] text-[var(--color-ink)] shadow-[0_14px_30px_-10px_rgba(166,204,31,.9)] ring-4 ring-[var(--bg)] transition active:scale-95">
                <Icon name="exchange" size={26} strokeWidth={2.2} />
              </Link>
            </li>
          ) : (
            <li key={t.href}>
              <Link href={t.href} aria-current={active(t.href) ? "page" : undefined} className={`flex w-14 flex-col items-center gap-0.5 rounded-2xl py-1.5 text-[10.5px] font-semibold transition ${active(t.href) ? "bg-[var(--accent-soft)] text-[var(--accent-text)]" : "text-[var(--fg-mute)] hover:text-[var(--fg)]"}`}>
                <Icon name={t.icon} size={22} strokeWidth={active(t.href) ? 2.1 : 1.7} />
                {t.label}
              </Link>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

const SIDE: { href: string; label: string; icon: IconName }[] = [
  { href: "/app", label: "홈", icon: "home" },
  { href: "/app/exchange", label: "교환", icon: "exchange" },
  { href: "/app/scan", label: "명함 스캔", icon: "scan" },
  { href: "/app/people", label: "인맥", icon: "people" },
  { href: "/app/meetings", label: "미팅", icon: "calendar" },
  { href: "/app/ai", label: "AI 기억·매칭", icon: "spark" },
  { href: "/app/messages", label: "메시지", icon: "message" },
  { href: "/app/calendar", label: "일정", icon: "calendar" },
  { href: "/app/intros", label: "소개·Room", icon: "room" },
  { href: "/app/events", label: "행사", icon: "flag" },
  { href: "/app/team", label: "팀 주소록", icon: "people" },
  { href: "/app/org", label: "조직", icon: "building" },
  { href: "/app/me", label: "내 Living Card", icon: "me" },
  { href: "/app/inbox", label: "알림함", icon: "bell" },
  { href: "/app/insights", label: "인사이트", icon: "chart" },
  { href: "/app/integrations", label: "CRM·자동화", icon: "plug" },
  { href: "/app/billing", label: "플랜·결제", icon: "card" },
  { href: "/app/settings", label: "설정·연동", icon: "settings" },
];

export function SideNav() {
  const path = usePathname();
  return (
    <nav aria-label="사이드 메뉴" className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--glass)] px-4 py-6 backdrop-blur-xl lg:flex">
      <Link href="/app" className="px-3">
        <span className="inline-flex items-center gap-2 font-semibold"><svg width="26" height="26" viewBox="0 0 32 32" aria-hidden><rect x="3" y="8" width="17" height="12" rx="3.5" fill="none" stroke="currentColor" strokeWidth="2.2" transform="rotate(-12 11.5 14)" /><rect x="12" y="12" width="17" height="12" rx="3.5" fill="#8f7bff" transform="rotate(8 20.5 18)" /></svg>LINKOS</span>
      </Link>
      <ul className="no-scrollbar mt-8 -mx-1 flex-1 space-y-0.5 overflow-y-auto px-1">
        {SIDE.map((t) => {
          const on = t.href === "/app" ? path === "/app" : path.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={on ? "page" : undefined} className={`flex items-center gap-3 rounded-2xl px-3 py-2.5 text-[14.5px] font-medium transition ${on ? "bg-[var(--accent-soft)] text-[var(--accent-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_18%,transparent)]" : "text-[var(--fg-mute)] hover:bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] hover:text-[var(--fg)]"}`}>
                <Icon name={t.icon} size={19} />
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <Link href="/app/exchange" className="btn btn-signal mt-4 w-full">
        <Icon name="exchange" size={18} /> 명함 교환
      </Link>
    </nav>
  );
}
