import Link from "next/link";
import { Icon, Logo } from "@/components/Icon";
import { CardFace } from "@/components/LivingCard";
import { Faq, FeatureCatalog, UsageGuide } from "./_landing/Sections";

// 첫 화면은 한국어로만 말한다 — 영어 표제어·슬로건 금지(제품 이름 LINKOS 와 QR·NFC·AI 같은 굳어진 말만 예외).
const FLOW = ["만나고", "주고받고", "기억하고", "이해하고", "행동하고", "이어주고", "키운다"];

const LADDER = [
  { n: "01", t: "앱끼리 가까이 대고", d: "양쪽 모두 앱이 있으면 블루투스로 주변을 찾고, 두 사람이 모두 승인해야 연결됩니다.", tag: "앱이 있을 때" },
  { n: "02", t: "휴대폰 기본 공유", d: "AirDrop · 퀵 셰어 · 메시지 — 기기가 지원하는 방식으로 일회성 링크를 보냅니다.", tag: "가장 현실적인 방법" },
  { n: "03", t: "NFC 카드 · 스티커", d: "카드를 상대 폰에 대면 브라우저가 바로 열립니다. 상대에게 앱은 필요 없어요.", tag: "물건으로" },
  { n: "04", t: "숫자 4자리", d: "불러 주고 받아 적으면 끝. 어떤 브라우저에서도 즉시 받을 수 있습니다.", tag: "어디서나" },
  { n: "05", t: "QR", d: "앞의 방법이 실패하거나 시간이 지나면 자동으로 나타나는 마지막 수단입니다.", tag: "마지막 수단" },
];

// 네트워크 검색 화면을 글로 옮긴 것 — 실제 /app/network 의 조건 chip · 가림 후보 · 경로 비교와 같은 내용.
const QUERY_CHIPS = ["의료기기 유통", "베트남", "임원 · 본부장", "3촌 이내"];

const PATHS = [
  { rank: "1", via: "김○○ → 박○○", why: "자주 연락하는 관계 · 소개해 본 적 있음", tone: "bg-[var(--color-mint)]", note: "추천" },
  { rank: "2", via: "정○○", why: "가장 짧지만 2년째 연락이 없는 휴면 관계", tone: "bg-[var(--color-butter)]", note: "최단" },
  { rank: "3", via: "이○○ → 한○○", why: "다른 회사를 거치는 대안 경로", tone: "bg-[var(--color-sky)]", note: "대안" },
];

const NET_MORE = [
  { t: "프로젝트에 필요한 사람", d: "“현지 유통 파트너가 필요합니다”라고 적으면 역할과 조건으로 바꿔 주고, 내 인맥에 없는 자리는 공백으로 표시합니다.", icon: "flag", href: "#guide-projects" },
  { t: "기회 보드", d: "탐지됨 → 검토 → 소개 요청 → 소개 완료 → 협의 → 성사까지 한 줄로 따라갑니다. 자동으로 메일이 가는 일은 없습니다.", icon: "bolt", href: "#guide-opportunities" },
  { t: "우리 회사 말 가르치기", d: "“메디텍”이 의료기기라는 걸 한 번 등록하면 다음 검색부터 바로 알아듣습니다. 모르는 말은 지어내지 않고 비웁니다.", icon: "layers", href: "#guide-network" },
] as const;

