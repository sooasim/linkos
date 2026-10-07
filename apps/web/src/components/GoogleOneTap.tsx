"use client";
// F-060 One Tap 가입 — Google Identity Services. Loaded only on /login and /claim (never on the guest landing: LCP budget).
// The credential (ID token) is verified server-side against Google's JWKS; this component only collects it.
import { useEffect, useRef } from "react";

interface GsiId {
  initialize(cfg: Record<string, unknown>): void;
  prompt(): void;
  cancel(): void;
}
type GsiWindow = Window & { google?: { accounts?: { id?: GsiId } } };

const GSI_SRC = "https://accounts.google.com/gsi/client";

export function GoogleOneTap({ clientId, onCredential }: { clientId: string; onCredential: (credential: string) => void }) {
  const cb = useRef(onCredential);
  cb.current = onCredential;

  useEffect(() => {
    let cancelled = false;
    const w = window as GsiWindow;
    const init = () => {
      const id = w.google?.accounts?.id;
      if (cancelled || !id) return;
      id.initialize({
        client_id: clientId,
        callback: (r: { credential?: string }) => r.credential && cb.current(r.credential),
        auto_select: false,
        cancel_on_tap_outside: true,
        context: "signin",
        itp_support: true,
        use_fedcm_for_prompt: true,
      });
      id.prompt();
    };
    if (w.google?.accounts?.id) init();
    else {
      let s = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
      if (!s) {
        s = document.createElement("script");
        s.src = GSI_SRC;
        s.async = true;
        s.defer = true;
        document.head.appendChild(s);
      }
      s.addEventListener("load", init, { once: true });
    }
    return () => {
      cancelled = true;
      w.google?.accounts?.id?.cancel();
    };
  }, [clientId]);

  return null;
}

/** Hand a One Tap credential from /claim to /login when a new user still has to accept the required consents. */
export const PENDING_ONETAP_KEY = "lk_onetap";
