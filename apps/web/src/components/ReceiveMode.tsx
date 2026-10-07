"use client";
// F-046 웹-웹 페어링 — 받는 사람 "받기 모드". 서버 rendezvous: 4자리 코드를 소리 내어 알려주면 보내는 사람이 입력·확인한다.
// 브라우저끼리 직접(NFC/Bluetooth) 연결하지 않는다. (F-047 실험: 소리로 단축코드 받기)
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { ACOUSTIC_EXPERIMENT, acousticSupported, listenForShortCode } from "@/lib/acoustic";
import { api } from "@/lib/client";

interface Poll {
  status: "waiting" | "matched" | "confirmed" | "rejected" | "expired";
  code: string;
  expiresAt: string;
  senderName: string | null;
  url: string | null;
}

export function ReceiveMode({ onClose }: { onClose?: () => void }) {
  const [listen, setListen] = useState<{ listenToken: string; code: string; expiresAt: string } | null>(null);
  const [poll, setPoll] = useState<Poll | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hearing, setHearing] = useState<"idle" | "listening" | "none">("idle");
  const [now, setNow] = useState(Date.now());
  const abort = useRef<AbortController | null>(null);

  const start = useCallback(async () => {
    setError(null);
    setPoll(null);
    try {
      setListen(await api("/exchange/rendezvous", { body: {} }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    if (!listen) return;
    let stopped = false;
    const tick = async () => {
      try {
        const p = await api<Poll>(`/exchange/rendezvous/${encodeURIComponent(listen.listenToken)}`);
        if (stopped) return;
        setPoll(p);
        if (p.url) {
          window.location.assign(p.url);
          return;
        }
        if (p.status === "expired" || p.status === "rejected") return;
      } catch {
        /* transient; keep polling */
      }
      if (!stopped) timer = setTimeout(tick, 1000);
    };
    let timer = setTimeout(tick, 600);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [listen]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const cancel = async () => {
    abort.current?.abort();
    if (listen) await api(`/exchange/rendezvous/${encodeURIComponent(listen.listenToken)}`, { method: "DELETE" }).catch(() => undefined);
    onClose?.();
  };

  const hear = async () => {
    setHearing("listening");
    abort.current = new AbortController();
    try {
      const code = await listenForShortCode(6, abort.current.signal);
      if (code) window.location.assign(`/c/${code}`);
      else setHearing("none");
    } catch {
      setHearing("none");
    }
  };

  const status = poll?.status ?? "waiting";
  const left = listen ? Math.max(0, Math.ceil((new Date(listen.expiresAt).getTime() - now) / 1000)) : 0;

  return (
    <section className="surface p-5 text-center" aria-live="polite" data-testid="receive-mode">
      <p className="eyebrow">받기 모드 · 웹 페어링</p>
      {error && <p role="alert" className="mt-3 text-[14px] text-[var(--color-ember)]">{error}</p>}
      {listen && (status === "waiting" || status === "matched") && (
        <>
          <p className="mt-3 text-[15px] text-[var(--fg-mute)]">보내는 사람에게 이 숫자를 불러 주세요</p>
          <p className="display num mt-2 text-[72px] tracking-[0.18em]" data-testid="rendezvous-code" aria-label={`페어링 코드 ${listen.code.split("").join(" ")}`}>
            {listen.code}
          </p>
          {status === "matched" ? (
            <p className="mt-2 rounded-full bg-[var(--color-signal)]/25 px-3 py-1.5 text-[14px] font-semibold">
              {poll?.senderName ?? "상대"}님이 연결을 확인하는 중…
            </p>
          ) : (
            <p className="mt-2 text-[13px] text-[var(--fg-mute)]">{left}초 동안 유효 · 상대가 확인하면 명함이 바로 열려요</p>
          )}
        </>
      )}
      {(status === "expired" || status === "rejected") && (
        <div className="mt-3">
          <p className="text-[15px]">{status === "expired" ? "시간이 지났어요." : "상대가 연결을 거절했어요."}</p>
          <button onClick={start} className="btn btn-signal mt-3">새 코드 받기</button>
        </div>
      )}
      {ACOUSTIC_EXPERIMENT && acousticSupported() && (
        <div className="mt-5 border-t border-[var(--line)] pt-4">
          <span className="chip">실험 기능</span>
          <button onClick={hear} disabled={hearing === "listening"} className="btn btn-ghost mt-2 w-full">
            <Icon name="mic" size={18} /> {hearing === "listening" ? "듣는 중… 상대 폰을 가까이" : "소리로 단축코드 받기"}
          </button>
          {hearing === "none" && <p className="mt-2 text-[13px] text-[var(--fg-mute)]">신호를 못 들었어요. 코드를 직접 입력하거나 다시 시도하세요.</p>}
        </div>
      )}
      <button onClick={cancel} className="mt-4 text-[13px] text-[var(--fg-mute)] underline-offset-4 hover:underline">받기 모드 끄기</button>
    </section>
  );
}
