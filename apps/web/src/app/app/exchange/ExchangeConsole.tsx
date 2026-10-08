"use client";
// Adaptive Handoff Engine client: capability detection → server ladder → auto-advance → QR (final).
// UX-002 교환 시작: 공유 · 받기 · 스캔 · 그룹 교환 (QR is never a start option — only the ladder's last step).
// F-143 현장 교환: an event-tagged session (?event=) files every resulting Encounter under the event.
// F-080 음성 메모: the done card links straight to the new contact's private note box.
import { CHANNEL_LABEL_KO, CHANNEL_TIMEOUT_MS, type Channel } from "@linkos/domain";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { Avatar } from "@/components/Page";
import { Qr } from "@/components/Qr";
import { ReceiveMode } from "@/components/ReceiveMode";
import { ACOUSTIC_EXPERIMENT, acousticSupported, playShortCode } from "@/lib/acoustic";
import { api, uid } from "@/lib/client";
import { NfcTags } from "./NfcTags";

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

function detectCapabilities(peerOnWebScreen: boolean) {
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
    // F-046: the other person opened LINKOS "받기 모드" → server rendezvous (never browser P2P)
    receiverMode: peerOnWebScreen ? ("web_exchange_screen" as const) : ("unknown" as const),
    // F-047 (P3 experiment, flag-gated)
    experimentalAcoustic: ACOUSTIC_EXPERIMENT && acousticSupported(),
  };
}

