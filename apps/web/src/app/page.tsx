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
  { t: "Event Networking", d: "참가자 opt-in 기반 추천. “오늘 만나볼 사람”을 공유한 데이터로만 계산합니다.", icon: "flag", span: "sm:col-span-2" },
] as const;

export default function Landing() {
  return (
    <div className="overflow-x-clip">
      {/* ── Hero ─────────────────────────────────────── */}
      <section className="stage-ink grain relative min-h-dvh">
        <div aria-hidden className="pointer-events-none absolute -right-40 top-20 size-[620px] rounded-full bg-[var(--color-signal)] opacity-[0.08] blur-[120px]" />
        <div aria-hidden className="pointer-events-none absolute -left-40 bottom-0 size-[520px] rounded-full bg-[var(--color-ember)] opacity-[0.07] blur-[120px]" />
        <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
          <Logo />
          <nav className="flex items-center gap-1 sm:gap-6">
            <a href="#how" className="hidden text-[14px] text-[var(--fg-mute)] hover:text-[var(--fg)] sm:inline">작동 방식</a>
            <a href="#ladder" className="hidden text-[14px] text-[var(--fg-mute)] hover:text-[var(--fg)] sm:inline">교환 기술</a>
            <a href="#trust" className="hidden text-[14px] text-[var(--fg-mute)] hover:text-[var(--fg)] sm:inline">보안</a>
            <Link href="/login" className="btn btn-ghost !min-h-10 text-[14px]">로그인</Link>
          </nav>
        </header>

        <div className="relative z-10 mx-auto grid max-w-7xl items-center gap-12 px-5 pb-20 pt-10 sm:px-8 lg:grid-cols-[1.25fr_1fr] lg:pt-16">
          <div>
            <p className="eyebrow animate-rise">Business Identity & Relationship OS</p>
            <h1 className="display mt-5 text-[19vw] sm:text-[120px] lg:text-[148px]">
              <span className="block animate-rise delay-1">Meet.</span>
              <span className="block animate-rise delay-2">Exchange.</span>
              <span className="block animate-rise delay-3">
                <em className="text-[var(--color-signal)]">Remember.</em>
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
          </div>

          <div className="relative mx-auto aspect-square w-full max-w-[460px]" aria-hidden>
            <div className="absolute left-[6%] top-[4%] w-[78%] -rotate-[9deg] opacity-90 [animation:float_9s_ease-in-out_infinite]">
              <CardFace size="sm" interactive={false} card={{ name: "Mina Seo", company: "Northwind Ventures", jobTitle: "Partner", theme: "paper" }} />
            </div>
            <div className="absolute right-[2%] top-[30%] w-[78%] rotate-[7deg] [animation:float_11s_ease-in-out_infinite_reverse]">
              <CardFace size="sm" interactive={false} card={{ name: "Jun Park", company: "Signal Labs", jobTitle: "Founder · CEO", theme: "signal" }} />
            </div>
            <div className="absolute bottom-[2%] left-[10%] w-[80%] -rotate-[3deg] [animation:float_10s_ease-in-out_infinite]">
              <CardFace size="sm" interactive={false} card={{ name: "홍길동", company: "링코스랩", jobTitle: "대표", theme: "ink", keywords: ["의료AI", "B2B"] }} />
            </div>
          </div>
        </div>

        <div className="relative z-10 border-y border-[var(--line)] py-5" aria-hidden>
          <div className="flex w-max animate-marquee whitespace-nowrap">
            {[0, 1].map((k) => (
              <div key={k} className="flex items-center">
                {FLOW.map((w, i) => (
                  <span key={`${k}-${w}`} className="display flex items-center px-6 text-[56px] sm:text-[72px]">
                    <span className={i % 2 ? "italic text-[var(--color-signal)]" : "text-transparent [-webkit-text-stroke:1px_rgba(241,238,231,.55)]"}>{w}</span>
                    <span className="ml-12 text-[28px] text-[var(--fg-mute)]">→</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 01 Guest viral loop ──────────────────────── */}
      <section id="how" className="mx-auto max-w-7xl px-5 py-28 sm:px-8">
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <p className="eyebrow">01 — Guest Exchange</p>
            <h2 className="display mt-4 text-[64px] sm:text-[88px]">
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
              <li key={t} className="surface flex flex-col justify-between gap-12 p-6">
                <div className="flex items-center justify-between">
                  <span className="display text-[64px] leading-none text-[var(--fg-mute)]/40">{i + 1}</span>
                  <span className="grid size-11 place-items-center rounded-full bg-[var(--color-signal)] text-[var(--color-ink)]">
                    <Icon name={icon as "eye"} size={20} />
                  </span>
                </div>
                <div>
                  <h3 className="text-[22px] font-semibold">{t}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-[var(--fg-mute)]">{d}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── 02 Adaptive handoff ladder ───────────────── */}
      <section id="ladder" className="stage-ink grain">
        <div className="mx-auto max-w-7xl px-5 py-28 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <p className="eyebrow">02 — Adaptive Handoff</p>
              <h2 className="display mt-4 text-[64px] sm:text-[88px]">
                QR은 <em className="text-[var(--color-ember)]">마지막에</em>.
              </h2>
            </div>
            <p className="max-w-md text-[16px] leading-relaxed text-[var(--fg-mute)]">
              공유 버튼은 하나. 기기 능력과 상대 상태에 따라 가능한 채널을 차례로 시도하고, 실패·취소·시간초과를 감지하면 다음 단계로 넘어갑니다. 브라우저끼리 폰을 맞대 전송한다는 과장은 하지 않습니다.
            </p>
          </div>
          <ol className="mt-16 divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {LADDER.map((s) => (
              <li key={s.n} className="group grid items-baseline gap-4 py-7 transition sm:grid-cols-[120px_1fr_1.2fr_auto]">
                <span className="display text-[56px] leading-none text-[var(--fg-mute)] transition group-hover:text-[var(--color-signal)]">{s.n}</span>
                <h3 className="text-[24px] font-semibold">{s.t}</h3>
                <p className="text-[15.5px] leading-relaxed text-[var(--fg-mute)]">{s.d}</p>
                <span className={`chip justify-self-start ${s.n === "05" ? "!border-[var(--color-ember)] text-[var(--color-ember)]" : ""}`}>{s.tag}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── 03 Living Card ───────────────────────────── */}
      <section className="mx-auto max-w-7xl px-5 py-28 sm:px-8">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <div className="relative mx-auto w-full max-w-md">
            <CardFace card={{ name: "Jun Park", company: "Signal Labs", jobTitle: "Founder · CEO", headline: "에너지 데이터 인프라", keywords: ["ClimateTech", "B2B SaaS", "Seed"], theme: "ink" }} />
            <div className="surface absolute -bottom-10 -right-4 w-[72%] rotate-2 p-4 shadow-2xl sm:-right-10">
              <p className="eyebrow">30초 카드</p>
              <p className="mt-2 rounded-xl bg-[var(--color-signal)] px-3 py-2 text-[14px] font-medium text-[var(--color-ink)]">Offer · 전력 사용량 실시간 분석 API</p>
              <p className="mt-2 rounded-xl border border-[var(--line-strong)] px-3 py-2 text-[14px] font-medium">Need · 제조사 파일럿 고객</p>
            </div>
          </div>
          <div>
            <p className="eyebrow">03 — Living Card</p>
            <h2 className="display mt-4 text-[64px] sm:text-[88px]">
              살아있는 <em>명함</em>.
            </h2>
            <p className="mt-6 max-w-md text-[17px] leading-relaxed text-[var(--fg-mute)]">
              3초에 누구인지, 30초에 무엇을 주고받을 수 있는지, 딥 프로필에서 신뢰할 근거까지. 직책이 바뀌면 연결된 사람들에게 갱신이 전달됩니다.
            </p>
            <div className="mt-8 flex flex-wrap gap-2">
              {["3초 카드", "30초 카드", "딥 프로필", "상대별 변형", "Access Request", "Action CTA"].map((x) => (
                <span key={x} className="chip">{x}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── 04 Bento ─────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-5 pb-28 sm:px-8">
        <p className="eyebrow">04 — Relationship OS</p>
        <h2 className="display mt-4 max-w-3xl text-[56px] sm:text-[80px]">
          기억하고, 이해하고, <em>행동</em>하게.
        </h2>
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {BENTO.map((b, i) => (
            <article key={b.t} className={`group relative overflow-hidden rounded-[28px] p-7 ${b.span} ${i === 0 ? "bg-[var(--color-signal)] text-[var(--color-ink)]" : i === 5 ? "stage-ink grain" : "surface"}`}>
              <Icon name={b.icon} size={28} />
              <h3 className="display mt-16 text-[40px] leading-none">{b.t}</h3>
              <p className={`mt-3 max-w-md text-[15px] leading-relaxed ${i === 0 ? "text-[var(--color-ink)]/75" : "text-[var(--fg-mute)]"}`}>{b.d}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── 05 Trust ─────────────────────────────────── */}
      <section id="trust" className="border-t border-[var(--line)]">
        <div className="mx-auto grid max-w-7xl gap-10 px-5 py-28 sm:px-8 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <p className="eyebrow">05 — Privacy by design</p>
            <h2 className="display mt-4 text-[56px] sm:text-[80px]">
              신뢰는 <em>기본값</em>.
            </h2>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-10">
            {[
              ["192-bit", "교환 토큰 엔트로피. 서버에는 해시만 저장하고 개인정보는 담지 않습니다."],
              ["0", "로그·분석 이벤트에 남는 전화번호·이메일 원문."],
              ["4", "필드별 공개범위. 개인 메모는 상대에게 절대 노출되지 않습니다."],
              ["7일", "계정 삭제 유예 후 영구 삭제. 내 데이터는 언제든 JSON으로."],
            ].map(([k, v]) => (
              <div key={k} className="border-t border-[var(--line-strong)] pt-5">
                <dt className="display num text-[64px] leading-none">{k}</dt>
                <dd className="mt-3 text-[15px] leading-relaxed text-[var(--fg-mute)]">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────── */}
      <footer className="stage-ink grain overflow-hidden">
        <div className="mx-auto max-w-7xl px-5 pt-24 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-8">
            <h2 className="display max-w-2xl text-[56px] sm:text-[80px]">
              다음 만남부터, <em className="text-[var(--color-signal)]">기억</em>되게.
            </h2>
            <Link href="/login" className="btn btn-signal btn-lg">
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
        <p aria-hidden className="display -mb-[0.18em] select-none text-center text-[27vw] leading-[0.8] text-transparent [-webkit-text-stroke:1px_rgba(241,238,231,.18)]">
          LINKOS
        </p>
      </footer>
    </div>
  );
}