const BENTO = [
  { t: "기억으로 찾기", d: "“작년 코엑스에서 만난 의료 AI 대표” — 만남 · 메모 · 미팅을 근거와 함께 찾아냅니다.", icon: "spark", span: "sm:col-span-2" },
  { t: "줄 수 있는 것 ↔ 필요한 것", d: "내가 줄 수 있는 것과 지금 필요한 것을 정리해 두면, 왜 맞는지까지 설명합니다.", icon: "link", span: "" },
  { t: "관계 강도 · 휴면 알림", d: "만난 빈도 · 최근성 · 주고받음 등 아홉 가지 신호로 매일 다시 계산하고, 식어가는 관계를 먼저 알려 줍니다.", icon: "chart", span: "" },
  { t: "미팅 카드", d: "목적 · 결정 · 약속 · 할 일 · 다음 일정. 녹음은 동의를 기록하기 전에는 시작되지 않습니다.", icon: "calendar", span: "" },
  { t: "구글 · 엑셀 · vCard", d: "중복 없는 동기화와 고른 항목만 내보내기.", icon: "download", span: "" },
  { t: "행사에서 오늘 만나볼 사람", d: "참가자가 공유하기로 한 정보로만 계산합니다.", icon: "flag", span: "sm:col-span-3" },
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
        <div aria-hidden className="marks" />
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-[42%] size-[880px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--line)] [animation:spin-slow_120s_linear_infinite]">
          <span className="absolute -top-1.5 left-1/2 size-3 rounded-full bg-[var(--color-iris-2)] shadow-[0_0_24px_6px_rgba(143,123,255,.45)]" />
        </div>
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-[42%] size-[620px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-[var(--line)] [animation:spin-slow_90s_linear_infinite_reverse]" />

        <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
          <Logo />
          <nav className="flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--glass)] p-1 backdrop-blur-xl sm:gap-1">
            <a href="#how" className="hidden rounded-full px-4 py-2 text-[14px] text-[var(--fg-mute)] transition hover:bg-[var(--bg-sunk)] hover:text-[var(--fg)] lg:inline">쓰는 방식</a>
            <a href="#ladder" className="hidden rounded-full px-4 py-2 text-[14px] text-[var(--fg-mute)] transition hover:bg-[var(--bg-sunk)] hover:text-[var(--fg)] lg:inline">주고받는 법</a>
            <a href="#network" className="hidden rounded-full px-4 py-2 text-[14px] text-[var(--fg-mute)] transition hover:bg-[var(--bg-sunk)] hover:text-[var(--fg)] md:inline">소개 경로</a>
            <a href="#features" className="hidden rounded-full px-4 py-2 text-[14px] text-[var(--fg-mute)] transition hover:bg-[var(--bg-sunk)] hover:text-[var(--fg)] sm:inline">기능</a>
            <a href="#guide" className="hidden rounded-full px-4 py-2 text-[14px] text-[var(--fg-mute)] transition hover:bg-[var(--bg-sunk)] hover:text-[var(--fg)] sm:inline">사용 방법</a>
            <a href="#faq" className="hidden rounded-full px-4 py-2 text-[14px] text-[var(--fg-mute)] transition hover:bg-[var(--bg-sunk)] hover:text-[var(--fg)] lg:inline">자주 묻는 질문</a>
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
              명함 · 인맥 · 소개를 한 곳에서
            </p>
            {/* 한글은 글자폭이 라틴 문자보다 넓다 — 좁은 화면과 lg 컬럼에서 잘리지 않는 크기로 단계를 잡는다. */}
            <h1 className="display mt-6 text-[13vw] sm:text-[76px] lg:text-[80px] xl:text-[100px]">
              <span className="block"><Words text="주고받고," delay={60} /></span>
              <span className="block"><Words text="기억하고," delay={180} /></span>
              <span className="block">
                <span className="words"><em style={{ animationDelay: "320ms" }}>이어줍니다.</em></span>
              </span>
            </h1>
            <p className="mt-8 max-w-xl text-[18px] leading-relaxed text-[var(--fg-mute)] animate-rise delay-4">
              명함을 주고받으면 관계가 되고, 만남 · 메모 · 미팅이 쌓이면 다음에 만날 사람과 거기까지 가는 소개 경로까지 찾아 줍니다.
              <span className="text-[var(--fg)]"> 받는 사람은 가입하지 않아도 됩니다.</span>
            </p>
            <div className="mt-10 flex flex-wrap gap-3 animate-rise delay-5">
              <Link href="/login" className="btn btn-signal btn-lg">
                무료로 시작하기 <Icon name="arrow" size={18} />
              </Link>
              <Link href="/c" className="btn btn-ghost btn-lg">코드로 명함 받기</Link>
            </div>
            <p className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-[14px] font-medium animate-fade delay-5">
              <a href="#features" className="inline-flex items-center gap-1.5 text-[var(--accent-text)] underline-offset-4 hover:underline">기능 전체 보기 <Icon name="arrow" size={15} /></a>
              <a href="#guide" className="inline-flex items-center gap-1.5 text-[var(--accent-text)] underline-offset-4 hover:underline">쓰는 방법 보기 <Icon name="arrow" size={15} /></a>
            </p>
            <div className="mt-10 flex items-center gap-4 text-[13px] text-[var(--fg-mute)] animate-fade delay-5">
              <div className="flex -space-x-2">
                {["#d9d2ff", "#cdeedf", "#ffd9c9", "#d3e5ff"].map((c) => (
                  <span key={c} className="size-8 rounded-full border-2 border-[var(--bg-elev)]" style={{ background: c }} />
                ))}
              </div>
              가입 없이 교환 · 글자 인식은 기기 안에서 · 보내기는 내가 승인한 뒤에
            </div>
          </div>

          <div className="relative mx-auto aspect-square w-full max-w-[470px] [perspective:1200px]" aria-hidden>
            <div className="absolute left-[4%] top-[2%] w-[78%] -rotate-[9deg] [animation:float_9s_ease-in-out_infinite]">
              <div data-tilt className="rounded-[28px] transition-transform duration-500">
                <CardFace size="sm" interactive={false} card={{ name: "서민아", company: "노스윈드 벤처스", jobTitle: "파트너", theme: "ember" }} />
              </div>
            </div>
            <div className="absolute right-[0%] top-[30%] w-[78%] rotate-[7deg] [animation:float_11s_ease-in-out_infinite_reverse]">
              <div data-tilt className="rounded-[28px] transition-transform duration-500">
                <CardFace size="sm" interactive={false} card={{ name: "박준", company: "시그널랩스", jobTitle: "대표", theme: "signal" }} />
              </div>
            </div>
            <div className="absolute bottom-[0%] left-[8%] w-[80%] -rotate-[3deg] [animation:float_10s_ease-in-out_infinite]">
              <div data-tilt className="glow-border rounded-[28px] transition-transform duration-500">
                <CardFace size="sm" interactive={false} card={{ name: "홍길동", company: "링코스랩", jobTitle: "대표", theme: "paper", keywords: ["의료AI", "B2B"] }} />
              </div>
            </div>
            <span className="chip chip-ai absolute -left-2 top-[46%] shadow-lg [animation:float_7s_ease-in-out_infinite]">서로 맞는 정도 92%</span>
            <span className="chip absolute -right-1 bottom-[18%] !bg-[var(--bg-elev)] shadow-lg [animation:float_8s_ease-in-out_infinite_reverse]">✓ 교환 완료 · 0.8초</span>
          </div>
        </div>

        <div className="relative z-10 border-y border-[var(--line)] bg-[var(--glass)] py-5 backdrop-blur" aria-hidden>
          <div className="flex w-max animate-marquee whitespace-nowrap">
            {[0, 1].map((k) => (
              <div key={k} className="flex items-center">
                {FLOW.map((w, i) => (
                  <span key={`${k}-${w}`} className="display flex items-center px-6 text-[46px] sm:text-[62px]">
                    <span className={i % 2 ? "italic text-[var(--accent-text)]" : "text-transparent [-webkit-text-stroke:1px_rgba(91,75,214,.45)]"}>{w}</span>
                    <span className="ml-12 text-[24px] text-[var(--color-iris-2)]">✦</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 01 가입보다 교환이 먼저 ───────────────────── */}
      <section id="how" className="mx-auto max-w-7xl px-5 py-28 sm:px-8 sm:py-36">
        <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <div data-reveal>
            <p className="eyebrow">01 — 가입 없이 주고받기</p>
            <h2 className="display mt-4 text-[60px] sm:text-[88px]">
              가입보다 <em>교환</em>이 먼저.
            </h2>
            <p className="mt-6 max-w-md text-[17px] leading-relaxed text-[var(--fg-mute)]">
              받는 사람은 링크를 여는 즉시 3초 카드를 봅니다. “내 명함도 보내기”를 누르고 종이 명함을 찍으면 10초 만에 서로 교환이 끝나요. 계정은 그 다음, 원할 때.
            </p>
          </div>
          <ol className="grid gap-4 sm:grid-cols-3">
            {[
              ["받기", "로그인 없이 상대의 명함이 바로 열립니다.", "eye"],
              ["찍기", "종이 명함을 촬영하면 기기 안에서 글자를 읽고, 자신 없는 항목만 확인합니다.", "camera"],
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

      {/* ── 02 주고받는 방법 사다리 ───────────────────── */}
      <section id="ladder" className="stage-aurora grain">
        <div className="mx-auto max-w-7xl px-5 py-28 sm:px-8 sm:py-36">
          <div className="flex flex-wrap items-end justify-between gap-6" data-reveal>
            <div>
              <p className="eyebrow">02 — 상황에 맞는 방법으로</p>
              <h2 className="display mt-4 text-[60px] sm:text-[88px]">
                QR은 <em>마지막에</em>.
              </h2>
            </div>
            <p className="max-w-md text-[16px] leading-relaxed text-[var(--fg-mute)]">
              누를 버튼은 하나. 기기가 할 수 있는 방법을 차례로 시도하고, 실패 · 취소 · 시간 초과를 감지하면 다음 단계로 넘어갑니다. 브라우저만으로 폰과 폰을 맞대 보낸다는 과장은 하지 않습니다.
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

      {/* ── 03 살아있는 명함 ─────────────────────────── */}
      <section className="mx-auto max-w-7xl px-5 py-28 sm:px-8 sm:py-36">
        <div className="grid items-center gap-16 lg:grid-cols-2">
          <div className="relative mx-auto w-full max-w-md" data-reveal>
            <div aria-hidden className="absolute -inset-10 -z-10 rounded-full bg-[radial-gradient(closest-side,var(--aurora-1),transparent)] blur-2xl" />
            <div data-tilt className="rounded-[28px] transition-transform duration-500">
              <CardFace card={{ name: "박준", company: "시그널랩스", jobTitle: "대표", headline: "에너지 데이터 인프라", keywords: ["기후기술", "B2B", "시드"], theme: "ink" }} />
            </div>
            <div className="surface absolute -bottom-10 -right-4 w-[72%] rotate-2 p-4 !shadow-[var(--shadow-md)] sm:-right-10 [animation:float_8s_ease-in-out_infinite]">
              <p className="eyebrow">30초 카드</p>
              <p className="mt-2 rounded-xl bg-[var(--color-mint)] px-3 py-2 text-[14px] font-medium text-[var(--color-ink)]">줄 수 있는 것 · 전력 사용량 실시간 분석</p>
              <p className="mt-2 rounded-xl bg-[var(--color-peach)] px-3 py-2 text-[14px] font-medium text-[var(--color-ink)]">필요한 것 · 제조사 파일럿 고객</p>
            </div>
          </div>
          <div data-reveal>
            <p className="eyebrow">03 — 내 명함</p>
            <h2 className="display mt-4 text-[60px] sm:text-[88px]">
              살아있는 <em>명함</em>.
            </h2>
            <p className="mt-6 max-w-md text-[17px] leading-relaxed text-[var(--fg-mute)]">
              3초에 누구인지, 30초에 무엇을 주고받을 수 있는지, 자세히 보기에서 믿을 근거까지. 직책이 바뀌면 연결된 사람들에게 갱신이 전달됩니다.
            </p>
            <div className="mt-8 flex flex-wrap gap-2">
              {["3초 카드", "30초 카드", "자세히 보기", "상대에 따라 다르게", "숨긴 항목 요청", "바로 연락 버튼"].map((x, i) => (
                <span key={x} className={`chip !border-transparent ${CHIP[i]} text-[var(--color-ink)]`}>{x}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── 04 네트워크 검색 · 소개 경로 (신규) ───────── */}
      <section id="network" className="stage-aurora grain scroll-mt-6">
        <div className="mx-auto max-w-7xl px-5 py-28 sm:px-8 sm:py-36">
          <div className="grid gap-12 lg:grid-cols-[1fr_1.05fr] lg:items-center">
            <div data-reveal>
              <p className="eyebrow">04 — 네트워크 검색 · 소개 경로</p>
              {/* 다른 h2 보다 문장이 길다 — 줄이 과하게 늘어지지 않도록 한 단계 작게 간다. */}
              <h2 className="display mt-4 text-[46px] sm:text-[66px]">
                아는 사람 너머, <em>닿을 수 있는</em> 사람까지.
              </h2>
              <p className="mt-6 max-w-lg text-[17px] leading-relaxed text-[var(--fg-mute)]">
                하려는 일을 그대로 적으면 조건으로 나눠 내 인맥 3촌 안에서 찾고, 그 사람에게 닿는 길을 여러 개 비교해 줍니다.
                최단 경로를 “최적”이라고 부르지 않아요 — 관계 강도 · 최근성 · 동의 · 휴면 정도를 함께 봅니다.
              </p>
              <ul className="mt-8 grid gap-3">
                {[
                  ["2 · 3촌은 가려서", "내 연락처가 아닌 분은 “2촌 · 의료기기 · 임원 · 베트남 · 소개경로 있음”처럼만 보입니다. 신원은 소개가 승인된 뒤에, 연락처는 그 다음에."],
                  ["점수 구성과 근거", "왜 위에 왔는지 요소별 점수를 펼쳐 보고, 이유마다 원천(명함 · 미팅 · 소개 이력)과 날짜 · 신뢰도를 확인합니다."],
                  ["저장해 두면 알려 줍니다", "저장한 검색에 새 후보가 생겼을 때만 알림함으로. 같은 후보를 다시 알리지는 않습니다."],
                ].map(([t, d], i) => (
                  <li key={t} data-reveal style={{ ["--reveal-delay" as string]: `${i * 90}ms` }} className="flex gap-3.5">
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-[var(--accent-soft)] text-[var(--accent-text)]">
                      <Icon name="check" size={14} strokeWidth={2.4} />
                    </span>
                    <p className="text-[15.5px] leading-relaxed">
                      <b className="font-semibold">{t}</b>
                      <span className="text-[var(--fg-mute)]"> — {d}</span>
                    </p>
                  </li>
                ))}
              </ul>
              <a href="#guide-network" className="btn btn-ghost mt-8 !min-h-11">
                네트워크 검색 사용법 보기 <Icon name="arrow" size={16} />
              </a>
            </div>

            {/* 검색 화면을 그대로 옮긴 정적 미리보기 (이미지·JS 없이 CSS 로만) */}
            <div className="surface p-5 sm:p-7" data-reveal aria-hidden>
              <p className="eyebrow">네트워크 검색</p>
              <p className="mt-3 rounded-2xl bg-[var(--bg-sunk)] px-4 py-3.5 text-[15px] leading-relaxed">
                베트남에서 의료기기를 유통할 회사를 내 3촌 안에서 찾아줘
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {QUERY_CHIPS.map((c, i) => (
                  <span key={c} className={`chip !border-transparent !px-2.5 !py-1 !text-[12.5px] ${CHIP[i]} text-[var(--color-ink)]`}>{c}</span>
                ))}
              </div>

              <div className="mt-5 rounded-[22px] border border-[var(--line)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="grid size-10 place-items-center rounded-2xl bg-[var(--bg-sunk)] text-[var(--fg-mute)]">
                    <Icon name="lock" size={17} />
                  </span>
                  <span className="chip chip-ai !px-2 !py-0.5 !text-[11px]">맞는 정도 0.86</span>
                </div>
                <p className="mt-3 text-[15px] font-semibold">2촌 · 의료기기 유통 · 임원/본부장</p>
                <p className="mt-1 text-[13.5px] text-[var(--fg-mute)]">호찌민 · 소개 경로 있음 · 이름과 연락처는 소개가 승인된 뒤에 열립니다</p>
              </div>

              <p className="mt-6 text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--fg-mute)]">소개 경로 비교</p>
              <ol className="mt-3 grid gap-2">
                {PATHS.map((p) => (
                  <li key={p.rank} className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-[var(--color-ink)] ${p.tone}`}>
                    <span className="num grid size-7 shrink-0 place-items-center rounded-full bg-white/80 text-[13px] font-semibold">{p.rank}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14.5px] font-semibold">{p.via}</span>
                      <span className="block text-[13px] text-[var(--color-ink)]/65">{p.why}</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-white/70 px-2.5 py-1 text-[11.5px] font-semibold">{p.note}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-[13px] text-[var(--fg-mute)]">같은 사람만 반복되지 않도록 다른 길을 섞어 최소 3개를 보여줍니다.</p>
            </div>
          </div>

          <div className="mt-16 grid gap-4 sm:grid-cols-3">
            {NET_MORE.map((m, i) => (
              <a
                key={m.t}
                href={m.href}
                data-reveal
                style={{ ["--reveal-delay" as string]: `${i * 100}ms` }}
                className="surface group p-6 transition duration-500 hover:-translate-y-1.5 hover:shadow-[var(--shadow-md)]"
              >
                <span className="grid size-11 place-items-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-text)]">
                  <Icon name={m.icon} size={20} />
                </span>
                <h3 className="mt-5 text-[19px] font-semibold">{m.t}</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">{m.d}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-medium text-[var(--accent-text)]">
                  쓰는 방법 <Icon name="arrow" size={15} />
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* ── 05 기억하고 이해하고 행동하기 ────────────── */}
      <section className="mx-auto max-w-7xl px-5 py-28 sm:px-8 sm:py-36">
        <div data-reveal>
          <p className="eyebrow">05 — 만난 다음</p>
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
              <h3 className="relative mt-14 text-[30px] font-semibold leading-tight">{b.t}</h3>
              <p className="relative mt-3 max-w-md text-[15px] leading-relaxed text-[var(--color-ink)]/65">{b.d}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── 06 신뢰 ──────────────────────────────────── */}
      <section id="trust" className="border-t border-[var(--line)] bg-[var(--bg-sunk)]">
        <div className="mx-auto grid max-w-7xl gap-10 px-5 py-28 sm:px-8 sm:py-36 lg:grid-cols-[1fr_1.2fr]">
          <div data-reveal>
            <p className="eyebrow">06 — 기본값이 안전하게</p>
            <h2 className="display mt-4 text-[54px] sm:text-[80px]">
              신뢰는 <em>기본값</em>.
            </h2>
            <p className="mt-6 max-w-sm text-[16px] leading-relaxed text-[var(--fg-mute)]">
              전체 관계도를 브라우저로 내려보내고 화면에서만 가리는 방식은 쓰지 않습니다. 볼 수 있는 범위만 서버에서 골라 내려갑니다.
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-4">
            {[
              ["192비트", "교환 링크의 무작위 길이. 서버에는 해시만 저장하고 개인정보는 담지 않습니다."],
              ["0", "로그 · 분석 기록에 남는 전화번호 · 이메일 원문."],
              ["5단계", "탐색 → 소개 요청 → 신원 공개 → 연락처 공개로 올라가는 권한. 2 · 3촌은 기본이 가림입니다."],
              ["7일", "계정 삭제 유예 후 영구 삭제. 내 데이터는 언제든 JSON으로."],
            ].map(([k, v], i) => (
              <div key={k} data-reveal style={{ ["--reveal-delay" as string]: `${i * 100}ms` }} className="surface p-6">
                <dt className="display num bg-gradient-to-br from-[var(--color-iris)] to-[#f08fb4] bg-clip-text text-[46px] leading-none text-transparent sm:text-[56px]">{k}</dt>
                <dd className="mt-3 text-[15px] leading-relaxed text-[var(--fg-mute)]">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── 07 기능 · 08 사용 방법 · 09 자주 묻는 질문 ── */}
      <FeatureCatalog />
      <UsageGuide />
      <Faq />

      {/* ── Footer ───────────────────────────────────── */}
      <footer className="stage-aurora grain overflow-hidden">
        <div aria-hidden className="marks" />
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
            <a href="#features" className="hover:text-[var(--fg)]">기능 전체</a>
            <a href="#guide" className="hover:text-[var(--fg)]">사용 방법</a>
            <a href="#faq" className="hover:text-[var(--fg)]">자주 묻는 질문</a>
          </div>
        </div>
        <p aria-hidden className="display -mb-[0.18em] select-none bg-gradient-to-b from-[rgba(108,92,231,.22)] to-transparent bg-clip-text text-center text-[27vw] leading-[0.8] text-transparent">
          LINKOS
        </p>
      </footer>
    </div>
  );
}
