"use client";
import { startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { api, relTime } from "@/lib/client";

// F-006 Passkey management · F-064 referral link (+ F-197 experimental reward ledger)
export function AccountExtras() {
  const [keys, setKeys] = useState<any[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [ref, setRef] = useState<any>(null);
  const load = () => api<{ passkeys: any[] }>("/me/passkeys").then((r) => setKeys(r.passkeys));
  useEffect(() => {
    load();
    api("/referrals").then(setRef).catch(() => undefined);
  }, []);
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;

  const add = async () => {
    setMsg(null);
    try {
      const options = await api("/auth/passkey/register/options", { body: {} });
      const response = await startRegistration({ optionsJSON: options });
      await api("/auth/passkey/register/verify", { body: { response, name: navigator.userAgent.includes("iPhone") ? "iPhone" : navigator.platform || "이 기기" } });
      setMsg("패스키를 등록했어요. 다음부터 비밀번호·코드 없이 로그인할 수 있습니다.");
      load();
    } catch (e) {
      setMsg((e as Error).name === "NotAllowedError" ? "패스키 등록이 취소되었습니다." : (e as Error).message);
    }
  };

  return (
    <div className="mt-5 space-y-5">
      <section className="surface space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Icon name="lock" size={19} />패스키</h2>
        <p className="text-[13.5px] text-[var(--fg-mute)]">Face ID·지문·화면 잠금으로 로그인합니다. 생체 정보는 기기를 떠나지 않아요.</p>
        <ul className="divide-y divide-[var(--line)] text-[14px]">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between py-2">
              <span>{k.name ?? "패스키"} <span className="text-[var(--fg-mute)]">· {k.backed_up ? "동기화됨" : "이 기기 전용"} · {k.last_used_at ? `최근 사용 ${relTime(k.last_used_at)}` : `등록 ${relTime(k.created_at)}`}</span></span>
              <button className="btn btn-ghost !min-h-8 !px-2" aria-label="패스키 삭제" onClick={async () => { await api(`/me/passkeys/${k.id}`, { method: "DELETE" }); load(); }}><Icon name="trash" size={16} /></button>
            </li>
          ))}
        </ul>
        {supported ? <button className="btn btn-ink" onClick={add}><Icon name="plus" size={16} />패스키 추가</button> : <p className="text-[13px] text-[var(--fg-mute)]">이 브라우저는 패스키를 지원하지 않습니다.</p>}
        {msg && <p role="status" className="text-[14px]">{msg}</p>}
      </section>

      {ref && (
        <section className="surface space-y-3 p-5">
          <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Icon name="share" size={19} />추천 링크</h2>
          <div className="flex items-center gap-2 rounded-2xl border border-dashed border-[var(--line)] p-3 text-[13px]">
            <code className="min-w-0 flex-1 truncate">{ref.link}</code>
            <button className="btn btn-ink !min-h-8 text-[12px]" onClick={() => navigator.clipboard?.writeText(ref.link)}>복사</button>
          </div>
          <p className="text-[13.5px]">내 링크·명함 교환·초대로 가입한 사람 <b className="num">{ref.total}</b>명</p>
          <p className="text-[12.5px] text-[var(--fg-mute)]">누가 가입했는지는 이름만 보이며 연락처 등 개인정보는 기록하지 않습니다.</p>
          {ref.rewards.enabled && <p className="text-[13px]">리워드(실험): 지급 {ref.rewards.granted}P · 대기 {ref.rewards.pending}P</p>}
        </section>
      )}
    </div>
  );
}
