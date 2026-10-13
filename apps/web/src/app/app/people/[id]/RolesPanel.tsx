"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/client";

// N-008 Person↔Company 소속 이력 (Person 360 의 Companies 탭).
// 현재 소속의 역할 카테고리가 masked 라벨("2촌 · 의료기기 · 구매/조달 · 서울")의 입력이므로,
// 끝난 소속을 닫아 두는 것이 공개 판정의 정확성에 직접 영향을 준다.

interface Role {
  id: string;
  companyId: string;
  company: string | null;
  title: string | null;
  department: string | null;
  roleCategory: string | null;
  startedOn: string | null;
  endedOn: string | null;
  isCurrent: boolean;
  decidesFor: boolean;
  provenance: string;
}

const period = (r: Role): string => {
  const from = r.startedOn ?? "?";
  const to = r.endedOn ?? (r.isCurrent ? "현재" : "?");
  return r.startedOn || r.endedOn ? `${from} – ${to}` : r.isCurrent ? "현재" : "기간 미기록";
};

export function RolesPanel({ id }: { id: string }) {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [options, setOptions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({ companyName: "", title: "", roleCategory: "", startedOn: "", decidesFor: false });

  const load = useCallback(async () => {
    try {
      const r = await api<{ roles: Role[]; roleCategoryOptions: string[] }>(`/network-intel/roles?contactId=${id}`);
      setRoles(r.roles);
      setOptions(r.roleCategoryOptions);
    } catch {
      setRoles([]);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!roles) return null;

  return (
    <section className="surface mt-4 space-y-3 p-4" aria-label="소속 이력">
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow">소속 이력</p>
        {!open && (
          <button className="btn btn-ghost !min-h-9 !px-3 !text-[13px]" onClick={() => setOpen(true)}>
            <Icon name="plus" size={14} aria-hidden />
            추가
          </button>
        )}
      </div>

      {roles.length === 0 ? (
        <p className="text-[13.5px] text-[var(--fg-mute)]">기록된 소속이 없습니다. 회사와 직책을 넣으면 회사 기준 검색과 역할 카테고리 판정이 정확해집니다.</p>
      ) : (
        <ul className="space-y-2">
          {roles.map((r) => (
            <li key={r.id} className={`rounded-2xl border p-3 ${r.isCurrent ? "border-[var(--line)]" : "border-dashed border-[var(--line)] opacity-80"}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[14.5px] font-medium">
                    {r.company ?? "회사 미지정"}
                    {r.isCurrent && <span className="ml-2 rounded-full bg-[var(--color-mint)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--color-ink)]">현재</span>}
                    {r.decidesFor && <span className="ml-1.5 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--accent-text)]">의사결정</span>}
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-[var(--fg-mute)]">
                    {[r.title, r.department, r.roleCategory].filter(Boolean).join(" · ") || "직책 미기록"} · {period(r)}
                    {r.provenance !== "user" && " · 자동 추출"}
                  </p>
                </div>
                {r.isCurrent && (
                  <button
                    className="shrink-0 text-[12.5px] underline text-[var(--fg-mute)]"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api(`/network-intel/roles/${r.id}`, { method: "PATCH", body: {} });
                        await load();
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    퇴사 처리
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <form
          className="space-y-2 rounded-2xl bg-[var(--bg-sunk)] p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              await api("/network-intel/roles", {
                body: {
                  contactId: id,
                  companyName: f.companyName,
                  title: f.title || null,
                  roleCategory: f.roleCategory || null,
                  startedOn: f.startedOn || null,
                  decidesFor: f.decidesFor,
                  isCurrent: true,
                },
              });
              setOpen(false);
              setF({ companyName: "", title: "", roleCategory: "", startedOn: "", decidesFor: false });
              await load();
            } catch (e2) {
              setErr(e2 instanceof Error ? e2.message : "저장하지 못했습니다.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="label" htmlFor="rcompany">
            회사
          </label>
          <input id="rcompany" className="field" value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} placeholder="예: 알파메디칼" required />
          <label className="label" htmlFor="rtitle">
            직책
          </label>
          <input id="rtitle" className="field" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="예: 구매팀 과장" />
          <label className="label" htmlFor="rcat">
            역할 카테고리 — 비워 두면 직책에서 추론합니다
          </label>
          <select id="rcat" className="field" value={f.roleCategory} onChange={(e) => setF({ ...f, roleCategory: e.target.value })}>
            <option value="">직책에서 추론</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <label className="label" htmlFor="rstart">
            입사일
          </label>
          <input id="rstart" className="field" type="date" value={f.startedOn} onChange={(e) => setF({ ...f, startedOn: e.target.value })} />
          <label className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" className="size-4" checked={f.decidesFor} onChange={(e) => setF({ ...f, decidesFor: e.target.checked })} />
            이 회사의 구매·계약을 결정할 수 있는 분
          </label>
          {err && (
            <p role="alert" className="text-[12.5px] text-[var(--color-ember)]">
              {err}
            </p>
          )}
          <p className="text-[12px] text-[var(--fg-mute)]">새 현재 소속을 넣으면 기존 현재 소속은 자동으로 닫힙니다.</p>
          <div className="flex gap-2">
            <button className="btn btn-ink !min-h-10" disabled={busy || !f.companyName.trim()}>
              {busy ? "저장 중…" : "저장"}
            </button>
            <button type="button" className="btn btn-ghost !min-h-10" onClick={() => setOpen(false)}>
              취소
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