/** F-046 sender side: enter the 4 digits the receiver reads out, then confirm who it is. */
function RendezvousSender({ session, onFail }: { session: Session; onFail: () => void }) {
  const [code, setCode] = useState("");
  const [match, setMatch] = useState<{ rendezvousId: string; receiverHint: string | null } | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "confirmed">("idle");
  const [error, setError] = useState<string | null>(null);

  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setState("busy");
    try {
      setMatch(await api(`/exchange/manage/${session.sessionId}/rendezvous`, { body: { code } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setState("idle");
    }
  };
  const decide = async (accept: boolean) => {
    if (!match) return;
    setState("busy");
    try {
      await api(`/exchange/manage/${session.sessionId}/rendezvous/confirm`, { body: { rendezvousId: match.rendezvousId, token: session.token, accept } });
      if (accept) setState("confirmed");
      else {
        setMatch(null);
        setCode("");
        setState("idle");
      }
    } catch (err) {
      setError((err as Error).message);
      setMatch(null);
      setState("idle");
    }
  };

  if (state === "confirmed") return <p className="text-center text-[15px] font-semibold">연결했어요 — 상대 화면에 내 카드가 열립니다</p>;
  return (
    <div className="text-center" data-testid="rendezvous-sender">
      {!match ? (
        <form onSubmit={find}>
          <p className="text-[15px] text-[var(--fg-mute)]">상대가 LINKOS 받기 모드에서 불러주는 4자리 숫자를 입력하세요</p>
          <input
            className="num field mt-4 text-center !text-[32px] font-semibold tracking-[0.4em]"
            inputMode="numeric"
            maxLength={4}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            aria-label="상대의 4자리 페어링 코드"
          />
          <button className="btn btn-signal btn-lg mt-3 w-full" disabled={code.length !== 4 || state === "busy"}>
            상대 찾기
          </button>
        </form>
      ) : (
        <div>
          <p className="text-[14px] text-[var(--fg-mute)]">이 사람이 맞나요?</p>
          <p className="mt-1 text-[22px] font-semibold">{match.receiverHint ?? "이름 없는 기기"}</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button onClick={() => decide(false)} className="btn btn-ghost" disabled={state === "busy"}>아니요</button>
            <button onClick={() => decide(true)} className="btn btn-signal" disabled={state === "busy"} data-testid="rendezvous-confirm">맞아요, 보내기</button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[14px] text-[var(--color-ember)]">
          {error} <button onClick={onFail} className="underline">다른 방법</button>
        </p>
      )}
    </div>
  );
}

/** F-047 experiment: play the short code as near-ultrasonic tones for a receiver in "소리로 받기". */
function AcousticSender({ code }: { code: string }) {
  const [state, setState] = useState<"idle" | "playing" | "failed">("idle");
  const play = async () => {
    setState("playing");
    try {
      await playShortCode(code);
      setState("idle");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="text-center">
      <span className="chip">실험 기능</span>
      <p className="mt-2 text-[15px] text-[var(--fg-mute)]">상대가 받기 모드에서 "소리로 받기"를 누르면, 폰을 가까이 두고 재생하세요. 실패하면 단축코드를 불러 주세요.</p>
      <button onClick={play} disabled={state === "playing"} className="btn btn-signal btn-lg mt-4 w-full">
        <Icon name="bolt" size={20} /> {state === "playing" ? "재생 중…" : "소리로 보내기"}
      </button>
      {state === "failed" && <p role="alert" className="mt-2 text-[13px] text-[var(--color-ember)]">이 브라우저에서 재생할 수 없어요.</p>}
    </div>
  );
}

export function ExchangeConsole({ group, name, event = null }: { group: boolean; name: string; event?: { id: string; name: string } | null }) {
  const [session, setSession] = useState<Session | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState("");
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [peerOnWeb, setPeerOnWeb] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const startedAt = useRef(Date.now());

  const start = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const context = { ...(place ? { placeLabel: place } : {}), ...(event ? { eventId: event.id } : {}) };
      const s = await api<Session>("/exchange/sessions", { body: { capabilities: detectCapabilities(peerOnWeb), group, context }, idempotencyKey: uid() });
      setSession(s);
      setChannel(s.channelPlan[0] ?? "qr");
      startedAt.current = Date.now();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [group, place, peerOnWeb, event]);

  // auto-advance timer per channel (F-048)
  useEffect(() => {
    // QR never fails over; rendezvous waits for the user typing the spoken code (they can still tap "다른 방법")
    if (!channel || channel === "qr" || channel === "web_rendezvous") return setDeadline(null);
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

  if (!session && receiving) {
    return (
      <div className="mt-8 animate-rise">
        <ReceiveMode onClose={() => setReceiving(false)} />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="mt-8 space-y-4 animate-rise delay-1">
        {event && (
          <p className="flex flex-wrap items-center gap-2 rounded-2xl bg-[var(--accent-soft)] px-4 py-3 text-[14px]" data-testid="exchange-event-tag">
            <Icon name="flag" size={16} />
            <span className="min-w-0 flex-1">
              <b>{event.name}</b> 행사로 교환해요 — 받은 명함은 이 행사 리드로 모여요
            </span>
            <Link href="/app/exchange" className="text-[13px] font-semibold underline-offset-4 hover:underline">태그 해제</Link>
          </p>
        )}
        <label className="block">
          <span className="label">어디서 만났나요? (선택)</span>
          <input className="field" placeholder={event ? event.name : "예: 코엑스 메디컬 엑스포"} value={place} onChange={(e) => setPlace(e.target.value)} maxLength={120} />
        </label>
        {!group && (
          <label className="flex items-start gap-3 rounded-2xl border border-[var(--line)] p-3 text-[14px]">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={peerOnWeb} onChange={(e) => setPeerOnWeb(e.target.checked)} data-testid="peer-on-web" />
            <span>상대도 LINKOS 교환 화면의 <b>받기 모드</b>를 열었어요 (4자리 코드로 페어링)</span>
          </label>
        )}
        {group ? (
          <>
            <button onClick={start} className="btn btn-signal btn-lg w-full" data-testid="start-exchange">
              <Icon name="exchange" size={20} /> 그룹 교환 링크 만들기
            </button>
            <Link href={event ? `/app/exchange?event=${event.id}` : "/app/exchange"} className="btn btn-ghost w-full">1:1 교환으로 돌아가기</Link>
          </>
        ) : (
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="교환 방법" data-testid="exchange-ctas">
            <button onClick={start} className="btn btn-signal btn-lg col-span-2 w-full" data-testid="start-exchange">
              <Icon name="share" size={20} /> 공유 · 교환 시작
            </button>
            <button onClick={() => setReceiving(true)} className="btn btn-ghost flex-col !gap-1 !py-3" data-testid="receive-mode-start" aria-label="받기 모드 — 상대 화면에서 받기">
              <Icon name="download" size={20} /> <span className="text-[14px]">받기</span>
            </button>
            <Link href="/app/scan" className="btn btn-ghost flex-col !gap-1 !py-3" data-testid="exchange-scan" aria-label="스캔 — 종이 명함 촬영">
              <Icon name="scan" size={20} /> <span className="text-[14px]">스캔</span>
            </Link>
            <Link href={event ? `/app/exchange?group=1&event=${event.id}` : "/app/exchange?group=1"} className="btn btn-ghost col-span-2 w-full" data-testid="exchange-group" aria-label="그룹 교환 — 여러 명과 한 링크로">
              <Icon name="people" size={18} /> 그룹 교환 · 여러 명과 한 링크로
            </Link>
          </div>
        )}
        <p className="text-center text-[12.5px] text-[var(--fg-mute)]">상대는 가입 없이 열어보고 바로 명함을 보낼 수 있어요. 링크는 {group ? "12시간" : "15분"} 후 만료됩니다.</p>
        {error && <p role="alert" className="text-[14px] text-[var(--color-ember)]">{error}</p>}
        <details className="surface p-4">
          <summary className="flex cursor-pointer items-center gap-2 text-[14px] font-semibold">
            <Icon name="nfc" size={16} /> NFC 카드·스티커 관리
          </summary>
          <div className="mt-3">
            <NfcTags />
          </div>
        </details>
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
            <Link key={r.contactId} href={`/app/people/${r.contactId}`} className="mx-auto mt-4 flex max-w-xs items-center gap-3 rounded-2xl bg-[var(--bg-sunk)] p-3 text-left">
              <Avatar name={r.fullName} />
              <span>
                <span className="block font-semibold">{r.fullName}</span>
                <span className="block text-[13px] text-[var(--fg-mute)]">{r.company ?? ""}</span>
              </span>
            </Link>
          ))}
          <p className="mt-4 text-[14px] text-[var(--fg-mute)]">감사 인사 초안을 후속 할 일에 넣어 두었어요.</p>
          {/* F-080: capture the context while it is fresh — opens the new contact's private note box (voice dictation there) */}
          <div className="mx-auto mt-5 flex max-w-xs flex-col gap-2">
            <Link
              href={status!.received[0] ? `/app/people/${status!.received[0].contactId}?voice=1#note` : "/app/people"}
              className="btn btn-ghost w-full"
              data-testid="exchange-voice-note"
            >
              <Icon name="mic" size={18} /> 음성 메모 남기기
            </Link>
            <button onClick={start} className="btn btn-signal w-full">다음 사람과 교환</button>
          </div>
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
              <p className="mt-1 text-[14px] text-[var(--fg-mute)]">태그할 때마다 1회용 교환 링크가 새로 만들어져 상대 브라우저에서 열립니다.</p>
              <details className="mt-4 text-left">
                <summary className="cursor-pointer text-[13px] font-semibold">태그 관리</summary>
                <div className="mt-2">
                  <NfcTags />
                </div>
              </details>
            </div>
          )}

          {channel === "web_rendezvous" && <RendezvousSender session={session} onFail={() => advance("failed", "rendezvous_failed")} />}

          {channel === "acoustic" && session.shortCode && <AcousticSender code={session.shortCode} />}

          {channel === "short_code" && session.shortCode && (
            <div className="text-center">
              <p className="text-[14px] text-[var(--fg-mute)]">상대가 브라우저에서 입력</p>
              <p className="num mt-1 text-[15px] font-semibold">{new URL(session.url).host}/c</p>
              <p className="display num mt-3 text-[72px] tracking-[0.28em]" data-testid="short-code" aria-label={`교환 코드 ${session.shortCode.split("").join(" ")}`}>
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
