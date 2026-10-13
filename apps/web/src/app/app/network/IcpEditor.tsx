"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/client";

// N-110 Ideal Customer Profile. 교차 소개 가능성을 계산하려면 "내가 찾는 고객"이 먼저 정의되어야 한다.
// 사용자가 직접 고르는 값이다 — AI 가 추측하지 않는다.

interface Icp {
  industries: string[];
  regions: string[];
  roleCategories: string[];
  needs: string[];
}
interface Options {
  industries: string[];
  regions: string[];
  roleCategories: string[];
}

const FIELDS: { key: keyof Omit<Icp, "needs">; label: string; help: string }[] = [
  { key: "industries", label: "어떤 산업의 고객인가요", help: "여러 개 고를 수 있습니다" },
  { key: "regions", label: "어느 지역인가요", help: "" },
  { key: "roleCategories", label: "누가 결정하나요", help: "구매를 결정하는 역할" },
];

export function IcpEditor({ onSaved }: { onSaved: () => void }) {
  const [icp, setIcp] = useState<Icp>({ industries: [], regions: [], roleCategories: [], needs: [] });
  const [options, setOptions] = useState<Options | null>(null);
  const [needText, setNeedText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ icp: Icp | null; options: Options }>("/network-intel/icp").then((r) => {
      setOptions(r.options);
      if (r.icp) setIcp({ industries: r.icp.industries, regions: r.icp.regions, roleCategories: r.icp.roleCategories, needs: r.icp.needs });
    });
  }, []);

  if (!options) return <div className="h-48 animate-pulse rounded-3xl border border-[var(--line)]" />;

  const toggle = (key: keyof Omit<Icp, "needs">, value: string) => {
    setIcp((prev) => ({ ...prev, [key]: prev[key].includes(value) ? prev[key].filter((v) => v !== value) : [...prev[key], value] }));
  };
  const filled = icp.industries.length + icp.regions.length + icp.roleCategories.length + icp.needs.length > 0;

  return (
    <form
      className="space-y-5 rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)] p-4 sm:p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api("/network-intel/icp", { method: "PUT", body: icp });
          onSaved();
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <h2 className="text-[16px] font-semibold">내 고객상 (ICP)</h2>
        <p className="mt-1 text-[13px] text-[var(--fg-mute)]">이 조건을 가진 분을 이미 알고 있는 사람을 찾아, 서로 소개해 줄 수 있는지 계산합니다.</p>
      </div>

      {FIELDS.map((f) => (
        <fieldset key={f.key}>
          <legend className="label">
            {f.label}
            {f.help && <span className="ml-1 font-normal opacity-70">— {f.help}</span>}
          </legend>
          <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
            {options[f.key].map((v) => {
              const on = icp[f.key].includes(v);
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(f.key, v)}
                  className={`chip ${on ? "!border-[var(--accent)] !bg-[var(--accent-soft)] !text-[var(--accent-text)]" : ""}`}
                >
                  {on && <Icon name="check" size={13} aria-hidden />}
                  {v}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      <fieldset>
        <legend className="label">그 고객은 보통 무엇이 필요한가요</legend>
        <div className="flex gap-2">
          <input
            className="field"
            value={needText}
            onChange={(e) => setNeedText(e.target.value)}
            placeholder="예: 의료기기 조달, 인허가 컨설팅"
            aria-label="고객의 Need 추가"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const v = needText.trim();
                if (v && !icp.needs.includes(v)) setIcp({ ...icp, needs: [...icp.needs, v] });
                setNeedText("");
              }
            }}
          />
          <button
            type="button"
            className="btn btn-ghost !min-h-[52px] !px-4"
            onClick={() => {
              const v = needText.trim();
              if (v && !icp.needs.includes(v)) setIcp({ ...icp, needs: [...icp.needs, v] });
              setNeedText("");
            }}
          >
            추가
          </button>
        </div>
        {icp.needs.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {icp.needs.map((n) => (
              <button key={n} type="button" className="chip" onClick={() => setIcp({ ...icp, needs: icp.needs.filter((x) => x !== n) })} aria-label={`${n} 제거`}>
                {n}
                <Icon name="x" size={13} aria-hidden />
              </button>
            ))}
          </div>
        )}
      </fieldset>

      <button className="btn btn-signal" disabled={busy || !filled}>
        {busy ? "저장 중…" : "저장하고 파트너 찾기"}
      </button>
    </form>
  );
}
