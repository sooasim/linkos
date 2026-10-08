// UX-001 Home · F-063 첫 공유 유도(?welcome=1) · F-098 AI 추천(미접촉 위험, 주간 digest 재사용 — 추가 클라이언트 JS 없음)
import { analytics, assistantJobs, card, identity } from "@linkos/api";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { AiLabel, Avatar, Empty } from "@/components/Page";
import { CardFace } from "@/components/LivingCard";
import { type AppMessages, intlLocale, slot, tf } from "@/lib/i18n";
import { getMessages } from "@/lib/i18n.server";
import { getViewer } from "@/lib/server";

export const dynamic = "force-dynamic";

function whenFn(h: AppMessages["home"], lang: string) {
  return (d: Date | string | null) => {
    if (!d) return "";
    const t = new Date(d);
    const days = Math.floor((Date.now() - t.getTime()) / 864e5);
    if (days <= 0) return h.today;
    if (days === 1) return h.yesterday;
    if (days < 7) return tf(h.daysAgo, { n: days });
    return new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" }).format(t);
  };
}

// UX-001 Home — 오늘 행동과 관계 신호
export default async function HomePage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const sp = await searchParams;
  const { userId, ctx } = await getViewer();
  // F-177 ko/en
  const { locale, m } = await getMessages();
  const h = m.home;
  const lang = intlLocale(locale);
  const when = whenFn(h, lang);
  const me = await identity.getMe(userId!);
  const [home, digest] = await Promise.all([
    analytics.myHome(userId!),
    // cached once per week per user (reconnect_digests); never blocks Home if it fails
    assistantJobs.peekDigest(ctx).catch(() => null),
  ]);
  const profile = me.profile ? await card.loadProfile(me.profile.id) : null;
  const welcome = sp.welcome === "1";
  const picks = (digest?.items ?? []).slice(0, 3);
  const hour = new Date().getHours();
  const greet = hour < 12 ? h.morning : hour < 18 ? h.afternoon : h.evening;
  const name = profile?.name ?? me.user.display_name ?? "";

  return (
    <div className="space-y-8">
      <header className="animate-rise">
        <p className="eyebrow">{new Intl.DateTimeFormat(lang, { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</p>
        <h1 className="display mt-2 text-[48px] sm:text-[64px]">
          {greet}, <em>{name || h.hello}</em>
        </h1>
      </header>

      {welcome && (
        <section className="surface relative overflow-hidden !rounded-[28px] !bg-[var(--accent-soft)] p-6 animate-rise" aria-labelledby="welcome-title" data-testid="welcome-card">
          <Link href="/app" scroll={false} className="absolute right-3 top-3 grid size-10 place-items-center rounded-full text-[var(--fg-mute)] hover:bg-[color-mix(in_srgb,var(--fg)_8%,transparent)] hover:text-[var(--fg)]" aria-label={h.welcomeClose}>
            <Icon name="x" size={18} />
          </Link>
          <p className="eyebrow">{h.welcomeEyebrow}</p>
          <h2 id="welcome-title" className="display mt-2 pr-10 text-[30px] sm:text-[36px]">
            {slot(h.welcomeTitle)[0]}<em>{h.welcomeEm}</em>{slot(h.welcomeTitle)[1]}
          </h2>
          <p className="mt-2 text-[14.5px] text-[var(--fg-mute)]">{h.welcomeBody}</p>
          <Link href="/app/exchange" className="btn btn-signal mt-5 w-full sm:w-auto" data-testid="welcome-share">
            <Icon name="exchange" size={18} /> {h.welcomeCta}
          </Link>
        </section>
      )}

      {!profile ? (
        <section className="stage-ink grain overflow-hidden rounded-[28px] p-6 animate-rise delay-1">
          <p className="eyebrow">Step 1</p>
          <h2 className="display mt-2 text-[36px]">
            {slot(h.step1Title)[0]}<em className="text-[var(--color-signal)]">Living Card</em>{slot(h.step1Title)[1]}
          </h2>
          <p className="mt-2 text-[15px] text-[var(--fg-mute)]">{h.step1Body}</p>
          <Link href="/app/me/edit?onboarding=1" className="btn btn-signal mt-5">
            {h.makeCard} <Icon name="arrow" size={18} />
          </Link>
        </section>
      ) : (
        <section className="grid gap-4 sm:grid-cols-[1.2fr_1fr] animate-rise delay-1">
          <Link href="/app/exchange" className="block transition hover:-translate-y-0.5" aria-label={h.exchangeWithCard}>
            <CardFace card={card.projectCard(profile, "owner")} size="sm" interactive={false} />
          </Link>
          <div className="grid grid-cols-2 gap-3">
            {[
              [h.statPeople, home.counts.contacts, "/app/people"],
              [h.statWeek, home.counts.encounters_7d, "/app/people"],
              [h.statFollowups, home.counts.open_followups, "#followups"],
              [h.statExchanges, home.counts.exchanges, "/app/insights"],
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
            ["/app/exchange", "exchange", h.share, true],
            ["/app/scan", "scan", h.scan, false],
            ["/c", "code", h.byCode, false],
            ["/app/exchange?group=1", "people", h.group, false],
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
          <h2 className="text-[20px] font-semibold">{h.followupsTitle}</h2>
          <Link href="/app/people" className="text-[13px] text-[var(--fg-mute)]">{h.seeAll}</Link>
        </div>
        {home.followups.length === 0 ? (
          <Empty title={h.noFollowups} body={h.noFollowupsBody} />
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
                      {f.due_at ? tf(h.until, { when: when(f.due_at) }) : h.noDue} {f.source === "ai_suggested" && h.aiDraft}
                    </span>
                  </span>
                  <Icon name="arrow" size={16} className="opacity-40" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="animate-rise delay-3" aria-labelledby="ai-picks-title" data-testid="home-ai">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="ai-picks-title" className="flex items-center gap-2 text-[20px] font-semibold">
            {h.aiPicks} <AiLabel>{m.common.aiInferred}</AiLabel>
          </h2>
          <Link href="/app/ai" className="text-[13px] text-[var(--fg-mute)]">{m.nav.aiHub}</Link>
        </div>
        {picks.length === 0 ? (
          <Empty title={h.aiNone} body={h.aiNoneBody} action={<Link href="/app/ai" className="btn btn-ghost">{h.aiSeeMatches}</Link>} />
        ) : (
          <>
            <ul className="surface divide-y divide-[var(--line)]">
              {picks.map((p) => (
                <li key={p.contactId}>
                  <Link href={`/app/people/${p.contactId}`} className="flex items-center gap-3 px-4 py-3.5">
                    <Avatar name={p.fullName} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium">{p.fullName}</span>
                      <span className="block truncate text-[12.5px] text-[var(--fg-mute)]">{[p.company, tf(h.daysSilent, { n: p.daysSilent }), p.reasons?.[0]].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className={`chip shrink-0 ${p.level === "high" ? "!bg-[var(--color-peach)]" : "!bg-[var(--color-butter)]"} !text-[var(--color-ink)]`}>{p.level === "high" ? h.drifting : h.check}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]">
              {slot(h.aiNote, "link")[0]}<Link href="/app/reconnect" className="underline">{h.aiNoteLink}</Link>{slot(h.aiNote, "link")[1]}
            </p>
          </>
        )}
      </section>

      <section className="animate-rise delay-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[20px] font-semibold">{h.recentTitle}</h2>
          <Link href="/app/people" className="text-[13px] text-[var(--fg-mute)]">{h.allPeople}</Link>
        </div>
        {home.recent.length === 0 ? (
          <Empty title={h.noRecent} body={h.noRecentBody} action={<Link href="/app/exchange" className="btn btn-signal">{m.common.startExchange}</Link>} />
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
                    {h.src[r.source] ?? r.source}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {home.meetings.length > 0 && (
        <section className="animate-rise delay-5">
          <h2 className="mb-3 text-[20px] font-semibold">{h.meetingsTitle}</h2>
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
        <h2 className="mb-3 text-[20px] font-semibold">{h.allFeatures}</h2>
        <ul className="grid grid-cols-4 gap-2">
          {(
            [
              ["/app/scan", "scan", m.nav.scan],
              ["/app/meetings", "calendar", m.nav.meetings],
              ["/app/messages", "message", m.nav.messages],
              ["/app/calendar", "calendar", m.nav.calendar],
              ["/app/intros", "room", m.nav.intros],
              ["/app/events", "flag", m.nav.events],
              ["/app/team", "people", m.nav.team],
              ["/app/org", "building", m.nav.org],
              ["/app/inbox", "bell", m.nav.inbox],
              ["/app/insights", "chart", m.nav.insights],
              ["/app/integrations", "plug", m.nav.integrations],
              ["/app/billing", "card", m.nav.billing],
              ["/app/settings", "settings", m.nav.settings],
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
