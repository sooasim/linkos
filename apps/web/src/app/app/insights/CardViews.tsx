// X-003 card view analytics (server component): counts only, 30-day sparkline, per exchange session.
import { cardViews } from "@linkos/api";
import { sparklinePoints } from "@linkos/domain";
import Link from "next/link";

const LABEL = { view: "카드 열람", cta: "연락 버튼 탭", vcard: "연락처 저장", reply: "회신" } as const;

function Sparkline({ values, label }: { values: number[]; label: string }) {
  const w = 120;
  const h = 32;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label} 30일 추이`} className="text-[var(--accent)]">
      <polyline points={sparklinePoints(values, w, h)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export async function CardViews({ userId }: { userId: string }) {
  const d = await cardViews.cardViewInsights(userId, 30);
  const links = d.totals.link_sig + d.totals.link_bg + d.totals.link_wallet;
  return (
    <section className="surface mt-6 p-5" aria-labelledby="cv-h" data-testid="card-views">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="cv-h" className="text-[17px] font-semibold">내 카드 반응</h2>
        <Link href="/app/settings#assistant" className="text-[12.5px] text-[var(--fg-mute)] underline">집계 설정</Link>
      </div>
      {d.optOut ? (
        <p className="mt-3 text-[14px] text-[var(--fg-mute)]" data-testid="card-views-off">카드 조회 집계를 껐어요. 설정에서 다시 켤 수 있어요.</p>
      ) : (
        <>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {(Object.keys(LABEL) as (keyof typeof LABEL)[]).map((k) => (
              <li key={k} className="flex items-center justify-between gap-3 rounded-2xl bg-[var(--bg-sunk)] px-4 py-3">
                <span>
                  <span className="block text-[13px] text-[var(--fg-mute)]">{LABEL[k]}</span>
                  <span className="display num text-[32px] leading-none" data-testid={`cv-${k}`}>{d.totals[k]}</span>
                </span>
                <Sparkline values={d.series[k]} label={LABEL[k]} />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[13px] text-[var(--fg-mute)]">공유 도구 링크로 들어온 방문 <b className="num">{links}</b> (서명 {d.totals.link_sig} · 배경 {d.totals.link_bg} · 지갑 {d.totals.link_wallet})</p>
          {d.sessions.length === 0 ? (
            <p className="mt-4 text-[14px] text-[var(--fg-mute)]">아직 기록이 없어요. 명함을 교환하면 교환별 반응이 여기에 쌓여요.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-[13.5px]">
                <caption className="sr-only">교환별 반응</caption>
                <thead className="text-[12px] text-[var(--fg-mute)]">
                  <tr><th className="py-1 font-medium">교환</th><th className="font-medium">열람</th><th className="font-medium">탭</th><th className="font-medium">저장</th><th className="font-medium">회신</th></tr>
                </thead>
                <tbody>
                  {d.sessions.map((s) => (
                    <tr key={s.sessionId} className="border-t border-[var(--line)]">
                      <td className="py-2">{s.placeLabel ?? new Date(s.createdAt).toLocaleDateString("ko-KR")}{s.isGroup ? " · 그룹" : ""}</td>
                      <td className="num">{s.view}</td><td className="num">{s.cta}</td><td className="num">{s.vcard}</td><td className="num">{s.reply}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-[12px] text-[var(--fg-mute)]">방문자 IP·기기 정보는 저장하지 않고 날짜별 숫자만 셉니다. 브라우저의 추적 거부(GPC/DNT) 신호도 존중해요.</p>
        </>
      )}
    </section>
  );
}
