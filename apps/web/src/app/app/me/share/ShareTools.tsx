"use client";
// X-001 email signature · X-002 virtual background · X-004 wallet pass · X-007 event poster
import { BG_HEIGHT, BG_WIDTH, type BackgroundStyle, type BgOp, type Signature, backgroundLayout, formatShortCode } from "@linkos/domain";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/client";

const STYLE_LABEL: Record<Signature["style"], string> = { classic: "클래식", compact: "한 줄", pastel: "파스텔" };

async function copyRich(html: string, text: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
      return true;
    }
    await navigator.clipboard.writeText(html);
    return true;
  } catch {
    return false;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function SignatureTool() {
  const [data, setData] = useState<{ link: string; signatures: Signature[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [style, setStyle] = useState<Signature["style"]>("classic");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api("/me/share/signature").then(setData).catch((e) => setError((e as Error).message));
  }, []);
  if (error) return <p role="alert" className="text-[14px] text-[var(--color-ember)]">{error}</p>;
  if (!data) return <p className="text-[14px] text-[var(--fg-mute)]">불러오는 중…</p>;
  const sig = data.signatures.find((s) => s.style === style)!;
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="서명 스타일" className="surface flex p-1">
        {data.signatures.map((s) => (
          <button key={s.style} role="tab" aria-selected={style === s.style} onClick={() => setStyle(s.style)} className={`flex-1 rounded-[16px] py-2 text-[14px] font-semibold transition ${style === s.style ? "bg-[var(--fg)] text-[var(--bg)]" : "text-[var(--fg-mute)]"}`}>
            {STYLE_LABEL[s.style]}
          </button>
        ))}
      </div>
      {/* sandboxed preview: the HTML is fully escaped server-side and inline-styled for mail clients */}
      <iframe title={`${STYLE_LABEL[style]} 서명 미리보기`} sandbox="" srcDoc={`<!doctype html><meta charset="utf-8"><body style="margin:12px;background:#fff">${sig.html}</body>`} className="h-36 w-full rounded-2xl border border-[var(--line)] bg-[var(--bg-elev)]" data-testid="signature-preview" />
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-ink" data-testid="copy-signature-html" onClick={async () => setMsg((await copyRich(sig.html, sig.text)) ? "서명을 복사했어요. 메일 설정의 서명 칸에 붙여넣으세요." : "복사하지 못했어요. 아래 텍스트를 직접 선택해 주세요.")}>
          <Icon name="mail" size={17} /> 서명 복사 (HTML)
        </button>
        <button className="btn btn-ghost" data-testid="copy-signature-text" onClick={async () => setMsg((await copyText(sig.text)) ? "텍스트 서명을 복사했어요." : "복사하지 못했어요.")}>텍스트로 복사</button>
      </div>
      <details className="text-[13px] text-[var(--fg-mute)]">
        <summary className="cursor-pointer">텍스트 서명 보기</summary>
        <pre className="mt-2 whitespace-pre-wrap rounded-2xl bg-[var(--bg-sunk)] p-3 text-[12.5px]" data-testid="signature-text">{sig.text}</pre>
      </details>
      <p className="text-[12.5px] text-[var(--fg-mute)]">카드 링크 <span className="num">{data.link.replace(/^https?:\/\//, "")}</span> — 이 링크로 들어온 방문 수만 인사이트에 집계돼요(방문자 정보는 저장하지 않아요).</p>
      {msg && <p role="status" className="text-[13.5px]">{msg}</p>}
    </div>
  );
}

function draw(ctx: CanvasRenderingContext2D, ops: BgOp[]) {
  for (const op of ops) {
    if (op.kind === "fill") {
      ctx.fillStyle = op.color;
      ctx.fillRect(0, 0, BG_WIDTH, BG_HEIGHT);
    } else if (op.kind === "gradient") {
      const g = ctx.createLinearGradient(op.x0, op.y0, op.x1, op.y1);
      for (const [at, c] of op.stops) g.addColorStop(at, c);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, BG_WIDTH, BG_HEIGHT);
    } else if (op.kind === "blob") {
      const g = ctx.createRadialGradient(op.x, op.y, 0, op.x, op.y, op.r);
      g.addColorStop(0, op.color);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(op.x - op.r, op.y - op.r, op.r * 2, op.r * 2);
    } else {
      ctx.font = `${op.font === "serif" ? "italic " : ""}${op.weight} ${op.size}px ${op.font === "serif" ? '"Instrument Serif", Georgia, serif' : '"Inter Tight", Pretendard, system-ui, sans-serif'}`;
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(op.text, op.x, op.y, 900);
    }
  }
}

export function BackgroundTool() {
  const [data, setData] = useState<{ card: { name: string; jobTitle: string | null; company: string | null; headline: string | null }; link: string } | null>(null);
  const [style, setStyle] = useState<BackgroundStyle>("pastel");
  const [error, setError] = useState<string | null>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    api("/me/share/background").then(setData).catch((e) => setError((e as Error).message));
  }, []);
  const render = async (canvas: HTMLCanvasElement, scale: number) => {
    if (!data) return;
    try {
      await Promise.all([document.fonts?.load('italic 400 96px "Instrument Serif"'), document.fonts?.load('600 40px "Inter Tight"')]);
    } catch {
      /* fonts are optional */
    }
    canvas.width = BG_WIDTH * scale;
    canvas.height = BG_HEIGHT * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(scale, scale);
    const measure = (t: string, s: number) => {
      ctx.font = `600 ${s}px "Inter Tight", Pretendard, sans-serif`;
      return ctx.measureText(t).width;
    };
    draw(ctx, backgroundLayout(data.card, data.link, style, measure));
  };
  useEffect(() => {
    if (preview.current) void render(preview.current, 0.25);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, style]);
  const download = async () => {
    const c = document.createElement("canvas");
    await render(c, 1);
    c.toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `linkos-background-${style}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  };
  if (error) return <p role="alert" className="text-[14px] text-[var(--color-ember)]">{error}</p>;
  return (
    <div className="space-y-3">
      <div className="flex gap-2" role="radiogroup" aria-label="배경 스타일">
        {(["pastel", "dark"] as const).map((s) => (
          <button key={s} role="radio" aria-checked={style === s} onClick={() => setStyle(s)} className={`chip ${style === s ? "!bg-[var(--accent-soft)] !text-[var(--accent-text)]" : ""}`}>
            {s === "pastel" ? "파스텔" : "다크"}
          </button>
        ))}
      </div>
      <canvas ref={preview} aria-label="가상 배경 미리보기" role="img" className="aspect-video w-full rounded-2xl border border-[var(--line)]" data-testid="bg-preview" />
      <button className="btn btn-ink" disabled={!data} onClick={download} data-testid="bg-download">
        <Icon name="download" size={17} /> 1920×1080 PNG 내려받기
      </button>
      <p className="text-[12.5px] text-[var(--fg-mute)]">이 기기에서만 그려져요(서버로 이미지가 전송되지 않아요). 화상회의 앱의 ‘가상 배경’에 올리세요.</p>
    </div>
  );
}

type WalletStatus = { apple: { configured: boolean; missing: string[] }; google: { configured: boolean; missing: string[] } };

export function WalletTool() {
  const [st, setSt] = useState<WalletStatus | null>(null);
  const [google, setGoogle] = useState<{ configured: boolean; saveUrl: string | null } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api<WalletStatus>("/me/wallet").then(setSt).catch((e) => setMsg((e as Error).message));
    api("/me/wallet/google").then(setGoogle).catch(() => undefined);
  }, []);
  if (!st) return <p className="text-[14px] text-[var(--fg-mute)]">{msg ?? "불러오는 중…"}</p>;
  return (
    <div className="space-y-3" data-testid="wallet-tool">
      <div className="surface flex items-start justify-between gap-3 p-4">
        <div>
          <p className="text-[15px] font-semibold">Apple Wallet</p>
          <p className="text-[13px] text-[var(--fg-mute)]">{st.apple.configured ? "내 카드 링크가 담긴 패스를 내려받아요." : "아직 설정되지 않았어요 — 서비스 운영자가 Apple 패스 서명 인증서를 등록하면 쓸 수 있어요."}</p>
        </div>
        {st.apple.configured ? (
          <a className="btn btn-ink shrink-0" href="/api/v1/me/wallet/apple" download>추가</a>
        ) : (
          <span className="chip shrink-0" data-testid="apple-wallet-off">미설정</span>
        )}
      </div>
      <div className="surface flex items-start justify-between gap-3 p-4">
        <div>
          <p className="text-[15px] font-semibold">Google 지갑</p>
          <p className="text-[13px] text-[var(--fg-mute)]">{google?.saveUrl ? "Google 지갑에 저장 링크가 준비됐어요." : "아직 설정되지 않았어요 — Google Wallet 발급자 계정이 연결되면 쓸 수 있어요."}</p>
        </div>
        {google?.saveUrl ? (
          <a className="btn btn-ink shrink-0" href={google.saveUrl} target="_blank" rel="noopener noreferrer">저장</a>
        ) : (
          <span className="chip shrink-0" data-testid="google-wallet-off">미설정</span>
        )}
      </div>
      <p className="text-[12.5px] text-[var(--fg-mute)]">패스에는 교환 상대에게 보이는 정보(비즈니스 공개 범위)만 담겨요. QR은 패스 뒷면의 보조 수단이에요.</p>
    </div>
  );
}

export function PosterTool({ eventId, eventName }: { eventId?: string | null; eventName?: string | null }) {
  const [size, setSize] = useState<"a6" | "a4">("a6");
  const [place, setPlace] = useState(eventName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<{ sessionId: string; shortCode: string | null; expiresAt: string } | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api<{ sessionId: string; shortCode: string | null; expiresAt: string }>("/exchange/sessions", {
        body: { group: true, maxUses: 500, capabilities: { online: true, webShare: false }, context: { ...(place ? { placeLabel: place.slice(0, 120) } : {}), ...(eventId ? { eventId } : {}) } },
        offline: false,
      });
      if (!s.shortCode) throw new Error("단축코드를 만들지 못했어요. 잠시 후 다시 시도하세요.");
      setSession(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex gap-2" role="radiogroup" aria-label="용지 크기">
        {(["a6", "a4"] as const).map((s) => (
          <button key={s} role="radio" aria-checked={size === s} onClick={() => setSize(s)} className={`chip ${size === s ? "!bg-[var(--accent-soft)] !text-[var(--accent-text)]" : ""}`}>
            {s === "a6" ? "A6 테이블 텐트" : "A4 포스터"}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="label">장소·행사 이름 (선택)</span>
        <input className="field mt-1" value={place} maxLength={120} onChange={(e) => setPlace(e.target.value)} placeholder="예: AI EXPO 부스 B-12" />
      </label>
      {!session ? (
        <button className="btn btn-ink" disabled={busy} onClick={create} data-testid="poster-create">
          <Icon name="flag" size={17} /> {busy ? "만드는 중…" : "포스터용 그룹 교환 만들기"}
        </button>
      ) : (
        <div className="surface p-4">
          <p className="eyebrow">포스터 단축코드</p>
          <p className="display num mt-1 text-[44px] tracking-[0.12em]" data-testid="poster-code">{formatShortCode(session.shortCode!)}</p>
          <p className="text-[12.5px] text-[var(--fg-mute)]">유효: {new Date(session.expiresAt).toLocaleString("ko-KR")}까지 · 여러 사람이 같은 코드로 교환할 수 있어요</p>
          <a className="btn btn-signal mt-3" href={`/api/v1/exchange/manage/${session.sessionId}/poster?size=${size}`} download data-testid="poster-download">
            <Icon name="download" size={17} /> PDF 내려받기 ({size.toUpperCase()})
          </a>
        </div>
      )}
      {error && <p role="alert" className="text-[13.5px] text-[var(--color-ember)]">{error}</p>}
      <p className="text-[12.5px] text-[var(--fg-mute)]">포스터에는 큰 단축코드가 주인공이고, QR은 모서리에 작게 들어가는 보조 수단이에요.</p>
    </div>
  );
}
