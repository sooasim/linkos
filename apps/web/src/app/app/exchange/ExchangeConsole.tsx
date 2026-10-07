"use client";
// Adaptive Handoff Engine client: capability detection → server ladder → auto-advance → QR (final).
import { CHANNEL_LABEL_KO, CHANNEL_TIMEOUT_MS, type Channel } from "@linkos/domain";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { Avatar } from "@/components/Page";
import { Qr } from "@/components/Qr";
import { api, uid } from "@/lib/client";

interface Session {
  sessionId: string;
  token: string;
  url: string;
  shortCode: string | null;
  shortUrl: string | null;
  channelPlan: Channel[];
  expiresAt: string;
}
interface Status {
  state: string;
  receiverOpenedAt: string | null;
  useCount: number;
  isGroup: boolean;
  received: { contactId: string; fullName: string; company: string | null }[];
}

const CH_ICON: Record<Channel, IconName> = { ble_proximity: "bolt", os_share: "share", nfc_accessory: "nfc", short_code: "code", web_rendezvous: "link", acoustic: "bolt", local_receipt: "lock", qr: "qr" };

function detectCapabilities() {
  const nav = navigator as Navigator & { share?: unknown };
  let nfc = false;
  try {
    nfc = localStorage.getItem("lk_nfc_accessory") === "1";
  } catch {
    /* ignore */
  }
  return {
    installedApp: false, // web/PWA: no native BLE — never claim browser P2P
    nativeBle: false,
    receiverHasApp: null,
    webShare: typeof nav.share === "function",
    appClipEntry: false,
    nfcAccessoryEnabled: nfc,
    camera: !!navigator.mediaDevices,
    online: navigator.onLine,
    pwaInstalled: window.matchMedia?.("(display-mode: standalone)").matches ?? false,
    receiverMode: "unknown" as const,
  };
}

