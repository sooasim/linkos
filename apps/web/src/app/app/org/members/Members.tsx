"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Avatar } from "@/components/Page";
import { type SeatLimit, SeatLimitNotice, seatLimitOf } from "@/components/PlanLimit";
import { api, relTime } from "@/lib/client";

const ROLES = ["owner", "admin", "manager", "member", "viewer"] as const;
const LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", manager: "Manager", member: "Member", viewer: "Viewer" };

// F-130 members & roles · F-004 invites + approvals · F-132 reassignment on removal
export function Members({ orgId, myRole, myId, perms }: { orgId: string; myRole: string; myId: string; perms: string[] }) {
  const [members, setMembers] = useState<any[]>([]);
  const [invites, setInvites] = useState<any[]>([]);
  const [inv, setInv] = useState({ email: "", role: "member", maxUses: 1 });
  const [link, setLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [seats, setSeats] = useState<SeatLimit | null>(null);
  const can = (p: string) => perms.includes(p);
  const load = () => {
    api<{ members: any[] }>(`/orgs/${orgId}/members`).then((r) => setMembers(r.members));
    if (can("members.invite")) api<{ invites: any[] }>(`/orgs/${orgId}/invites`).then((r) => setInvites(r.invites));
  };
  useEffect(load, [orgId]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    setSeats(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      load();
    } catch (e) {
      // F-131: approving past the purchased seats → 402 plan_limit_reached (seats) with an upgrade link
      const s = seatLimitOf(e);
      if (s) setSeats(s);
      else setMsg((e as Error).message);
    }
  };
  const active = members.filter((m) => m.status === "active");
  const pending = members.filter((m) => m.status === "pending");
  const assignable = (cur: string) => (myRole === "owner" ? ROLES : myRole === "admin" && !["owner", "admin"].includes(cur) ? ROLES.filter((r) => !["owner", "admin"].includes(r)) : []);

  const remove = (m: any) => {
    const others = active.filter((x) => x.userId !== m.userId && ["owner", "admin", "manager", "member"].includes(x.role));
    const to = m.leads ? prompt(`${m.name}님의 회사 리드 ${m.leads}건을 넘겨받을 멤버 이름 (비우면 Owner에게 자동 배정)\n${others.map((o) => o.name).join(", ")}`) : "";
    if (to === null) return;
    const target = others.find((o) => o.name === to?.trim());
    run(() => api(`/orgs/${orgId}/members/${m.userId}${target ? `?reassignTo=${target.userId}` : ""}`, { method: "DELETE" }), `${m.name}님을 내보냈어요. 개인 연락처는 본인에게 남고, 회사 리드는 재배정되었습니다.`);
  };

  return (
    <div className="space-y-6">
      {seats && <SeatLimitNotice {...seats} admin={can("billing.manage") || myRole === "owner" || myRole === "admin"} />}
      {msg && <p role="status" className="surface p-4 text-[14px]">{msg}</p>}
      {pending.length > 0 && can("members.approve") && (
        <section className="surface space-y-2 p-5">
          <h2 className="font-semibold">가입 승인 대기 · {pending.length}</h2>
          {pending.map((m) => (
            <div key={m.userId} className="flex items-center justify-between gap-2 text-[14px]">
              <span>{m.name} <span className="text-[var(--fg-mute)]">{m.email ?? ""}</span></span>
              <span className="flex gap-1">
                <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => run(() => api(`/orgs/${orgId}/members/${m.userId}/approve`, { body: { approve: false } }))}>거절</button>
                <button className="btn btn-signal !min-h-9 text-[13px]" onClick={() => run(() => api(`/orgs/${orgId}/members/${m.userId}/approve`, { body: { approve: true } }))}>승인</button>
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="eyebrow px-1">멤버 · {active.length}</h2>
        <ul className="surface divide-y divide-[var(--line)]">
          {active.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Avatar name={m.name} size={38} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{m.name}{m.userId === myId && " (나)"}</span>
                <span className="block truncate text-[12.5px] text-[var(--fg-mute)]">{m.email ?? ""} · {m.joinSource} · {relTime(m.joinedAt)}{m.leads ? ` · 회사 리드 ${m.leads}` : ""}</span>
              </span>
              {can("members.role") && assignable(m.role).length > 0 && m.userId !== myId ? (
                <select className="field !w-auto !py-1.5 text-[13px]" value={m.role} aria-label={`${m.name} 역할`} onChange={(e) => run(() => api(`/orgs/${orgId}/members/${m.userId}`, { method: "PATCH", body: { role: e.target.value } }))}>
                  {assignable(m.role).map((r) => <option key={r} value={r}>{LABEL[r]}</option>)}
                </select>
              ) : (
                <span className="chip">{LABEL[m.role]}</span>
              )}
              {(m.userId === myId || (can("members.remove") && assignable(m.role).length > 0)) && (
                <button className="btn btn-ghost !min-h-9 !px-2 text-[13px]" aria-label={m.userId === myId ? "조직 나가기" : `${m.name} 내보내기`} onClick={() => remove(m)}>
                  {m.userId === myId ? "나가기" : <Icon name="trash" size={16} />}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {can("members.invite") && (
        <section className="surface space-y-3 p-5">
          <h2 className="flex items-center gap-2 font-semibold"><Icon name="link" size={18} />초대 링크</h2>
          <form
            className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const r = await api<{ url: string }>(`/orgs/${orgId}/invites`, { body: { email: inv.email || null, role: inv.role, maxUses: inv.email ? 1 : inv.maxUses } });
                setLink(r.url);
              });
            }}
          >
            <input className="field" type="email" placeholder="이메일(선택 — 지정하면 그 사람만 사용 가능)" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} aria-label="초대 이메일" />
            <select className="field !w-auto" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })} aria-label="초대 역할">
              {ROLES.filter((r) => r !== "owner" && (myRole !== "manager" || ["member", "viewer"].includes(r)) && (myRole !== "admin" || r !== "admin")).map((r) => <option key={r} value={r}>{LABEL[r]}</option>)}
            </select>
            {!inv.email && <input className="field !w-24" type="number" min={1} max={500} value={inv.maxUses} onChange={(e) => setInv({ ...inv, maxUses: Number(e.target.value) || 1 })} aria-label="사용 가능 횟수" />}
            <button className="btn btn-signal">링크 만들기</button>
          </form>
          {link && (
            <div className="flex items-center gap-2 rounded-2xl border border-dashed border-[var(--line)] p-3 text-[13px]">
              <code className="min-w-0 flex-1 truncate">{link}</code>
              <button className="btn btn-ink !min-h-8 text-[12px]" onClick={() => navigator.clipboard?.writeText(link)}>복사</button>
            </div>
          )}
          <p className="text-[12.5px] text-[var(--fg-mute)]">링크는 지금 한 번만 표시됩니다. 서버에는 해시만 저장돼요. 기본 7일 후 만료.</p>
          <ul className="divide-y divide-[var(--line)] text-[13.5px]">
            {invites.map((i) => (
              <li key={i.id} className="flex items-center justify-between py-2">
                <span>{i.email ?? "누구나"} · {LABEL[i.role]} · {i.use_count}/{i.max_uses} · <span className="text-[var(--fg-mute)]">{i.status}</span></span>
                {i.status === "active" && <button className="btn btn-ghost !min-h-8 text-[12px]" onClick={() => run(() => api(`/orgs/${orgId}/invites/${i.id}`, { method: "DELETE" }))}>취소</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
