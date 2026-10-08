"use client";
import { useCallback, useEffect, useState } from "react";
import { Empty } from "@/components/Page";
import { api } from "@/lib/client";

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (v: number | null | undefined, scale = 1) => (v === null || v === undefined ? "—" : `${Math.round(v * scale * 10) / 10}%`);
const STEP_KO: Record<string, string> = {
  guest_landing_viewed: "게스트 열람",
  guest_replied: "회신",
  guest_claimed: "Claim",
  exchange_created: "교환 생성",
  signup_completed: "가입",
  profile_created: "카드 생성",
  usage_limit_hit: "한도 도달",
  checkout_started: "결제 시작",
  subscription_activated: "구독 활성",
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="surface p-4">
      <p className="text-[12.5px] font-medium text-[var(--fg-mute)]">{label}</p>
      <p className="display num mt-1 text-[34px] leading-none">{value}</p>
      {hint && <p className="mt-1 text-[12px] text-[var(--fg-mute)]">{hint}</p>}
    </div>
  );
}

export function AdminConsole() {
  const [days, setDays] = useState(30);
  const [rev, setRev] = useState<any>(null);
  const [an, setAn] = useState<any>(null);
  const [flags, setFlags] = useState<any[]>([]);
  const [exps, setExps] = useState<any[]>([]);
  const [results, setResults] = useState<Record<string, any>>({});
  const [error, setError] = useState<string | null>(null);
  const [newFlag, setNewFlag] = useState({ key: "", rollout: 0 });
  const [newExp, setNewExp] = useState({ key: "", name: "", variants: "control,treatment", metric: "cta_clicked", traffic: 100 });

  const load = useCallback(async () => {
    try {
      const [r, a, f, e] = await Promise.all([api("/admin/revenue"), api(`/admin/analytics?days=${days}`), api("/admin/flags"), api("/admin/experiments")]);
      setRev(r);
      setAn(a);
      setFlags(f.flags);
      setExps(e.experiments);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [days]);
  useEffect(() => {
    void load();
  }, [load]);

  const saveFlag = async (f: any, patch: Record<string, unknown>) => {
    await api(`/admin/flags/${f.key}`, {
      method: "PUT",
      body: { description: f.description, enabled: f.enabled, killed: f.killed, rolloutPercent: f.rollout_percent, allowUsers: f.allow_users, allowOrgs: f.allow_orgs, denyUsers: f.deny_users, clientVisible: f.client_visible, ...patch },
    });
    await load();
  };

  return (
    <div className="space-y-8">
      {error && <p role="alert" className="text-[14px] text-[var(--color-ember)]">{error}</p>}
      <div className="flex gap-2" role="group" aria-label="기간">
        {[7, 30, 90].map((d) => (
          <button key={d} className={`chip ${d === days ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} aria-pressed={d === days} onClick={() => setDays(d)}>
            {d}일
          </button>
        ))}
      </div>

      <section aria-labelledby="rev-h">
        <h2 id="rev-h" className="mb-3 text-[18px] font-semibold">매출 (F-195)</h2>
        {!rev ? <div className="surface h-24 animate-pulse" /> : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="MRR" value={money(rev.mrrCents)} />
            <Stat label="ARR" value={money(rev.arrCents)} />
            <Stat label="ARPU" value={money(rev.arpuCents)} hint={`유료 고객 ${rev.payingCustomers}`} />
            <Stat label="Logo churn (30일)" value={pct(rev.logoChurnRate)} />
            <Stat label="Revenue churn" value={pct(rev.revenueChurnRate)} />
            <Stat label="Dunning" value={String(rev.dunning.find((d: any) => d.dunning_state === "grace")?.n ?? 0)} hint="결제 실패 유예 중" />
          </div>
        )}
      </section>

      <section aria-labelledby="fun-h">
        <h2 id="fun-h" className="mb-3 text-[18px] font-semibold">퍼널 · 바이럴 (F-188 / F-189)</h2>
        {!an ? <div className="surface h-24 animate-pulse" /> : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="K-factor" value={an.viral.kFactor === null ? "—" : String(an.viral.kFactor)} hint="신규 가입 / 공유한 사용자" />
              <Stat label="초대당 전환" value={pct(an.viral.inviteConversion, 100)} />
              <Stat label="Claim률" value={pct(an.viral.claimRate, 100)} hint="회신 → 가입" />
              <Stat label="2차 공유율" value={pct(an.viral.secondShareRate, 100)} hint="Claim 후 직접 공유" />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {Object.entries(an.funnel.funnels as Record<string, any[]>).map(([name, steps]) => (
                <div key={name} className="surface p-4">
                  <p className="eyebrow">{name}</p>
                  <ol className="mt-2 space-y-1.5 text-[14px]">
                    {steps.map((s) => (
                      <li key={s.step} className="flex justify-between gap-2">
                        <span>{STEP_KO[s.step] ?? s.step}</span>
                        <span className="num text-[var(--fg-mute)]">{s.events}{s.conversionFromPrev !== null ? ` · ${s.conversionFromPrev}%` : ""}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-[var(--fg-mute)]">1st-party 이벤트 · 식별자는 해시, 속성은 PII 제거 후 저장</p>
          </>
        )}
      </section>

      <section aria-labelledby="cost-h">
        <h2 id="cost-h" className="mb-3 text-[18px] font-semibold">추정 비용 (F-187)</h2>
        {!an ? null : an.cost.byType.length === 0 ? <Empty title="기록된 비용이 없어요" /> : (
          <div className="surface p-4">
            <p className="display num text-[34px]">${an.cost.totalUsd}</p>
            <ul className="mt-2 space-y-1 text-[14px]">
              {an.cost.byType.map((r: any) => (
                <li key={`${r.jobType}${r.provider}`} className="flex justify-between"><span>{r.jobType} · {r.provider}</span><span className="num text-[var(--fg-mute)]">{r.jobs}건 · ${r.usd}</span></li>
              ))}
            </ul>
            <p className="mt-3 text-[12.5px] font-semibold">상위 테넌트</p>
            <ul className="mt-1 space-y-1 text-[13px] text-[var(--fg-mute)]">
              {an.cost.topTenants.map((t: any) => <li key={t.tenant} className="flex justify-between"><span className="num">{t.kind} {t.tenant.slice(0, 8)}</span><span className="num">${t.usd}</span></li>)}
            </ul>
          </div>
        )}
      </section>

      <section aria-labelledby="flag-h">
        <h2 id="flag-h" className="mb-3 text-[18px] font-semibold">Feature Flag (F-181)</h2>
        <ul className="space-y-2">
          {flags.map((f) => (
            <li key={f.key} className="surface flex flex-wrap items-center gap-3 p-4">
              <span className="num font-semibold">{f.key}</span>
              {f.killed && <span className="chip !bg-[var(--color-ember)] !text-white">KILLED</span>}
              <label className="flex items-center gap-2 text-[14px]">
                <input type="checkbox" className="size-5" checked={f.enabled} onChange={(e) => saveFlag(f, { enabled: e.target.checked })} /> 활성
              </label>
              <label className="flex items-center gap-2 text-[14px]">
                롤아웃
                <input type="number" min={0} max={100} className="field !min-h-10 !w-20 !py-1" defaultValue={f.rollout_percent} aria-label={`${f.key} 롤아웃 %`} onBlur={(e) => Number(e.target.value) !== f.rollout_percent && saveFlag(f, { rolloutPercent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />%
              </label>
              <span className="text-[12.5px] text-[var(--fg-mute)]">사용자 {f.allow_users.length} · 조직 {f.allow_orgs.length}</span>
              <button className={`btn ${f.killed ? "btn-ghost" : "btn-ink"} ml-auto !min-h-10`} onClick={() => api(`/admin/flags/${f.key}/kill`, { body: { killed: !f.killed } }).then(load)}>
                {f.killed ? "킬 스위치 해제" : "킬 스위치"}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newFlag.key) return;
            api(`/admin/flags/${newFlag.key}`, { method: "PUT", body: { enabled: true, rolloutPercent: newFlag.rollout } })
              .then(() => setNewFlag({ key: "", rollout: 0 }))
              .then(load)
              .catch((x) => setError(x.message));
          }}
        >
          <input className="field !w-56" placeholder="flag_key" aria-label="새 플래그 key" value={newFlag.key} onChange={(e) => setNewFlag({ ...newFlag, key: e.target.value })} />
          <input className="field !w-24" type="number" min={0} max={100} aria-label="롤아웃 %" value={newFlag.rollout} onChange={(e) => setNewFlag({ ...newFlag, rollout: Number(e.target.value) })} />
          <button className="btn btn-ghost">플래그 추가</button>
        </form>
      </section>

      <section aria-labelledby="exp-h">
        <h2 id="exp-h" className="mb-3 text-[18px] font-semibold">실험 (F-196)</h2>
        <ul className="space-y-2">
          {exps.map((x) => (
            <li key={x.key} className="surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="num font-semibold">{x.key}</span>
                <span className="chip">{x.status}</span>
                <span className="text-[13px] text-[var(--fg-mute)]">{x.name} · 지표 {x.primary_metric} · 노출 {x.exposures}</span>
                <span className="ml-auto flex gap-2">
                  {x.status !== "running" && <button className="btn btn-signal !min-h-10" onClick={() => api(`/admin/experiments/${x.key}`, { body: { status: "running" } }).then(load)}>시작</button>}
                  {x.status === "running" && <button className="btn btn-ghost !min-h-10" onClick={() => api(`/admin/experiments/${x.key}`, { body: { status: "stopped" } }).then(load)}>중지</button>}
                  <button className="btn btn-ghost !min-h-10" onClick={() => api(`/admin/experiments/${x.key}`).then((r) => setResults((s) => ({ ...s, [x.key]: r.results })))}>결과</button>
                </span>
              </div>
              {results[x.key] && (
                <table className="mt-3 w-full text-[13.5px]">
                  <thead className="text-left text-[var(--fg-mute)]"><tr><th>변형</th><th>노출</th><th>전환</th><th>전환율</th><th>Lift</th><th>p</th></tr></thead>
                  <tbody>
                    {results[x.key].map((r: any) => (
                      <tr key={r.variant} className="num">
                        <td>{r.variant}</td><td>{r.exposures}</td><td>{r.conversions}</td><td>{pct(r.rate, 100)}</td>
                        <td>{r.liftPct === null ? "기준" : `${r.liftPct}%`}</td><td>{r.pValue ?? "—"}{r.significant ? " ✓" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          ))}
        </ul>
        <form
          className="surface mt-3 grid gap-2 p-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            api("/admin/experiments", {
              body: { key: newExp.key, name: newExp.name, variants: newExp.variants.split(",").map((k) => ({ key: k.trim(), weight: 1 })), primaryMetric: newExp.metric, trafficPercent: newExp.traffic },
            })
              .then(() => setNewExp({ ...newExp, key: "", name: "" }))
              .then(load)
              .catch((x) => setError(x.message));
          }}
        >
          <input className="field" placeholder="experiment_key" aria-label="실험 key" value={newExp.key} onChange={(e) => setNewExp({ ...newExp, key: e.target.value })} required />
          <input className="field" placeholder="이름" aria-label="실험 이름" value={newExp.name} onChange={(e) => setNewExp({ ...newExp, name: e.target.value })} required />
          <input className="field" placeholder="control,treatment" aria-label="변형 (쉼표 구분)" value={newExp.variants} onChange={(e) => setNewExp({ ...newExp, variants: e.target.value })} />
          <input className="field" placeholder="cta_clicked" aria-label="주요 지표 이벤트" value={newExp.metric} onChange={(e) => setNewExp({ ...newExp, metric: e.target.value })} />
          <button className="btn btn-ink sm:col-span-2">실험 만들기</button>
        </form>
      </section>
    </div>
  );
}
