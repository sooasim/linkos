"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { api, fmtDate, uid } from "@/lib/client";

const METRIC_KO: Record<string, string> = { exchanges: "명함 교환", ocr_scans: "명함 스캔", ai_calls: "AI 호출", exports: "내보내기", stt_minutes: "녹음 전사(분)" };
const usd = (c: number | null) => (c === null ? "문의" : c === 0 ? "무료" : `$${(c / 100).toFixed(0)}`);

type Summary = {
  plan: string;
  planName: string;
  scope: "user" | "organization";
  seats: number;
  period: string;
  usage: { metric: string; used: number; limit: number | null; remaining: number | null }[];
  subscription: { status: string; dunning: "ok" | "grace" | "suspended"; graceUntil: string | null; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null; organizationId: string | null } | null;
  organizations: { id: string; name: string; role: string; members: number; canManageBilling: boolean }[];
  catalog: { id: string; name: string; scope: string; priceMonthlyCents: number | null; limits: Record<string, number | null>; seats: { min: number } | null }[];
  paymentsConfigured: boolean;
};

export function BillingView({ checkout, reason }: { checkout: string | null; reason: string | null }) {
  const [s, setS] = useState<Summary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [yearly, setYearly] = useState(false);
  useEffect(() => {
    api<Summary>("/billing").then(setS).catch((e) => setError(e.message));
  }, []);

  const go = async (key: string, fn: () => Promise<{ url: string }>) => {
    setBusy(key);
    setError(null);
    try {
      const r = await fn();
      window.location.href = r.url;
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  const checkoutFor = (plan: string, organizationId?: string) =>
    go(`${plan}:${organizationId ?? "me"}`, () => api("/billing/checkout", { body: { plan, interval: yearly ? "year" : "month", organizationId }, idempotencyKey: uid() }));

  if (!s) return error ? <p role="alert" className="text-[14px] text-[var(--color-ember)]">{error}</p> : <div className="surface h-40 animate-pulse" />;
  const sub = s.subscription;
  return (
    <div className="space-y-6">
      {checkout === "success" && <p className="surface p-4 text-[14px]" role="status"><Icon name="check" size={16} /> 결제가 완료됐어요. 플랜 반영까지 몇 초 걸릴 수 있어요.</p>}
      {reason && METRIC_KO[reason] && <p className="surface p-4 text-[14px]" role="status">이번 달 <b>{METRIC_KO[reason]}</b> 한도에 도달했어요. 업그레이드하면 바로 계속할 수 있어요.</p>}

      <section className="surface p-5">
        <p className="eyebrow">현재 플랜 {s.scope === "organization" ? "· 조직" : ""}</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <h2 className="display text-[44px] leading-none">{s.planName}</h2>
          {sub && (
            <button className="btn btn-ghost" disabled={!!busy} onClick={() => go("portal", () => api("/billing/portal", { body: { organizationId: sub.organizationId ?? undefined } }))}>
              결제·구독 관리
            </button>
          )}
        </div>
        {sub?.dunning === "grace" && (
          <p role="alert" className="mt-3 rounded-2xl bg-[var(--color-ember)]/10 px-4 py-3 text-[14px] text-[var(--color-ember)]">
            결제에 실패했어요. {sub.graceUntil ? `${fmtDate(sub.graceUntil, { month: "long", day: "numeric" })}까지` : "유예 기간 동안"} 현재 플랜이 유지됩니다. 결제 수단을 확인해 주세요.
          </p>
        )}
        {sub?.cancelAtPeriodEnd && sub.currentPeriodEnd && <p className="mt-3 text-[14px] text-[var(--fg-mute)]">{fmtDate(sub.currentPeriodEnd, { month: "long", day: "numeric" })}에 해지 예정</p>}
        <ul className="mt-5 space-y-3">
          {s.usage.map((u) => {
            const pct = u.limit ? Math.min(100, (u.used / u.limit) * 100) : 0;
            return (
              <li key={u.metric}>
                <div className="flex justify-between text-[14px]">
                  <span>{METRIC_KO[u.metric] ?? u.metric}</span>
                  <span className="num text-[var(--fg-mute)]">{u.used} / {u.limit === null ? "무제한" : u.limit}</span>
                </div>
                {u.limit !== null && (
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--fg)_8%,transparent)]" role="progressbar" aria-label={`${METRIC_KO[u.metric]} 사용량`} aria-valuenow={u.used} aria-valuemax={u.limit}>
                    <div className={`h-full rounded-full ${pct >= 90 ? "bg-[var(--color-ember)]" : "bg-[var(--fg)]"}`} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[12.5px] text-[var(--fg-mute)]">사용량은 매월 1일(UTC) 초기화됩니다. 받은 명함을 열람·회신하는 상대방은 내 사용량에 포함되지 않아요.</p>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[18px] font-semibold">플랜</h2>
          <label className="flex items-center gap-2 text-[14px]">
            <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={yearly} onChange={(e) => setYearly(e.target.checked)} /> 연간 결제
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {s.catalog.map((p) => (
            <article key={p.id} className={`surface flex flex-col p-5 ${p.id === s.plan ? "ring-2 ring-[var(--fg)]" : ""}`}>
              <p className="eyebrow">{p.scope === "organization" ? "기업" : "개인"}</p>
              <h3 className="display mt-1 text-[32px]">{p.name}</h3>
              <p className="num text-[15px]">{usd(p.priceMonthlyCents)}{p.priceMonthlyCents ? (p.scope === "organization" ? " / 좌석·월" : " / 월") : ""}</p>
              <ul className="mt-3 flex-1 space-y-1 text-[13.5px] text-[var(--fg-mute)]">
                {Object.entries(p.limits).map(([k, v]) => (
                  <li key={k}>{METRIC_KO[k] ?? k}: {v === null ? "무제한" : `${v}${p.scope === "organization" ? "/좌석" : ""}`}</li>
                ))}
                {p.seats && <li>최소 {p.seats.min}석</li>}
              </ul>
              {p.id === s.plan ? (
                <span className="chip mt-4 self-start">사용 중</span>
              ) : p.id === "pro" && s.plan === "free" ? (
                <button className="btn btn-signal mt-4" disabled={!!busy || !s.paymentsConfigured} onClick={() => checkoutFor("pro")}>
                  {busy === "pro:me" ? "이동 중…" : "Pro로 업그레이드"}
                </button>
              ) : p.id === "business" ? (
                s.organizations.filter((o) => o.canManageBilling).length ? (
                  <div className="mt-4 space-y-2">
                    {s.organizations.filter((o) => o.canManageBilling).map((o) => (
                      <button key={o.id} className="btn btn-ink w-full" disabled={!!busy || !s.paymentsConfigured} onClick={() => checkoutFor("business", o.id)}>
                        {o.name} ({o.members}명) 업그레이드
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 text-[13px] text-[var(--fg-mute)]">조직 관리자가 결제할 수 있어요.</p>
                )
              ) : p.id === "enterprise" ? (
                <a className="btn btn-ghost mt-4" href="mailto:sales@linkos.app">영업팀 문의</a>
              ) : null}
            </article>
          ))}
        </div>
        {!s.paymentsConfigured && <p className="mt-3 text-[13px] text-[var(--fg-mute)]">이 환경에는 결제가 설정되어 있지 않아요 (STRIPE_SECRET_KEY).</p>}
        {error && <p role="alert" className="mt-3 text-[14px] text-[var(--color-ember)]">{error}</p>}
      </section>
    </div>
  );
}
