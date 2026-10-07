"use client";
// F-036 Action Card CTAs — 예약/견적/제안/NDA 요청. 로그인 없이 사용 가능, 명시적 동의 필요, 서버에서 rate limit.
import Link from "next/link";
import { useState } from "react";
import type { ResolvedGlyph } from "@linkos/domain/cardDesign";
import { api, uid } from "@/lib/client";
import { Glyph } from "./cardTemplates/Glyph";
import { Icon } from "./Icon";

/** glyph: owner-chosen icon/emoji (F-021), resolved server-side so no icon bank ships here */
export type CardAction = { kind: "booking" | "quote" | "proposal" | "nda"; label: string; url: string | null; glyph?: ResolvedGlyph | null };

const HINT: Record<CardAction["kind"], string> = {
  booking: "가능한 시간대를 알려주세요",
  quote: "필요한 수량·사양·예산을 알려주세요",
  proposal: "제안받고 싶은 범위를 알려주세요",
  nda: "NDA가 필요한 프로젝트를 간단히 알려주세요",
};

export function ActionCtas({ profileId, ownerName, actions, tone = "ink" }: { profileId: string; ownerName: string; actions: CardAction[]; tone?: "ink" | "paper" }) {
  const [open, setOpen] = useState<CardAction | null>(null);
  const [f, setF] = useState({ name: "", email: "", company: "", message: "", when: "", website: "" });
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!actions.length) return null;

  const submit = async () => {
    if (!open) return;
    setState("sending");
    setError(null);
    try {
      await api(`/cards/${profileId}/actions`, {
        body: {
          kind: open.kind,
          name: f.name,
          email: f.email,
          company: f.company || null,
          message: f.message || null,
          details: open.kind === "booking" && f.when ? { preferredTimes: [f.when] } : {},
          consent: true,
          ...(f.website ? { website: f.website } : {}),
        },
        idempotencyKey: uid(),
      });
      setState("sent");
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  };

  return (
    <section className="mt-6" aria-labelledby="actions-h">
      <h2 id="actions-h" className="eyebrow">{ownerName}님에게 요청하기</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {actions.map((a) =>
          a.kind === "booking" && a.url ? (
            <a key={a.kind} href={a.url} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">
              {a.glyph ? <Glyph glyph={a.glyph} size={18} /> : <Icon name="calendar" size={18} />} {a.label}
            </a>
          ) : (
            <button key={a.kind} type="button" aria-expanded={open?.kind === a.kind} className="btn btn-ghost" onClick={() => { setOpen(open?.kind === a.kind ? null : a); setState("idle"); }}>
              {a.glyph ? <Glyph glyph={a.glyph} size={18} /> : <Icon name={a.kind === "booking" ? "calendar" : a.kind === "nda" ? "lock" : "mail"} size={18} />} {a.label}
            </button>
          ),
        )}
      </div>
      {open && state === "sent" && (
        <p role="status" className="mt-3 rounded-2xl border border-[var(--line)] p-4 text-[14px]">
          <Icon name="check" size={16} /> {open.label}을 보냈어요. {ownerName}님이 이메일로 답할 거예요.
        </p>
      )}
      {open && state !== "sent" && (
        <form
          className={`mt-3 space-y-2 rounded-3xl border border-[var(--line)] p-4 ${tone === "paper" ? "bg-[var(--color-paper)] text-[var(--color-ink)]" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="text-[14px] font-semibold">{open.label}</p>
          <input className="field" required maxLength={80} placeholder="이름 *" aria-label="이름" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className="field" required type="email" maxLength={200} placeholder="이메일 * (답장 받을 주소)" aria-label="이메일" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <input className="field" maxLength={120} placeholder="회사" aria-label="회사" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
          {open.kind === "booking" && <input className="field" maxLength={80} placeholder="희망 시간 (예: 다음 주 화 오후)" aria-label="희망 시간" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} />}
          <textarea className="field min-h-20" maxLength={2000} placeholder={HINT[open.kind]} aria-label="내용" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} />
          {/* honeypot for bots — hidden from people and assistive tech */}
          <input tabIndex={-1} autoComplete="off" aria-hidden className="hidden" name="website" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />
          <label className="flex items-start gap-3 text-[13.5px] leading-relaxed">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--color-signal)]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              입력한 정보를 {ownerName}님에게 전달하는 데 동의합니다. <Link href="/legal/privacy" className="underline">개인정보 처리방침</Link>
            </span>
          </label>
          {error && <p role="alert" className="text-[13.5px] text-[var(--color-ember)]">{error}</p>}
          <button className="btn btn-signal w-full" disabled={!consent || !f.name.trim() || !f.email.trim() || state === "sending"}>
            {state === "sending" ? "보내는 중…" : "요청 보내기"}
          </button>
        </form>
      )}
    </section>
  );
}
