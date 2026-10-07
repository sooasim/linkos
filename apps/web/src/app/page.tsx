import Link from "next/link";
import { Icon, Logo } from "@/components/Icon";
import { CardFace } from "@/components/LivingCard";

const FLOW = ["Meet", "Exchange", "Remember", "Understand", "Act", "Sync", "Grow"];

const LADDER = [
  { n: "01", t: "앱 ↔ 앱 근접 교환", d: "양쪽 모두 앱이 있으면 foreground BLE로 주변을 찾고, 두 사람 모두 승인해야 연결됩니다.", tag: "Native app" },
  { n: "02", t: "OS 공유 시트", d: "AirDrop · Quick Share · 메시지 — 기기가 지원하는 방식으로 일회성 HTTPS 링크를 보냅니다.", tag: "가장 현실적인 비회원 경로" },
  { n: "03", t: "NFC 카드 · 스티커", d: "카드를 상대 폰에 대면 브라우저가 바로 열립니다. 상대에게 앱은 필요 없어요.", tag: "물리 액세서리" },
  { n: "04", t: "단축코드", d: "lk.to + 6자리. 어떤 브라우저에서도 즉시 받을 수 있습니다.", tag: "Universal" },
  { n: "05", t: "QR", d: "앞의 방법이 실패하거나 시간이 지나면 자동으로 나타나는 최종 폴백.", tag: "Final fallback" },
];

const BENTO = [
  { t: "Relationship Memory", d: "“작년 코엑스에서 만난 의료 AI 대표” — 만남·메모·미팅을 근거와 함께 찾아냅니다.", icon: "spark", span: "sm:col-span-2" },
  { t: "Need ↔ Offer", d: "내가 줄 수 있는 것과 지금 필요한 것을 구조화해 설명 가능한 매칭으로.", icon: "link", span: "" },
  { t: "Meeting Card", d: "목적·결정·약속·To-do·다음 일정. 녹음은 동의 기록 없이는 시작되지 않습니다.", icon: "calendar", span: "" },
  { t: "4단계 공개범위", d: "Public · Business · Trusted · Partner. 숨긴 항목은 요청과 승인으로만 열립니다.", icon: "lock", span: "" },
  { t: "Google · Excel · vCard", d: "중복 없는 idempotent 동기화와 필드 선택 내보내기.", icon: "download", span: "" },
  { t: "Event Networking", d: "참가자 opt-in 기반 추천. “오늘 만나볼 사람”을 공유한 데이터로만 계산합니다.", icon: "flag", span: "sm:col-span-3" },
] as const;

const TILE = ["bg-[var(--color-lavender)]", "bg-[var(--color-mint)]", "bg-[var(--color-peach)]", "bg-[var(--color-sky)]", "bg-[var(--color-butter)]", "bg-[var(--color-rose)]"];

const CHIP = ["!bg-[var(--color-lavender)]", "!bg-[var(--color-mint)]", "!bg-[var(--color-peach)]", "!bg-[var(--color-sky)]", "!bg-[var(--color-butter)]", "!bg-[var(--color-rose)]"];

function Words({ text, delay = 0 }: { text: string; delay?: number }) {
  return (
    <span className="words">
      {text.split(" ").map((w, i) => (
        <span key={i} style={{ animationDelay: `${delay + i * 70}ms` }}>
          {w}&nbsp;
        </span>
      ))}
    </span>
  );
}

