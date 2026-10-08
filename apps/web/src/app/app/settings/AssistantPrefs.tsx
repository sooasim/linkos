"use client";
// X-005 prep brief timing · X-006 weekly re-connect digest · X-003 card view analytics opt-out
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

type Prefs = { prepBriefLeadMin: number; reconnectDigest: boolean; reconnectEmail: boolean };

export function AssistantPrefs() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [optOut, setOptOut] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api<Prefs>("/me/assistant-preferences").then(setPrefs).catch((e) => setMsg((e as Error).message));
    api<{ optOut: boolean }>("/me/analytics-preference").then((r) => setOptOut(r.optOut)).catch(() => undefined);
  }, []);
  const save = async (patch: Partial<Prefs>) => {
    setMsg(null);
    try {
      setPrefs(await api<Prefs>("/me/assistant-preferences", { method: "PATCH", body: patch, offline: false }));
      setMsg("저장했어요.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const toggleAnalytics = async (off: boolean) => {
    setMsg(null);
    try {
      const r = await api<{ optOut: boolean; purged: number }>("/me/analytics-preference", { method: "PATCH", body: { optOut: off }, offline: false });
      setOptOut(r.optOut);
      setMsg(r.optOut ? "카드 조회 집계를 껐고, 지금까지의 집계도 삭제했어요." : "카드 조회 집계를 켰어요.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <section id="assistant" className="surface mt-6 p-5" aria-labelledby="assistant-h">
      <h2 id="assistant-h" className="text-[18px] font-semibold">비서 · 알림 · 집계</h2>
      {!prefs ? (
        <p className="mt-3 text-[14px] text-[var(--fg-mute)]">{msg ?? "불러오는 중…"}</p>
      ) : (
        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="label">미팅 전 30초 브리핑</span>
            <select className="field mt-1" value={prefs.prepBriefLeadMin} onChange={(e) => save({ prepBriefLeadMin: Number(e.target.value) })} data-testid="prep-lead">
              <option value={0}>받지 않기</option>
              <option value={10}>10분 전</option>
              <option value={30}>30분 전</option>
              <option value={60}>1시간 전</option>
              <option value={120}>2시간 전</option>
            </select>
            <span className="mt-1 block text-[12.5px] text-[var(--fg-mute)]">확정된 일정에 아는 사람이 있으면 내 기록(마지막 만남·메모·할 일)만으로 브리핑을 보내요. <Link href="/app/brief" className="underline">다가오는 브리핑</Link></span>
          </label>
          <label className="flex items-start gap-3 text-[14.5px]">
            <input type="checkbox" className="mt-0.5 size-5" checked={prefs.reconnectDigest} onChange={(e) => save({ reconnectDigest: e.target.checked })} data-testid="digest-toggle" />
            <span>매주 ‘다시 연락해 볼 3명’ 알림 <span className="block text-[12.5px] text-[var(--fg-mute)]">안부 초안은 저장만 되고 자동으로 보내지 않아요. <Link href="/app/reconnect" className="underline">이번 주 목록</Link></span></span>
          </label>
          <label className="flex items-start gap-3 text-[14.5px]">
            <input type="checkbox" className="mt-0.5 size-5" checked={prefs.reconnectEmail} disabled={!prefs.reconnectDigest} onChange={(e) => save({ reconnectEmail: e.target.checked })} />
            <span>같은 내용을 내 메일로도 받기</span>
          </label>
          {optOut !== null && (
            <label className="flex items-start gap-3 text-[14.5px]">
              <input type="checkbox" className="mt-0.5 size-5" checked={!optOut} onChange={(e) => toggleAnalytics(!e.target.checked)} data-testid="analytics-toggle" />
              <span>내 카드 조회 수 집계 <span className="block text-[12.5px] text-[var(--fg-mute)]">방문자 정보 없이 날짜별 숫자만 셉니다. 끄면 지금까지의 집계도 지워져요.</span></span>
            </label>
          )}
        </div>
      )}
      {msg && prefs && <p role="status" className="mt-3 text-[13.5px]">{msg}</p>}
    </section>
  );
}
