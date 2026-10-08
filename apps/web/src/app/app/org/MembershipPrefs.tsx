"use client";
// F-134 Who-Knows-Whom 개인 인맥 제외 · F-138 내 카드에 조직 브랜딩 표시 — PATCH /orgs/{id}/members/me (본인 설정만)
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/client";

type Prefs = { graphOptOut: boolean; showBrandingOnCard: boolean };

export function MembershipPrefs({ orgId, initial }: { orgId: string; initial: Prefs }) {
  const [prefs, setPrefs] = useState<Prefs>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (k: keyof Prefs, v: boolean) => {
    const prev = prefs;
    setPrefs({ ...prefs, [k]: v });
    setBusy(true);
    setMsg(null);
    try {
      await api(`/orgs/${orgId}/members/me`, { method: "PATCH", body: { [k]: v } });
      setMsg({ ok: true, text: "저장했어요." });
    } catch (e) {
      setPrefs(prev);
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="surface space-y-3 p-5" aria-labelledby="my-membership" data-testid="membership-prefs">
      <h2 id="my-membership" className="flex items-center gap-2 text-[17px] font-semibold"><Icon name="me" size={19} />내 멤버십 설정</h2>
      <label className="flex items-start gap-3 text-[14.5px]">
        <input type="checkbox" className="mt-0.5 size-5" checked={prefs.graphOptOut} disabled={busy} onChange={(e) => save("graphOptOut", e.target.checked)} />
        <span>
          관계 그래프(Who Knows Whom)에서 내 개인 인맥 제외
          <span className="block text-[12.5px] text-[var(--fg-mute)]">켜면 팀에 공유하지 않은 내 연락처는 ‘누가 아는지’ 검색에 집계되지 않아요.</span>
        </span>
      </label>
      <label className="flex items-start gap-3 text-[14.5px]">
        <input type="checkbox" className="mt-0.5 size-5" checked={prefs.showBrandingOnCard} disabled={busy} onChange={(e) => save("showBrandingOnCard", e.target.checked)} />
        <span>
          내 카드에 조직 브랜딩 표시
          <span className="block text-[12.5px] text-[var(--fg-mute)]">조직이 브랜딩을 켠 경우 내 대표 카드 상단에 조직 로고·색이 보여요.</span>
        </span>
      </label>
      {msg && <p className={`text-[13px] ${msg.ok ? "" : "text-[var(--color-ember)]"}`} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
    </section>
  );
}