export function ExchangeConsole({ group, name }: { group: boolean; name: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState("");
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const startedAt = useRef(Date.now());

  const start = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const s = await api<Session>("/exchange/sessions", { body: { capabilities: detectCapabilities(), group, context: place ? { placeLabel: place } : {} }, idempotencyKey: uid() });
      setSession(s);
      setChannel(s.channelPlan[0] ?? "qr");
      startedAt.current = Date.now();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [group, place]);

  // auto-advance timer per channel (F-048)
  useEffect(() => {
    if (!channel || channel === "qr") return setDeadline(null);
    setDeadline(Date.now() + CHANNEL_TIMEOUT_MS[channel]);
  }, [channel]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const opened = !!status?.receiverOpenedAt;
  const advance = useCallback(
    async (outcome: "failed" | "cancelled" | "timeout" | "unsupported", reason?: string) => {
      if (!session || !channel) return;
      const latency = Date.now() - startedAt.current;
      const r = await api<{ nextChannel: Channel | null }>(`/exchange/manage/${session.sessionId}/attempts`, { body: { channel, outcome, latencyMs: latency, reason } }).catch(() => ({ nextChannel: null }));
      const plan = session.channelPlan;
      setChannel(r.nextChannel ?? plan[plan.indexOf(channel) + 1] ?? "qr");
      startedAt.current = Date.now();
    },
    [session, channel],
  );

  useEffect(() => {
    if (deadline && now > deadline && !opened) void advance("timeout");
  }, [now, deadline, opened, advance]);

  // live status via SSE (fallback: polling)
  useEffect(() => {
    if (!session) return;
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const apply = (s: Status) => setStatus(s);
    if ("EventSource" in window) {
      es = new EventSource(`/api/v1/exchange/manage/${session.sessionId}/events`);
      es.addEventListener("status", (e) => apply(JSON.parse((e as MessageEvent).data)));
      es.onerror = () => {
        es?.close();
        poll = setInterval(() => api<Status>(`/exchange/manage/${session.sessionId}`).then(apply).catch(() => undefined), 2000);
      };
    }
    return () => {
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, [session]);

  const share = async () => {
    if (!session) return;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (!nav.share) return advance("unsupported");
    try {
      await nav.share({ title: `${name}님의 명함`, text: `${name}님이 LINKOS 명함을 보냈어요. 가입 없이 열어보고 내 명함도 보낼 수 있어요.`, url: session.url });
      await api(`/exchange/manage/${session.sessionId}/attempts`, { body: { channel: "os_share", outcome: "success", latencyMs: Date.now() - startedAt.current } });
    } catch (e) {
      await advance((e as Error).name === "AbortError" ? "cancelled" : "failed");
    }
  };

  const copy = async () => {
    if (!session) return;
    await navigator.clipboard?.writeText(session.url).catch(() => undefined);
  };

  const revoke = async () => {
    if (!session) return;
    await api(`/exchange/manage/${session.sessionId}`, { method: "DELETE" }).catch(() => undefined);
    setSession(null);
    setChannel(null);
    setStatus(null);
  };

  const done = status && ["EXCHANGED", "CLAIM_PENDING", "CLAIMED", "SYNCED"].includes(status.state);
  const remaining = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;

  if (!session) {
    return (
      <div className="mt-8 space-y-4 animate-rise delay-1">
        <label className="block">
          <span className="label">어디서 만났나요? (선택)</span>
          <input className="field" placeholder="예: 코엑스 메디컬 엑스포" value={place} onChange={(e) => setPlace(e.target.value)} maxLength={120} />
        </label>
        <button onClick={start} className="btn btn-signal btn-lg w-full" data-testid="start-exchange">
          <Icon name="exchange" size={20} /> {group ? "그룹 교환 링크 만들기" : "교환 시작"}
        </button>
        <p className="text-center text-[12.5px] text-[var(--fg-mute)]">상대는 가입 없이 열어보고 바로 명함을 보낼 수 있어요. 링크는 {group ? "12시간" : "15분"} 후 만료됩니다.</p>
        {error && <p role="alert" className="text-[14px] text-[var(--color-ember)]">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-5">
      {/* Ladder */}
      <ol className="flex items-center gap-1.5" aria-label="교환 채널 순서">
        {session.channelPlan.map((c, i) => {
          const idx = session.channelPlan.indexOf(channel ?? "qr");
          const state = i < idx ? "past" : i === idx ? "now" : "next";
          return (
            <li key={c} className="flex flex-1 items-center gap-1.5">
              <span className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full text-[12px] font-semibold transition ${state === "now" ? "bg-[var(--fg)] text-[var(--bg)]" : state === "past" ? "text-[var(--fg-mute)] line-through" : "border border-[var(--line)] text-[var(--fg-mute)]"}`}>
                <Icon name={CH_ICON[c]} size={14} />
                <span className="hidden sm:inline">{CHANNEL_LABEL_KO[c]}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {done ? (
        <section className="stage-ink grain rounded-[28px] p-6 text-center animate-rise" aria-live="polite" data-testid="exchange-done">
          <span className="mx-auto grid size-16 place-items-center rounded-full bg-[var(--color-signal)] text-[var(--color-ink)]">
            <Icon name="check" size={30} strokeWidth={2.6} />
          </span>
          <h2 className="display mt-4 text-[40px]">교환 완료</h2>
          {status!.received.slice(0, 1).map((r) => (
            <Link key={r.contactId} href={`/app/people/${r.contactId}`} className="mx-auto mt-4 flex max-w-xs items-center gap-3 rounded-2xl bg-white/5 p-3 text-left">
              <Avatar name={r.fullName} />
              <span>
                <span className="block font-semibold">{r.fullName}</span>
                <span className="block text-[13px] text-[var(--fg-mute)]">{r.company ?? ""}</span>
              </span>
            </Link>
          ))}
          <p className="mt-4 text-[14px] text-[var(--fg-mute)]">감사 인사 초안을 후속 할 일에 넣어 두었어요.</p>
          <button onClick={start} className="btn btn-signal mt-5">다음 사람과 교환</button>
        </section>
      ) : (
        <section className="surface p-5 animate-rise" aria-live="polite">
          {opened && (
            <p className="mb-4 flex items-center gap-2 rounded-full bg-[var(--color-signal)]/25 px-3 py-1.5 text-[13px] font-semibold">
              <span className="relative grid size-2.5 place-items-center">
                <span className="absolute size-2.5 rounded-full bg-[var(--color-signal-deep)] animate-pulse-ring" />
                <span className="size-2.5 rounded-full bg-[var(--color-signal-deep)]" />
              </span>
              상대가 카드를 열었어요 — 회신을 기다리는 중
            </p>
          )}

          {channel === "os_share" && (
            <div className="text-center">
              <p className="text-[15px] text-[var(--fg-mute)]">AirDrop · Quick Share · 메시지 등 기기가 지원하는 방법으로 보내세요.</p>
              <button onClick={share} className="btn btn-signal btn-lg mt-4 w-full" data-testid="os-share">
                <Icon name="share" size={20} /> 공유 시트 열기
              </button>
            </div>
          )}

          {channel === "nfc_accessory" && (
            <div className="text-center">
              <Icon name="nfc" size={40} className="mx-auto" />
              <p className="mt-3 text-[16px] font-semibold">NFC 카드를 상대 폰 뒷면에 대세요</p>
              <p className="mt-1 text-[14px] text-[var(--fg-mute)]">카드에 기록된 내 Living Card 링크가 상대 브라우저에서 열립니다.</p>
            </div>
          )}

          {channel === "short_code" && session.shortCode && (
            <div className="text-center">
              <p className="text-[14px] text-[var(--fg-mute)]">상대가 브라우저에서 입력</p>
              <p className="num mt-1 text-[15px] font-semibold">{new URL(session.url).host}/c</p>
              <p className="display num mt-3 text-[64px] tracking-[0.12em]" data-testid="short-code" aria-label={`교환 코드 ${session.shortCode.split("").join(" ")}`}>
                {session.shortCode}
              </p>
            </div>
          )}

          {channel === "qr" && (
            <div className="flex flex-col items-center text-center" data-testid="qr-fallback">
              <Qr value={session.url} size={232} />
              <p className="mt-3 text-[14px] text-[var(--fg-mute)]">카메라로 스캔하면 바로 열립니다</p>
            </div>
          )}

          <div className="mt-5 flex items-center justify-between gap-2 text-[13px] text-[var(--fg-mute)]">
            {channel !== "qr" ? (
              <button onClick={() => advance("cancelled", "user_skip")} className="font-semibold underline-offset-4 hover:underline" data-testid="next-channel">
                다른 방법 {remaining !== null && !opened ? `· ${remaining}s` : ""}
              </button>
            ) : (
              <span>최종 폴백 · QR</span>
            )}
            <span className="flex gap-3">
              <button onClick={copy} className="hover:text-[var(--fg)]">링크 복사</button>
              <button onClick={revoke} className="hover:text-[var(--color-ember)]">취소</button>
            </span>
          </div>
        </section>
      )}

      {group && status && status.received.length > 0 && (
        <section>
          <h3 className="mb-2 text-[15px] font-semibold">받은 명함 {status.useCount}</h3>
          <ul className="space-y-2">
            {status.received.map((r) => (
              <li key={r.contactId}>
                <Link href={`/app/people/${r.contactId}`} className="surface flex items-center gap-3 p-3">
                  <Avatar name={r.fullName} size={36} />
                  <span className="font-medium">{r.fullName}</span>
                  <span className="text-[13px] text-[var(--fg-mute)]">{r.company}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
