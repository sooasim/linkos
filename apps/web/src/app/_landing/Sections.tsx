// Landing sections 06–08: 전체 기능 카탈로그 · 사용 방법 · 자주 묻는 질문.
// Server components only — native <details> accordions, no client JS (guest landing LCP budget, CLAUDE.md §5).
import Link from "next/link";
import { Fragment } from "react";
import { Icon } from "@/components/Icon";
import { FEATURE_GROUPS } from "./features";
import { FAQ, GUIDE, QUICK_START } from "./guide";

const TILE = ["bg-[var(--color-lavender)]", "bg-[var(--color-mint)]", "bg-[var(--color-peach)]", "bg-[var(--color-sky)]", "bg-[var(--color-butter)]", "bg-[var(--color-rose)]"];

const TAG_TONE: Record<string, string> = {
  "AI 추론": "chip-ai",
  "네이티브 앱": "!border-transparent !bg-[var(--color-lavender)] text-[var(--color-ink)]",
  "준비 중": "!border-transparent !bg-[var(--color-butter)] text-[var(--color-ink)]",
  실험: "!border-transparent !bg-[var(--color-butter)] text-[var(--color-ink)]",
};

/** Renders "[[라벨]]" as an inline UI-label token; everything else is plain text. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/\[\[(.+?)\]\]/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <span key={i} className="rounded-md bg-[var(--accent-soft)] px-1.5 py-px font-medium text-[var(--accent-text)] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">
            {p}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export function FeatureCatalog() {
  const itemCount = FEATURE_GROUPS.reduce((n, g) => n + g.items.length, 0);
  return (
    <section id="features" aria-labelledby="features-title" className="scroll-mt-6 border-t border-[var(--line)]">
      <div className="mx-auto max-w-7xl px-5 py-28 sm:px-8 sm:py-36">
        <div className="flex flex-wrap items-end justify-between gap-6" data-reveal>
          <div>
            <p className="eyebrow">06 — 전체 기능</p>
            <h2 id="features-title" className="display mt-4 text-[54px] sm:text-[80px]">
              필요한 모든 것, <em>한 곳에</em>.
            </h2>
          </div>
          <p className="max-w-md text-[16px] leading-relaxed text-[var(--fg-mute)]">
            명함 교환부터 미팅 · 팀 · 연동 · 개인정보까지. LINKOS가 하는 일을 {FEATURE_GROUPS.length}개 영역 · {itemCount}개 기능으로 빠짐없이 정리했습니다.
          </p>
        </div>

        <nav aria-label="기능 영역" className="mt-10 flex flex-wrap gap-2">
          {FEATURE_GROUPS.map((g) => (
            <a key={g.key} href={`#feat-${g.key}`} className="chip transition hover:border-[var(--accent)] hover:text-[var(--accent-text)]">
              {g.title}
            </a>
          ))}
        </nav>

        <div className="mt-12 gap-4 md:columns-2 xl:columns-3">
          {FEATURE_GROUPS.map((g, i) => (
            <article key={g.key} id={`feat-${g.key}`} data-feature-group={g.key} className="surface mb-4 scroll-mt-6 break-inside-avoid p-6">
              <div className="flex items-center gap-3">
                <span className={`grid size-11 shrink-0 place-items-center rounded-2xl text-[var(--color-iris)] ${TILE[i % TILE.length]}`}>
                  <Icon name={g.icon} size={21} />
                </span>
                <h3 className="text-[19px] font-semibold leading-snug">{g.title}</h3>
              </div>
              <p className="mt-3 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">{g.lead}</p>
              <ul className="mt-5 space-y-3.5 border-t border-[var(--line)] pt-5">
                {g.items.map((f) => (
                  <li key={f.t}>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-semibold">
                      {f.t}
                      {f.tag && <span className={`chip !px-2 !py-0.5 !text-[11px] ${TAG_TONE[f.tag] ?? ""}`}>{f.tag}</span>}
                    </p>
                    <p className="mt-1 text-[13.5px] leading-relaxed text-[var(--fg-mute)]">{f.d}</p>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function UsageGuide() {
  return (
    <section id="guide" aria-labelledby="guide-title" className="stage-aurora grain scroll-mt-6">
      <div className="mx-auto max-w-7xl px-5 py-28 sm:px-8 sm:py-36">
        <div className="flex flex-wrap items-end justify-between gap-6" data-reveal>
          <div>
            <p className="eyebrow">07 — 사용 방법</p>
            <h2 id="guide-title" className="display mt-4 text-[54px] sm:text-[80px]">
              처음부터 끝까지, <em>이렇게</em>.
            </h2>
          </div>
          <p className="max-w-md text-[16px] leading-relaxed text-[var(--fg-mute)]">
            화면 이름과 버튼 이름을 그대로 적었습니다. <span className="rounded-md bg-[var(--accent-soft)] px-1.5 py-px font-medium text-[var(--accent-text)]">보라색 글자</span>가 실제로 누르는 버튼과 메뉴입니다. 항목을 눌러 펼쳐 보세요.
          </p>
        </div>

        <h3 className="mt-14 text-[13px] font-semibold uppercase tracking-[0.2em] text-[var(--fg-mute)]">빠른 시작 · 4단계</h3>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK_START.map((s, i) => (
            <li key={s.n} data-reveal style={{ ["--reveal-delay" as string]: `${i * 90}ms` }} className={`rounded-[24px] border border-[var(--line)] p-6 text-[var(--color-ink)] ${TILE[i]}`}>
              <span className="display text-[48px] leading-none text-[var(--color-ink)]/30" aria-hidden>
                {s.n}
              </span>
              <p className="mt-4 text-[19px] font-semibold">
                <span className="sr-only">{s.n}단계. </span>
                {s.t}
              </p>
              <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--color-ink)]/75">
                {s.d.split(/\[\[(.+?)\]\]/g).map((p, j) => (j % 2 ? <b key={j} className="font-semibold text-[var(--color-ink)]">{p}</b> : <Fragment key={j}>{p}</Fragment>))}
              </p>
            </li>
          ))}
        </ol>

        <div className="mt-16 grid gap-10 lg:grid-cols-[250px_1fr]">
          <nav aria-label="사용 방법 목차" className="lg:sticky lg:top-6 lg:self-start">
            <ol className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
              {GUIDE.map((part, i) => (
                <li key={part.key}>
                  <a href={`#guide-part-${part.key}`} className="text-[14px] font-semibold hover:text-[var(--accent-text)]">
                    {i + 1}. {part.title}
                  </a>
                  <ul className="mt-2 space-y-1 border-l border-[var(--line-strong)] pl-3">
                    {part.topics.map((t) => (
                      <li key={t.id}>
                        <a href={`#${t.id}`} className="block py-0.5 text-[13.5px] text-[var(--fg-mute)] hover:text-[var(--accent-text)]">
                          {t.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </nav>

          <div className="min-w-0 space-y-14">
            {GUIDE.map((part, i) => (
              <div key={part.key} id={`guide-part-${part.key}`} className="scroll-mt-6">
                <h3 className="display text-[40px] sm:text-[52px]">
                  <span className="text-[var(--fg-mute)]">{String(i + 1).padStart(2, "0")} </span>
                  {part.title}
                </h3>
                <p className="mt-2 text-[15.5px] text-[var(--fg-mute)]">{part.lead}</p>
                <div className="mt-6 space-y-3">
                  {part.topics.map((t) => (
                    <details key={t.id} id={t.id} data-guide-topic={t.id} open={t.id === "guide-send" || t.id === "guide-receive"} className="group surface scroll-mt-6 overflow-hidden open:shadow-[var(--shadow-md)]">
                      <summary className="flex cursor-pointer list-none items-center gap-4 p-5 sm:p-6 [&::-webkit-details-marker]:hidden">
                        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-text)]">
                          <Icon name={t.icon} size={20} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[17px] font-semibold leading-snug sm:text-[18px]">{t.title}</span>
                          <span className="mt-0.5 block text-[13px] text-[var(--fg-mute)]">{t.where}</span>
                        </span>
                        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full border border-[var(--line-strong)] transition duration-300 group-open:rotate-45">
                          <Icon name="plus" size={16} />
                        </span>
                      </summary>
                      <div className="border-t border-[var(--line)] px-5 pb-6 pt-5 sm:px-6">
                        <ol className="space-y-3.5">
                          {t.steps.map((s, j) => (
                            <li key={j} className="grid grid-cols-[28px_1fr] gap-3 text-[15px] leading-relaxed">
                              <span className="num mt-0.5 grid size-7 place-items-center rounded-full bg-[var(--bg-sunk)] text-[12.5px] font-semibold text-[var(--fg-mute)]">{j + 1}</span>
                              <p className="min-w-0">
                                <Rich text={s} />
                              </p>
                            </li>
                          ))}
                        </ol>
                        {t.tips && (
                          <div className="mt-5 rounded-2xl bg-[var(--bg-sunk)] p-4">
                            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--fg-mute)]">알아두기</p>
                            <ul className="mt-2 space-y-1.5 text-[14px] leading-relaxed text-[var(--fg-mute)]">
                              {t.tips.map((tip, j) => (
                                <li key={j} className="flex gap-2">
                                  <span aria-hidden>·</span>
                                  <span className="min-w-0">
                                    <Rich text={tip} />
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {t.href && (
                          <Link href={t.href} prefetch={false} className="btn btn-ghost mt-5 !min-h-10 text-[14px]">
                            {t.title} 화면 열기 <Icon name="arrow" size={16} />
                          </Link>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-6 border-t border-[var(--line)] bg-[var(--bg-sunk)]">
      <div className="mx-auto grid max-w-7xl gap-10 px-5 py-28 sm:px-8 sm:py-36 lg:grid-cols-[1fr_1.4fr]">
        <div data-reveal>
          <p className="eyebrow">08 — FAQ</p>
          <h2 id="faq-title" className="display mt-4 text-[54px] sm:text-[80px]">
            자주 묻는 <em>질문</em>.
          </h2>
          <p className="mt-6 max-w-sm text-[16px] leading-relaxed text-[var(--fg-mute)]">처음 쓰는 분들이 가장 많이 궁금해하는 것들입니다. 자세한 단계는 위 사용 방법을 참고하세요.</p>
        </div>
        <div className="space-y-3">
          {FAQ.map((f) => (
            <details key={f.q} className="group surface overflow-hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 text-[16px] font-semibold [&::-webkit-details-marker]:hidden">
                {f.q}
                <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full border border-[var(--line-strong)] transition duration-300 group-open:rotate-45">
                  <Icon name="plus" size={15} />
                </span>
              </summary>
              <p className="border-t border-[var(--line)] px-5 pb-5 pt-4 text-[15px] leading-relaxed text-[var(--fg-mute)]">
                <Rich text={f.a} />
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
