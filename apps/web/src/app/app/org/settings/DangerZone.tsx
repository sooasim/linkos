"use client";
// F-129 조직 삭제 (Owner 전용) — 조직 이름을 그대로 입력해야만 삭제 버튼이 켜진다. 서버도 org.delete 권한을 다시 검사하고 audit_logs 에 남긴다.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/client";

export function DangerZone({ orgId, orgName }: { orgId: string; orgName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const match = typed.trim() === orgName;

  const del = async () => {
    if (!match) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/orgs/${orgId}`, { method: "DELETE" });
      router.replace("/app/org");
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <section className="surface space-y-3 border border-[var(--color-ember)] p-5" aria-labelledby="danger-title" data-testid="org-danger-zone">
      <h2 id="danger-title" className="flex items-center gap-2 text-[17px] font-semibold text-[var(--color-ember)]"><Icon name="trash" size={19} />위험 구역</h2>
      <p className="text-[13.5px] text-[var(--fg-mute)]">
        조직을 삭제하면 멤버십·초대·정책·팀 메모·API 키가 모두 사라지고 되돌릴 수 없습니다. 회사 리드는 현재 담당자의 개인 연락처로 남고, 멤버의 개인 연락처와 개인 메모는 그대로 유지됩니다.
      </p>
      {!open ? (
        <button className="btn btn-ghost !border-[var(--color-ember)] text-[var(--color-ember)]" onClick={() => setOpen(true)}>조직 삭제…</button>
      ) : (
        <div className="space-y-2" role="group" aria-label="조직 삭제 확인">
          <label className="label" htmlFor="org-delete-confirm">확인을 위해 조직 이름 <b>{orgName}</b> 을(를) 그대로 입력하세요</label>
          <input id="org-delete-confirm" className="field" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost !border-[var(--color-ember)] font-semibold text-[var(--color-ember)]" disabled={!match || busy} onClick={del} data-testid="org-delete-confirm">{busy ? "삭제 중…" : "영구 삭제"}</button>
            <button className="btn btn-ghost" onClick={() => { setOpen(false); setTyped(""); setErr(null); }}>취소</button>
          </div>
          {err && <p className="text-[13px] text-[var(--color-ember)]" role="alert">{err}</p>}
        </div>
      )}
    </section>
  );
}
