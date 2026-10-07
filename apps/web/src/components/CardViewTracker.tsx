"use client";
// X-003: counts CTA taps (tel/mailto/links/action requests) and vCard saves on a shared card — just +1 counters,
// no identifiers. Skipped entirely when the browser signals Global Privacy Control or Do-Not-Track.
import { CARD_MESSAGES, type Locale } from "@linkos/domain";
import type { ReactNode } from "react";

function privacySignal(): boolean {
  const n = navigator as Navigator & { globalPrivacyControl?: boolean; doNotTrack?: string | null };
  return n.globalPrivacyControl === true || n.doNotTrack === "1";
}

export function CardViewTracker({ profileId, sessionId = null, locale = "ko", children }: { profileId: string; sessionId?: string | null; locale?: Locale; children: ReactNode }) {
  const send = (kind: "cta" | "vcard") => {
    if (privacySignal()) return;
    void fetch("/api/v1/card-views", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileId, sessionId, kind }), keepalive: true, credentials: "same-origin" }).catch(() => undefined);
  };
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const a = t.closest("a[href]") as HTMLAnchorElement | null;
    if (a && /^(tel:|mailto:|sms:|https?:)/.test(a.getAttribute("href") ?? "")) return send("cta");
    const b = t.closest("button");
    if (!b) return;
    if (b.textContent?.trim() === CARD_MESSAGES[locale].saveVcard) return send("vcard");
    if (b.hasAttribute("aria-expanded") && b.closest("[aria-labelledby='actions-h']")) send("cta"); // Action Card request
  };
  return (
    <div onClickCapture={onClick} data-card-tracker>
      {children}
    </div>
  );
}
