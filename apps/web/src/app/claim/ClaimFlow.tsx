"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, Logo } from "@/components/Icon";
import { GoogleOneTap, PENDING_ONETAP_KEY } from "@/components/GoogleOneTap";
import { CardFace } from "@/components/LivingCard";
import { ClientError, api } from "@/lib/client";

export function ClaimFlow({ signedIn, oneTapClientId = null }: { signedIn: boolean; oneTapClientId?: string | null }) {
  const router = useRouter();
  // F-060 One Tap: sign in right here (Claim comes after the exchange); new users finish consents on /login.
  const onOneTap = async (credential: string) => {
    try {
      await api("/auth/google/onetap", { body: { credential, consents: [] } });
      window.location.reload();
    } catch (e) {
      if (e instanceof ClientError && e.code === "consent_required") {
        try {
          sessionStorage.setItem(PENDING_ONETAP_KEY, credential);
        } catch {
          /* storage blocked → plain login */
        }
        router.push("/login?next=/claim");
      } else setError((e as Error).message);
    }
  };
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ guest: Record<string, string | null>; senderName: string | null; claimed: boolean } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "claiming" | "claimed" | "missing" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let t: string | null = null;
    try {
      t = localStorage.getItem("lk_claim");
    } catch {
      /* ignore */
    }
    setToken(t);
    if (!t) {
      setState("missing");
      return;
    }
    api("/guest/claim/preview", { body: { claimToken: t } })
      .then((p) => {
        setPreview(p);
        setState(p.claimed ? "claimed" : "ready");
      })
      .catch(() => setState("missing"));
  }, []);

  const claim = async () => {
    if (!token) return;
    setState("claiming");
    try {
      await api("/guest/claim", { body: { claimToken: token } });
      try {
        localStorage.removeItem("lk_claim");
      } catch {
        /* ignore */
      }
      setState("claimed");
      setTimeout(() => router.push("/app/me/edit?onboarding=1"), 900);
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  const g = preview?.guest ?? {};
  return (
    <main className="stage-ink grain min-h-dvh px-5 pb-12 pt-5">
      {!signedIn && oneTapClientId && state === "ready" && <GoogleOneTap clientId={oneTapClientId} onCredential={onOneTap} />}
      <div className="mx-auto max-w-[520px]">
        <Logo />
        {state === "missing" && (
          <div className="mt-20 animate-rise">
            <h1 className="display text-[48px]">Claim할 카드가 없어요</h1>
            <p className="mt-3 text-[var(--fg-mute)]">교환을 완료한 기기·브라우저에서 다시 열어주세요.</p>
            <Link href="/login" className="btn btn-signal mt-8">로그인</Link>
          </div>
        )}
        {preview && state !== "missing" && (
          <div className="mt-8 animate-rise">
            <p className="eyebrow">{preview.senderName ? `${preview.senderName}님과 교환한 카드` : "방금 만든 카드"}</p>
            <h1 className="display mt-2 text-[48px]">
              이 카드, <em className="text-[var(--color-signal)]">당신 것</em>입니다
            </h1>
            <div className="mt-6">
              <CardFace card={{ name: g.fullName ?? "", company: g.company, jobTitle: g.jobTitle, theme: "paper" }} interactive />
            </div>
            <ul className="mt-6 space-y-2 text-[15px]">
              {["교환한 명함과 만남 기록이 그대로 유지돼요", `${preview.senderName ?? "상대"}님 명함이 내 주소록에 저장돼요`, "Living Card가 자동 완성되고, 다음 사람과 바로 교환할 수 있어요"].map((t) => (
                <li key={t} className="flex gap-3">
                  <Icon name="check" size={18} className="mt-0.5 shrink-0 text-[var(--color-signal)]" />
                  {t}
                </li>
              ))}
            </ul>
            {state === "claimed" ? (
              <div className="btn btn-signal btn-lg mt-8 w-full" role="status">
                <Icon name="check" /> 소유 완료 — 이동 중
              </div>
            ) : signedIn ? (
              <button onClick={claim} disabled={state === "claiming"} className="btn btn-signal btn-lg mt-8 w-full" data-testid="claim-confirm">
                {state === "claiming" ? "연결 중…" : "내 계정에 연결"}
              </button>
            ) : (
              <Link href="/login?next=/claim" className="btn btn-signal btn-lg mt-8 w-full" data-testid="claim-login">
                가입하고 소유하기 <Icon name="arrow" size={18} />
              </Link>
            )}
            {error && <p role="alert" className="mt-4 text-[14px] text-[#ffb59a]">{error}</p>}
          </div>
        )}
      </div>
    </main>
  );
}