export default function Landing() {
  return (
    <div className="overflow-x-clip">
      <div className="scroll-progress" aria-hidden />
      <div className="spotlight hidden lg:block" aria-hidden />

      {/* ── Hero ─────────────────────────────────────── */}
      <section className="stage-aurora grain relative min-h-dvh">
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-[42%] size-[880px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--line)] [animation:spin-slow_120s_linear_infinite]">
          <span className="absolute -top-1.5 left-1/2 size-3 rounded-full bg-[var(--color-iris-2)] shadow-[0_0_24px_6px_rgba(143,123,255,.45)]" />
        </div>
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-[42%] size-[620px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-[var(--line)] [animation:spin-slow_90s_linear_infinite_reverse]" />

        <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
          <Logo />
          <nav className="flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--glass)] p-1 backdrop-blur-xl sm:gap-1">
            <a href="#how" className="hidden rounded-full px-4 py-2 text-[14px] text-[var(--fg-mute)] transition hover:bg-[var(--bg-sunk)] hover:text-[var(--fg)] sm:inline">작동 방식</a>
            <a href="#ladder" className="hidden rounded-full px-4 py-2 text-[14px] text-[var(--fg-mute)] transition hover:bg-[var(--bg-sunk)] hover:text-[var(--fg)] sm:inline">교환 기술</a>
            <a href="#trust" className="hidden rounded-full px-4 py-2 text-[14px] text-[var(--fg-mute)] transition hover:bg-[var(--bg-sunk)] hover:text-[var(--fg)] sm:inline">보안</a>
            <Link href="/login" className="btn btn-ink !min-h-10 text-[14px]">로그인</Link>
          </nav>
        </header>

        <div className="relative z-10 mx-auto grid max-w-7xl items-center gap-12 px-5 pb-20 pt-8 sm:px-8 lg:grid-cols-[1.25fr_1fr] lg:pt-14">
          <div>
            <p className="chip animate-rise !bg-[var(--glass)] backdrop-blur">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-pulse-ring rounded-full bg-[var(--color-iris-2)]" />
                <span className="relative inline-flex size-2 rounded-full bg-[var(--color-iris)]" />
              </span>
              Business Identity & Relationship OS
            </p>
            <h1 className="display mt-6 text-[18vw] sm:text-[116px] lg:text-[140px]">
              <span className="block"><Words text="Meet." delay={60} /></span>
              <span className="block"><Words text="Exchange." delay={180} /></span>
              <span className="block">
                <span className="words"><em style={{ animationDelay: "320ms" }}>Remember.</em></span>
              </span>
            </h1>
            <p className="mt-8 max-w-xl text-[18px] leading-relaxed text-[var(--fg-mute)] animate-rise delay-4">
              LINKOS는 명함을 저장하는 앱이 아닙니다. 사람을 만나는 순간부터 관계를 기억하고, 다음 행동과 사업 기회까지 연결합니다.
              <span className="text-[var(--fg)]"> 상대는 가입하지 않아도 됩니다.</span>
            </p>
            <div className="mt-10 flex flex-wrap gap-3 animate-rise delay-5">
              <Link href="/login" className="btn btn-signal btn-lg">
                무료로 시작하기 <Icon name="arrow" size={18} />
              </Link>
              <Link href="/c" className="btn btn-ghost btn-lg">코드로 명함 받기</Link>
            </div>
            <div className="mt-10 flex items-center gap-4 text-[13px] text-[var(--fg-mute)] animate-fade delay-5">
              <div className="flex -space-x-2">
                {["#d9d2ff", "#cdeedf", "#ffd9c9", "#d3e5ff"].map((c) => (
                  <span key={c} className="size-8 rounded-full border-2 border-[var(--bg-elev)]" style={{ background: c }} />
                ))}
              </div>
              가입 없는 교환 · 기기 내 OCR · 승인 기반 자동화
            </div>
          </div>

          <div className="relative mx-auto aspect-square w-full max-w-[470px] [perspective:1200px]" aria-hidden>
            <div className="absolute left-[4%] top-[2%] w-[78%] -rotate-[9deg] [animation:float_9s_ease-in-out_infinite]">
              <div data-tilt className="rounded-[28px] transition-transform duration-500">
                <CardFace size="sm" interactive={false} card={{ name: "Mina Seo", company: "Northwind Ventures", jobTitle: "Partner", theme: "ember" }} />
              </div>
            </div>
            <div className="absolute right-[0%] top-[30%] w-[78%] rotate-[7deg] [animation:float_11s_ease-in-out_infinite_reverse]">
              <div data-tilt className="rounded-[28px] transition-transform duration-500">
                <CardFace size="sm" interactive={false} card={{ name: "Jun Park", company: "Signal Labs", jobTitle: "Founder · CEO", theme: "signal" }} />
              </div>
            </div>
            <div className="absolute bottom-[0%] left-[8%] w-[80%] -rotate-[3deg] [animation:float_10s_ease-in-out_infinite]">
              <div data-tilt className="glow-border rounded-[28px] transition-transform duration-500">
                <CardFace size="sm" interactive={false} card={{ name: "홍길동", company: "링코스랩", jobTitle: "대표", theme: "paper", keywords: ["의료AI", "B2B"] }} />
              </div>
            </div>
            <span className="chip chip-ai absolute -left-2 top-[46%] shadow-lg [animation:float_7s_ease-in-out_infinite]">Need ↔ Offer 매칭 92%</span>
            <span className="chip absolute -right-1 bottom-[18%] !bg-[var(--bg-elev)] shadow-lg [animation:float_8s_ease-in-out_infinite_reverse]">✓ 교환 완료 · 0.8초</span>
          </div>
        </div>

        <div className="relative z-10 border-y border-[var(--line)] bg-[var(--glass)] py-5 backdrop-blur" aria-hidden>
          <div className="flex w-max animate-marquee whitespace-nowrap">
            {[0, 1].map((k) => (
              <div key={k} className="flex items-center">
                {FLOW.map((w, i) => (
                  <span key={`${k}-${w}`} className="display flex items-center px-6 text-[52px] sm:text-[68px]">
                    <span className={i % 2 ? "italic text-[var(--accent-text)]" : "text-transparent [-webkit-text-stroke:1px_rgba(91,75,214,.45)]"}>{w}</span>
                    <span className="ml-12 text-[24px] text-[var(--color-iris-2)]">✦</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 01 Guest viral loop ──────────────────────── */}
      <section id="how" className="mx-auto max-w-7xl px-5 py-28 sm:px-8 sm:py-36">
        <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <div data-reveal>
            <p className="eyebrow">01 — Guest Exchange</p>
            <h2 className="display mt-4 text-[60px] sm:text-[88px]">
              가입보다 <em>교환</em>이 먼저.
            </h2>
            <p className="mt-6 max-w-md text-[17px] leading-relaxed text-[var(--fg-mute)]">
              받는 사람은 링크를 여는 즉시 3초 카드를 봅니다. “내 명함도 보내기”를 누르고 종이 명함을 찍으면 10초 만에 상호 교환이 끝나요. 계정은 그 다음, 원할 때.
            </p>
          </div>
          <ol className="grid gap-4 sm:grid-cols-3">
            {[
              ["받기", "로그인 없이 상대의 Living Card가 바로 열립니다.", "eye"],
              ["찍기", "종이 명함을 촬영하면 기기 안에서 글자를 읽고, 신뢰도가 낮은 항목만 확인합니다.", "camera"],
              ["보내기", "보낼 항목을 직접 고르고 동의하면 양쪽 관계가 동시에 생깁니다.", "exchange"],
            ].map(([t, d, icon], i) => (
              <li key={t} data-reveal style={{ ["--reveal-delay" as string]: `${i * 120}ms` }} className={`group relative flex flex-col justify-between gap-12 overflow-hidden rounded-[28px] border border-[var(--line)] p-6 transition duration-500 hover:-translate-y-1.5 hover:shadow-[var(--shadow-md)] ${TILE[i]}`}>
                <div className="flex items-center justify-between">
                  <span className="display text-[72px] leading-none text-[var(--color-ink)]/15">{i + 1}</span>
                  <span className="grid size-12 place-items-center rounded-2xl bg-white/80 text-[var(--color-iris)] shadow-sm transition duration-500 group-hover:rotate-[-8deg] group-hover:scale-110">
                    <Icon name={icon as "eye"} size={20} />
                  </span>
                </div>
                <div className="text-[var(--color-ink)]">
                  <h3 className="text-[22px] font-semibold">{t}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-[var(--color-ink)]/65">{d}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── 02 Adaptive handoff ladder ───────────────── */}
      <section id="ladder" className="stage-aurora grain">
        <div className="mx-auto max-w-7xl px-5 py-28 sm:px-8 sm:py-36">
          <div className="flex flex-wrap items-end justify-between gap-6" data-reveal>
            <div>
              <p className="eyebrow">02 — Adaptive Handoff</p>
              <h2 className="display mt-4 text-[60px] sm:text-[88px]">
                QR은 <em>마지막에</em>.
              </h2>
            </div>
            <p className="max-w-md text-[16px] leading-relaxed text-[var(--fg-mute)]">
              공유 버튼은 하나. 기기 능력과 상대 상태에 따라 가능한 채널을 차례로 시도하고, 실패·취소·시간초과를 감지하면 다음 단계로 넘어갑니다. 브라우저끼리 폰을 맞대 전송한다는 과장은 하지 않습니다.
            </p>
          </div>
          <ol className="mt-16 grid gap-3">
            {LADDER.map((s, i) => (
              <li key={s.n} data-reveal style={{ ["--reveal-delay" as string]: `${i * 90}ms` }} className="group grid items-center gap-4 rounded-[24px] border border-[var(--line)] bg-[var(--glass)] px-6 py-6 backdrop-blur-xl transition duration-500 hover:translate-x-1 hover:border-[var(--line-strong)] hover:bg-[var(--bg-elev)] hover:shadow-[var(--shadow-md)] sm:grid-cols-[110px_1fr_1.2fr_auto]">
                <span className="display text-[52px] leading-none text-[var(--fg-mute)]/50 transition duration-500 group-hover:text-[var(--accent-text)]">{s.n}</span>
                <h3 className="text-[22px] font-semibold">{s.t}</h3>
                <p className="text-[15.5px] leading-relaxed text-[var(--fg-mute)]">{s.d}</p>
                <span className={`chip justify-self-start ${s.n === "05" ? "!border-[var(--color-ember)]/40 !bg-[var(--color-peach)] text-[#a2402a]" : s.n === "01" ? "chip-ai" : ""}`}>{s.tag}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── 03 Living Card ───────────────────────────── */}
      <section className="mx-auto max-w-7xl px-5 py-28 sm:px-8 sm:py-36">
        <div className="grid items-center gap-16 lg:grid-cols-2">
          <div className="relative mx-auto w-full max-w-md" data-reveal>
            <div aria-hidden className="absolute -inset-10 -z-10 rounded-full bg-[radial-gradient(closest-side,var(--aurora-1),transparent)] blur-2xl" />
            <div data-tilt className="rounded-[28px] transition-transform duration-500">
              <CardFace card={{ name: "Jun Park", company: "Signal Labs", jobTitle: "Founder · CEO", headline: "에너지 데이터 인프라", keywords: ["ClimateTech", "B2B SaaS", "Seed"], theme: "ink" }} />
            </div>
            <div className="surface absolute -bottom-10 -right-4 w-[72%] rotate-2 p-4 !shadow-[var(--shadow-md)] sm:-right-10 [animation:float_8s_ease-in-out_infinite]">
              <p className="eyebrow">30초 카드</p>
              <p className="mt-2 rounded-xl bg-[var(--color-mint)] px-3 py-2 text-[14px] font-medium text-[var(--color-ink)]">Offer · 전력 사용량 실시간 분석 API</p>
              <p className="mt-2 rounded-xl bg-[var(--color-peach)] px-3 py-2 text-[14px] font-medium text-[var(--color-ink)]">Need · 제조사 파일럿 고객</p>
            </div>
          </div>
          <div data-reveal>
            <p className="eyebrow">03 — Living Card</p>
            <h2 className="display mt-4 text-[60px] sm:text-[88px]">
              살아있는 <em>명함</em>.
            </h2>
            <p className="mt-6 max-w-md text-[17px] leading-relaxed text-[var(--fg-mute)]">
              3초에 누구인지, 30초에 무엇을 주고받을 수 있는지, 딥 프로필에서 신뢰할 근거까지. 직책이 바뀌면 연결된 사람들에게 갱신이 전달됩니다.
            </p>
            <div className="mt-8 flex flex-wrap gap-2">
              {["3초 카드", "30초 카드", "딥 프로필", "상대별 변형", "Access Request", "Action CTA"].map((x, i) => (
                <span key={x} className={`chip !border-transparent ${CHIP[i]} text-[var(--color-ink)]`}>{x}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── 04 Bento ─────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-5 pb-28 sm:px-8 sm:pb-36">
        <div data-reveal>
          <p className="eyebrow">04 — Relationship OS</p>
          <h2 className="display mt-4 max-w-3xl text-[54px] sm:text-[80px]">
            기억하고, 이해하고, <em>행동</em>하게.
          </h2>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {BENTO.map((b, i) => (
            <article
              key={b.t}
              data-reveal
              style={{ ["--reveal-delay" as string]: `${(i % 3) * 100}ms` }}
              className={`group relative overflow-hidden rounded-[28px] border border-[var(--line)] p-7 text-[var(--color-ink)] transition duration-500 hover:-translate-y-1.5 hover:shadow-[var(--shadow-md)] ${b.span} ${TILE[i]}`}
            >
              <div aria-hidden className="absolute -right-16 -top-16 size-48 rounded-full bg-white/50 blur-2xl transition duration-700 group-hover:scale-150" />
              <span className="relative grid size-12 place-items-center rounded-2xl bg-white/80 text-[var(--color-iris)] shadow-sm">
                <Icon name={b.icon} size={24} />
              </span>
              <h3 className="display relative mt-14 text-[38px] leading-none">{b.t}</h3>
              <p className="relative mt-3 max-w-md text-[15px] leading-relaxed text-[var(--color-ink)]/65">{b.d}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── 05 Trust ─────────────────────────────────── */}
      <section id="trust" className="border-t border-[var(--line)] bg-[var(--bg-sunk)]">
        <div className="mx-auto grid max-w-7xl gap-10 px-5 py-28 sm:px-8 sm:py-36 lg:grid-cols-[1fr_1.2fr]">
          <div data-reveal>
            <p className="eyebrow">05 — Privacy by design</p>
            <h2 className="display mt-4 text-[54px] sm:text-[80px]">
              신뢰는 <em>기본값</em>.
            </h2>
          </div>
          <dl className="grid grid-cols-2 gap-4">
            {[
              ["192-bit", "교환 토큰 엔트로피. 서버에는 해시만 저장하고 개인정보는 담지 않습니다."],
              ["0", "로그·분석 이벤트에 남는 전화번호·이메일 원문."],
              ["4", "필드별 공개범위. 개인 메모는 상대에게 절대 노출되지 않습니다."],
              ["7일", "계정 삭제 유예 후 영구 삭제. 내 데이터는 언제든 JSON으로."],
            ].map(([k, v], i) => (
              <div key={k} data-reveal style={{ ["--reveal-delay" as string]: `${i * 100}ms` }} className="surface p-6">
                <dt className="display num bg-gradient-to-br from-[var(--color-iris)] to-[#f08fb4] bg-clip-text text-[60px] leading-none text-transparent">{k}</dt>
                <dd className="mt-3 text-[15px] leading-relaxed text-[var(--fg-mute)]">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────── */}
      <footer className="stage-aurora grain overflow-hidden">
        <div className="mx-auto max-w-7xl px-5 pt-28 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-8" data-reveal>
            <h2 className="display max-w-2xl text-[54px] sm:text-[80px]">
              다음 만남부터, <em>기억</em>되게.
            </h2>
            <Link href="/login" className="btn btn-signal btn-lg" data-confetti>
              지금 시작하기 <Icon name="arrow" size={18} />
            </Link>
          </div>
          <div className="mt-20 flex flex-wrap gap-6 border-t border-[var(--line)] py-6 text-[13px] text-[var(--fg-mute)]">
            <span>© {new Date().getFullYear()} LINKOS</span>
            <Link href="/legal/terms" className="hover:text-[var(--fg)]">이용약관</Link>
            <Link href="/legal/privacy" className="hover:text-[var(--fg)]">개인정보 처리방침</Link>
            <Link href="/c" className="hover:text-[var(--fg)]">코드로 받기</Link>
          </div>
        </div>
        <p aria-hidden className="display -mb-[0.18em] select-none bg-gradient-to-b from-[rgba(108,92,231,.22)] to-transparent bg-clip-text text-center text-[27vw] leading-[0.8] text-transparent">
          LINKOS
        </p>
      </footer>
    </div>
  );
}
