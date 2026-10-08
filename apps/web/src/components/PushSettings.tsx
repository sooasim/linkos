"use client";
// F-110 Web Push — 이 기기 알림 켜기/끄기, 종류별 설정, 테스트, 최근 발송 기록(상태·사유). (iOS는 홈 화면에 설치한 PWA에서만 지원)
import { useEffect, useState } from "react";
import { api, relTime } from "@/lib/client";

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

interface PushLog {
  id: string;
  kind: string;
  title: string;
  status: "queued" | "sending" | "sent" | "skipped" | "failed";
  reason: string | null;
  created_at: string;
  sent_at: string | null;
}
const STATUS_KO: Record<PushLog["status"], string> = { queued: "대기", sending: "보내는 중", sent: "보냄", skipped: "건너뜀", failed: "실패" };
const REASON_KO: Record<string, string> = {
  vapid_not_configured: "서버에 푸시가 설정되지 않음",
  no_subscription: "알림을 켠 기기 없음",
  preference_off: "알림 설정에서 꺼 둠",
};
function reasonText(r: string | null): string {
  if (!r) return "";
  if (REASON_KO[r]) return REASON_KO[r];
  const m = /^push_(\d{3}|error)$/.exec(r);
  if (m) return m[1] === "410" || m[1] === "404" ? "기기 구독이 만료됨 (다시 켜 주세요)" : m[1] === "error" ? "푸시 서비스에 연결하지 못함" : `푸시 서비스 오류 (HTTP ${m[1]})`;
  return r;
}

/** Recent push deliveries (GET /push/notifications) — shown even when push is off so "why didn't I get it?" has an answer. */
function PushHistory() {
  const [list, setList] = useState<PushLog[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    api<{ notifications: PushLog[] }>("/push/notifications").then((r) => setList(r.notifications)).catch(() => { setErr(true); setList([]); });
  }, []);
  if (list === null) return null;
  return (
    <div className="space-y-1.5" data-testid="push-history">
      <p className="label">최근 알림 기록</p>
      {err ? (
        <p className="text-[13px] text-[var(--color-ember)]" role="alert">알림 기록을 불러오지 못했어요.</p>
      ) : list.length === 0 ? (
        <p className="text-[13px] text-[var(--fg-mute)]">아직 보낸 알림이 없어요.</p>
      ) : (
        <ul className="max-h-64 divide-y divide-[var(--line)] overflow-y-auto text-[13.5px]">
          {list.slice(0, 20).map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-3 py-1.5">
              <span className="min-w-0">
                <span className="block truncate">{n.title}</span>
                {n.status !== "sent" && n.reason && <span className="block text-[12px] text-[var(--fg-mute)]">{reasonText(n.reason)}</span>}
              </span>
              <span className="shrink-0 text-right text-[12px] text-[var(--fg-mute)]">
                <span className={`chip !py-0 text-[11.5px] ${n.status === "failed" ? "!text-[var(--color-ember)]" : ""}`}>{STATUS_KO[n.status] ?? n.status}</span>
                <span className="block">{relTime(n.sent_at ?? n.created_at)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PushSettings() {
  const [cfg, setCfg] = useState<{ enabled: boolean; publicKey: string | null; subscriptions: any[]; preferences: { pushFollowups: boolean; pushScheduling: boolean } } | null>(null);
  const [supported, setSupported] = useState(true);
  const [here, setHere] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api("/push").then(setCfg).catch(() => undefined);
  useEffect(() => {
    load();
    const ok = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    setSupported(ok);
    if (ok) navigator.serviceWorker.getRegistration("/").then((r) => r?.pushManager.getSubscription()).then((s) => setHere(s?.endpoint ?? null)).catch(() => undefined);
  }, []);

  const enable = async () => {
    if (!cfg?.publicKey) return;
    setBusy(true);
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("브라우저 알림 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.");
      const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.publicKey) }));
      const j = sub.toJSON();
      await api("/push/subscriptions", { body: { endpoint: j.endpoint, keys: j.keys } });
      setHere(sub.endpoint);
      setMsg("이 기기에서 알림을 받아요.");
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await api("/push/subscriptions", { method: "DELETE", body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      setHere(null);
      load();
    } finally {
      setBusy(false);
    }
  };
  const pref = (k: "pushFollowups" | "pushScheduling", v: boolean) => api("/push/preferences", { method: "PATCH", body: { [k]: v } }).then(setCfg);

  if (!cfg) return null;
  if (!cfg.enabled)
    return (
      <div className="space-y-3">
        <p className="text-[14px] text-[var(--fg-mute)]">서버에 Web Push(VAPID 키)가 설정되지 않았습니다.</p>
        <PushHistory />
      </div>
    );
  if (!supported)
    return (
      <div className="space-y-3">
        <p className="text-[14px] text-[var(--fg-mute)]">이 브라우저는 웹 푸시를 지원하지 않아요. iPhone은 Safari에서 ‘홈 화면에 추가’한 LINKOS 앱에서 켤 수 있어요.</p>
        <PushHistory />
      </div>
    );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {here ? <button className="btn btn-ghost" disabled={busy} onClick={disable}>이 기기 알림 끄기</button> : <button className="btn btn-ink" disabled={busy} onClick={enable}>이 기기에서 알림 받기</button>}
        {here && <button className="btn btn-ghost" onClick={() => api<{ sent: number }>("/push/test", { body: {} }).then((r) => setMsg(r.sent ? "테스트 알림을 보냈어요." : "전송하지 못했어요.")).catch((e) => setMsg((e as Error).message))}>테스트</button>}
      </div>
      <label className="flex items-center gap-3 text-[14.5px]"><input type="checkbox" className="size-5" checked={cfg.preferences.pushFollowups} onChange={(e) => pref("pushFollowups", e.target.checked)} />후속 할 일 리마인더</label>
      <label className="flex items-center gap-3 text-[14.5px]"><input type="checkbox" className="size-5" checked={cfg.preferences.pushScheduling} onChange={(e) => pref("pushScheduling", e.target.checked)} />예약 요청 · 미팅 요청</label>
      <p className="text-[12.5px] text-[var(--fg-mute)]">알림을 받는 기기 {cfg.subscriptions.length}대</p>
      {msg && <p className="text-[13.5px]" role="status">{msg}</p>}
      <PushHistory />
    </div>
  );
}
