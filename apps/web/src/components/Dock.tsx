"use client";
// App navigation — mobile Dock + top utility bar (알림함 unread badge F-109 리마인더 수신, 설정·연동 진입), desktop SideNav
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { Icon, type IconName } from "./Icon";

// ---------- unread notifications: ONE shared poller for every badge on the page ----------
const POLL_MS = 60_000;
let unread = 0;
const listeners = new Set<() => void>();
let timer: number | null = null;
let inflight = false;

async function refreshUnread() {
  if (inflight || typeof document === "undefined" || document.visibilityState === "hidden") return;
  inflight = true;
  try {
    const res = await fetch("/api/v1/notifications/count", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return;
    const n = Number(((await res.json()) as { unread?: number }).unread ?? 0);
    if (Number.isFinite(n) && n !== unread) {
      unread = n;
      for (const l of listeners) l();
    }
  } catch {
    /* offline — keep the last known count */
  } finally {
    inflight = false;
  }
}
const onWake = () => void refreshUnread();

function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1) {
    void refreshUnread();
    timer = window.setInterval(onWake, POLL_MS);
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size) {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    }
  };
}

export function useUnreadCount(): number {
  const n = useSyncExternalStore(subscribe, () => unread, () => 0);
  const path = usePathname();
  // reading the inbox marks items read → re-count after navigating
  useEffect(() => {
    void refreshUnread();
  }, [path]);
  return n;
}

const badgeText = (n: number) => (n > 99 ? "99+" : String(n));
const inboxLabel = (n: number) => (n > 0 ? `알림함, 읽지 않은 알림 ${n}개` : "알림함");

/** 모바일 상단 유틸리티: 알림함(배지) · 설정·연동 — Dock 5칸 밖의 필수 진입점 */
function MobileTopBar() {
  const n = useUnreadCount();
  const path = usePathname();
  const btn = (on: boolean) =>
    `relative grid size-9 place-items-center rounded-full transition ${on ? "bg-[var(--accent-soft)] text-[var(--accent-text)]" : "text-[var(--fg-mute)] hover:text-[var(--fg)]"}`;
  return (
    <nav aria-label="알림·설정" className="dock absolute right-4 top-2 z-30 flex items-center gap-0.5 rounded-full p-0.5 lg:hidden">
      <Link href="/app/inbox" aria-label={inboxLabel(n)} aria-current={path.startsWith("/app/inbox") ? "page" : undefined} className={btn(path.startsWith("/app/inbox"))} data-testid="nav-inbox">
        <Icon name="bell" size={18} />
        {n > 0 && (
          <span aria-hidden className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[var(--color-ember)] px-1 text-[10.5px] font-bold leading-none text-white ring-2 ring-[var(--bg)]" data-testid="inbox-badge">
            {badgeText(n)}
          </span>
        )}
      </Link>
      <Link href="/app/settings" aria-label="설정·연동" aria-current={path.startsWith("/app/settings") ? "page" : undefined} className={btn(path.startsWith("/app/settings"))} data-testid="nav-settings">
        <Icon name="settings" size={18} />
      </Link>
    </nav>
  );
}

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
    <>
    <MobileTopBar />
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
    </>
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
  const n = useUnreadCount();
  return (
    <nav aria-label="사이드 메뉴" className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--glass)] px-4 py-6 backdrop-blur-xl lg:flex">
      <Link href="/app" className="px-3">
        <span className="inline-flex items-center gap-2 font-semibold"><svg width="26" height="26" viewBox="0 0 32 32" aria-hidden><rect x="3" y="8" width="17" height="12" rx="3.5" fill="none" stroke="currentColor" strokeWidth="2.2" transform="rotate(-12 11.5 14)" /><rect x="12" y="12" width="17" height="12" rx="3.5" fill="#8f7bff" transform="rotate(8 20.5 18)" /></svg>LINKOS</span>
      </Link>
      <ul className="no-scrollbar mt-8 -mx-1 flex-1 space-y-0.5 overflow-y-auto px-1">
        {SIDE.map((t) => {
          const on = t.href === "/app" ? path === "/app" : path.startsWith(t.href);
          const inbox = t.href === "/app/inbox";
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={on ? "page" : undefined} aria-label={inbox ? inboxLabel(n) : undefined} className={`flex items-center gap-3 rounded-2xl px-3 py-2.5 text-[14.5px] font-medium transition ${on ? "bg-[var(--accent-soft)] text-[var(--accent-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_18%,transparent)]" : "text-[var(--fg-mute)] hover:bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] hover:text-[var(--fg)]"}`}>
                <Icon name={t.icon} size={19} />
                {t.label}
                {inbox && n > 0 && (
                  <span aria-hidden className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-[var(--color-ember)] px-1.5 text-[11px] font-bold leading-none text-white">
                    {badgeText(n)}
                  </span>
                )}
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
