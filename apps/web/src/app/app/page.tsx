import { analytics, card, identity } from "@linkos/api";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Avatar, Empty } from "@/components/Page";
import { CardFace } from "@/components/LivingCard";
import { getViewer } from "@/lib/server";

export const dynamic = "force-dynamic";

const SRC: Record<string, string> = { exchange: "교환", scan: "스캔", manual: "직접 추가", claim: "Claim", event: "행사", import: "가져오기" };

function when(d: Date | string | null) {
  if (!d) return "";
  const t = new Date(d);
  const days = Math.floor((Date.now() - t.getTime()) / 864e5);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  if (days < 7) return `${days}일 전`;
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(t);
}

// UX-001 Home — 오늘 행동과 관계 신호
export default async function HomePage() {
  const { userId } = await getViewer();
  const me = await identity.getMe(userId!);
  const home = await analytics.myHome(userId!);
  const profile = me.profile ? await card.loadProfile(me.profile.id) : null;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "좋은 아침이에요" : hour < 18 ? "좋은 오후예요" : "좋은 저녁이에요";
  const name = profile?.name ?? me.user.display_name ?? "";

  return (
    <div className="space-y-8">
      <header className="animate-rise">
        <p className="eyebrow">{new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</p>
        <h1 className="display mt-2 text-[48px] sm:text-[64px]">
          {greet}, <em>{name || "반가워요"}</em>
        </h1>
      </header>

      {!profile ? (
        <section className="stage-ink grain overflow-hidden rounded-[28px] p-6 animate-rise delay-1">
          <p className="eyebrow">Step 1</p>
          <h2 className="display mt-2 text-[36px]">
            먼저 <em className="text-[var(--color-signal)]">Living Card</em>를 만드세요
          </h2>
          <p className="mt-2 text-[15px] text-[var(--fg-mute)]">종이 명함을 찍으면 1분 안에 완성됩니다.</p>
          <Link href="/app/me/edit?onboarding=1" className="btn btn-signal mt-5">
            카드 만들기 <Icon name="arrow" size={18} />
          </Link>
        </section>
      ) : (
        <section className="grid gap-4 sm:grid-cols-[1.2fr_1fr] animate-rise delay-1">
          <Link href="/app/exchange" className="block transition hover:-translate-y-0.5" aria-label="내 카드로 교환 시작">
            <CardFace card={card.projectCard(profile, "owner")} size="sm" interactive={false} />
          </Link>
          <div className="grid grid-cols-2 gap-3">
            {[
              ["인맥", home.counts.contacts, "/app/people"],
              ["이번 주 만남", home.counts.encounters_7d, "/app/people"],
              ["후속 할 일", home.counts.open_followups, "#followups"],
              ["완료된 교환", home.counts.exchanges, "/app/insights"],
            ].map(([label, v, href]) => (
              <Link key={label as string} href={href as string} className="surface flex flex-col justify-between p-4 transition hover:border-[var(--line-strong)]">
                <span className="text-[12.5px] font-medium text-[var(--fg-mute)]">{label}</span>
                <span className="display num mt-2 text-[40px]">{v as number}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 animate-rise delay-2">
        {(
          [
            ["/app/exchange", "exchange", "공유하기", true],
            ["/app/scan", "scan", "명함 스캔", false],
            ["/c", "code", "코드로 받기", false],
            ["/app/exchange?group=1", "people", "그룹 교환", false],
          ] as const
        ).map(([href, icon, label, primary]) => (
          <Link key={href} href={href} className={`flex flex-col gap-6 rounded-[22px] p-4 transition active:scale-[.98] ${primary ? "bg-[var(--color-signal)] text-[var(--color-ink)]" : "surface"}`}>
            <Icon name={icon} size={24} />
            <span className="text-[15px] font-semibold">{label}</span>
          </Link>
        ))}
      </section>

      <section id="followups" className="animate-rise delay-3">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[20px] font-semibold">후속 필요</h2>
          <Link href="/app/people" className="text-[13px] text-[var(--fg-mute)]">전체</Link>
        </div>
        {home.followups.length === 0 ? (
          <Empty title="밀린 후속 업무가 없어요" body="교환이 끝나면 감사 인사 초안을 자동으로 제안해 드려요." />
        ) : (
          <ul className="surface divide-y divide-[var(--line)]">
            {home.followups.map((f: any) => (
              <li key={f.id}>
                <Link href={f.contact_id ? `/app/people/${f.contact_id}` : "/app/people"} className="flex items-center gap-3 px-4 py-3.5">
                  <span className="grid size-9 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-ember)_14%,transparent)] text-[var(--color-ember)]">
                    <Icon name="mail" size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{f.title}</span>
                    <span className="block text-[12.5px] text-[var(--fg-mute)]">
                      {f.due_at ? `${when(f.due_at)} 까지` : "기한 없음"} {f.source === "ai_suggested" && "· AI 제안 초안"}
                    </span>
                  </span>
                  <Icon name="arrow" size={16} className="opacity-40" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="animate-rise delay-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[20px] font-semibold">최근 만남</h2>
          <Link href="/app/people" className="text-[13px] text-[var(--fg-mute)]">인맥 전체</Link>
        </div>
        {home.recent.length === 0 ? (
          <Empty title="아직 만난 사람이 없어요" body="교환 버튼을 눌러 첫 명함을 주고받아 보세요." action={<Link href="/app/exchange" className="btn btn-signal">교환 시작</Link>} />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {home.recent.map((r: any, i: number) => (
              <li key={`${r.id}-${i}`}>
                <Link href={`/app/people/${r.id}`} className="surface flex items-center gap-3 p-3 transition hover:border-[var(--line-strong)]">
                  <Avatar name={r.full_name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">{r.full_name}</span>
                    <span className="block truncate text-[12.5px] text-[var(--fg-mute)]">{[r.company, r.job_title].filter(Boolean).join(" · ") || "—"}</span>
                  </span>
                  <span className="text-right text-[11.5px] text-[var(--fg-mute)]">
                    {when(r.occurred_at)}
                    <br />
                    {SRC[r.source] ?? r.source}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {home.meetings.length > 0 && (
        <section className="animate-rise delay-5">
          <h2 className="mb-3 text-[20px] font-semibold">다가오는 미팅</h2>
          <ul className="space-y-2">
            {home.meetings.map((m: any) => (
              <li key={m.id}>
                <Link href={`/app/meetings/${m.id}`} className="surface flex items-center justify-between p-4">
                  <span className="font-medium">{m.title}</span>
                  <span className="text-[13px] text-[var(--fg-mute)]">{when(m.next_meeting_at ?? m.started_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 모바일: 하단 Dock 밖의 모든 기능 (데스크톱은 사이드 메뉴) */}
      <section className="lg:hidden" data-reveal>
        <h2 className="mb-3 text-[20px] font-semibold">모든 기능</h2>
        <ul className="grid grid-cols-4 gap-2">
          {(
            [
              ["/app/scan", "scan", "명함 스캔"],
              ["/app/meetings", "calendar", "미팅"],
              ["/app/messages", "message", "메시지"],
              ["/app/calendar", "calendar", "일정"],
              ["/app/intros", "room", "소개·Room"],
              ["/app/events", "flag", "행사"],
              ["/app/team", "people", "팀 주소록"],
              ["/app/org", "building", "조직"],
              ["/app/inbox", "bell", "알림함"],
              ["/app/insights", "chart", "인사이트"],
              ["/app/integrations", "plug", "CRM·자동화"],
              ["/app/billing", "card", "플랜·결제"],
            ] as const
          ).map(([href, icon, label]) => (
            <li key={href}>
              <Link href={href} className="surface flex flex-col items-center gap-1.5 px-1 py-3 text-center text-[11.5px] font-medium">
                <span className="grid size-9 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent-text)]">
                  <Icon name={icon} size={18} />
                </span>
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
