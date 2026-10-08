"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Empty } from "@/components/Page";
import { type SeatLimit, SeatLimitNotice, seatLimitOf } from "@/components/PlanLimit";
import { api, uid } from "@/lib/client";
import type { OrgInfo } from "./activeOrg";
import { MembershipPrefs } from "./MembershipPrefs";

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", manager: "Manager", member: "Member", viewer: "Viewer" };

interface MyOrgs {
  activeOrgId: string | null;
  orgs: { id: string; name: string; slug: string; role: string; status: string }[];
  discoverable: { id: string; name: string; mode: "join" | "request" | "none" }[];
}

// F-129 workspace switch + create · F-004 domain join · F-135 activity dashboard · F-134/F-138 내 멤버십 설정
export function OrgHub({ active }: { active: OrgInfo | null }) {
  const router = useRouter();
  const [mine, setMine] = useState<MyOrgs | null>(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [activity, setActivity] = useState<any>(null);
  const [days, setDays] = useState(30);
  const load = () => api<MyOrgs>("/orgs").then(setMine);
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (active?.permissions.includes("dashboard.read")) api(`/orgs/${active.id}/activity?days=${days}`).then(setActivity).catch(() => setActivity(null));
  }, [active?.id, days]);

  const switchTo = async (orgId: string | null) => {
    await api("/orgs/active", { body: { orgId } });
    router.refresh();
    load();
  };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api("/orgs", { body: { name }, idempotencyKey: uid() });
      setName("");
      router.refresh();
      load();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  const [seats, setSeats] = useState<SeatLimit | null>(null);
  // F-004 domain join — a full org answers 402 plan_limit_reached (seats)
  const join = async (id: string) => {
    setSeats(null);
    try {
      const r = await api<{ status: string }>(`/orgs/${id}/join`, { body: {} });
      setErr(r.status === "pending" ? "가입 요청을 보냈어요. 관리자 승인 후 합류됩니다." : null);
    } catch (x) {
      const s = seatLimitOf(x);
      if (s) setSeats(s);
      else setErr((x as Error).message);
    }
    load();
    router.refresh();
  };

  return (
    <div className="space-y-6">
      <section className="surface p-5">
        <p className="eyebrow">워크스페이스</p>
        <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="워크스페이스 선택">
          <button role="radio" aria-checked={!mine?.activeOrgId} className={`chip ${!mine?.activeOrgId ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} onClick={() => switchTo(null)}>
            개인
          </button>
          {mine?.orgs.filter((o) => o.status === "active").map((o) => (
            <button key={o.id} role="radio" aria-checked={mine.activeOrgId === o.id} className={`chip ${mine.activeOrgId === o.id ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} onClick={() => switchTo(o.id)}>
              {o.name} · {ROLE[o.role]}
            </button>
          ))}
          {mine?.orgs.filter((o) => o.status === "pending").map((o) => (
            <span key={o.id} className="chip opacity-70">{o.name} · 승인 대기</span>
          ))}
        </div>
        {!!mine?.discoverable.length && (
          <div className="mt-4 space-y-2">
            {mine.discoverable.map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-2xl border border-[var(--line)] px-4 py-3 text-[14px]">
                <span>회사 이메일 도메인으로 <b>{d.name}</b>에 {d.mode === "join" ? "바로 합류" : "가입 요청"}할 수 있어요</span>
                <button className="btn btn-signal !min-h-9 text-[13px]" onClick={() => join(d.id)}>{d.mode === "join" ? "합류" : "요청"}</button>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={create} className="mt-5 flex gap-2">
          <label htmlFor="orgname" className="sr-only">새 조직 이름</label>
          <input id="orgname" className="field flex-1" placeholder="새 조직 이름 (예: 링코스랩)" value={name} onChange={(e) => setName(e.target.value)} minLength={2} required />
          <button className="btn btn-ink" disabled={name.trim().length < 2}><Icon name="plus" size={16} />만들기</button>
        </form>
        {seats && <div className="mt-3"><SeatLimitNotice {...seats} admin={false} /></div>}
        {err && <p role="status" className="mt-3 text-[14px] text-[var(--fg-mute)]">{err}</p>}
      </section>

      {!active ? (
        <Empty title="개인 워크스페이스" body="조직을 만들거나 초대 링크로 합류하면 팀 주소록, 관계 그래프, 관리자 기능을 쓸 수 있어요." />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-4">
            {[
              ["멤버", active.counts?.members],
              ["승인 대기", active.counts?.pending],
              ["팀 주소록", active.counts?.shared],
              ["회사 리드", active.counts?.leads],
            ].map(([k, v]) => (
              <div key={k as string} className="surface p-4">
                <p className="eyebrow">{k}</p>
                <p className="num display mt-1 text-[34px]">{(v as number) ?? 0}</p>
              </div>
            ))}
          </section>
          <nav className="grid gap-2 sm:grid-cols-2" aria-label="조직 메뉴">
            <Link href="/app/team" className="surface flex items-center gap-3 p-4 font-semibold"><Icon name="people" />팀 주소록</Link>
            {active.permissions.includes("graph.read") && <Link href="/app/org/graph" className="surface flex items-center gap-3 p-4 font-semibold"><Icon name="layers" />관계 그래프 · Who Knows Whom</Link>}
            <Link href="/app/org/members" className="surface flex items-center gap-3 p-4 font-semibold"><Icon name="me" />멤버 · 역할 · 초대</Link>
            {active.permissions.includes("org.update") && <Link href="/app/org/settings" className="surface flex items-center gap-3 p-4 font-semibold"><Icon name="settings" />정책 · 브랜딩 · 보존 · SSO · API 키</Link>}
          </nav>
          <MembershipPrefs key={active.id} orgId={active.id} initial={{ graphOptOut: !!active.graphOptOut, showBrandingOnCard: !!active.showBrandingOnCard }} />
          {activity && (
            <section className="surface space-y-4 p-5">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Icon name="chart" size={19} />팀 활동</h2>
                <select className="field !w-auto !py-1.5 text-[13px]" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="기간">
                  <option value={7}>7일</option>
                  <option value={30}>30일</option>
                  <option value={90}>90일</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3 text-[14px] sm:grid-cols-4">
                {[
                  ["스캔", activity.totals.scans],
                  ["교환", `${activity.totals.exchanges_done}/${activity.totals.exchanges}`],
                  ["미팅", activity.totals.meetings],
                  ["후속 완료", `${activity.totals.followups_done}/${activity.totals.followups}`],
                  ["소개 성사", `${activity.totals.intros_won}/${activity.totals.intros}`],
                  ["Claim 전환", activity.rates.claimConversion == null ? "—" : `${activity.rates.claimConversion}%`],
                  ["팀 공유", activity.totals.shared],
                  ["미배정 리드", activity.teamBook?.unassigned ?? 0],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded-2xl border border-[var(--line)] p-3">
                    <p className="text-[12px] text-[var(--fg-mute)]">{k}</p>
                    <p className="num text-[20px] font-semibold">{v as string}</p>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-[13.5px]">
                  <thead className="text-[12px] text-[var(--fg-mute)]">
                    <tr><th className="py-2">멤버</th><th>스캔</th><th>교환</th><th>미팅</th><th>후속</th><th>소개</th><th>공유</th></tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)]">
                    {activity.members.map((m: any) => (
                      <tr key={m.userId}>
                        <td className="py-2 font-medium">{m.name} <span className="text-[var(--fg-mute)]">· {ROLE[m.role]}</span></td>
                        <td className="num">{m.scans}</td>
                        <td className="num">{m.exchanges_done}/{m.exchanges}</td>
                        <td className="num">{m.meetings}</td>
                        <td className="num">{m.followups_done}/{m.followups}</td>
                        <td className="num">{m.intros_won}/{m.intros}</td>
                        <td className="num">{m.shared}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
