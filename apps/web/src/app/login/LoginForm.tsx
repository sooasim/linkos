"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { GoogleOneTap, PENDING_ONETAP_KEY } from "@/components/GoogleOneTap";
import { Icon, Logo } from "@/components/Icon";
import { ClientError, api } from "@/lib/client";

const REQUIRED = [
  { type: "terms", label: "서비스 이용약관 동의", href: "/legal/terms" },
  { type: "privacy", label: "개인정보 수집·이용 동의", href: "/legal/privacy" },
  { type: "age_14", label: "만 14세 이상입니다" },
] as const;

const ERRORS: Record<string, string> = {
  google_denied: "Google 로그인이 취소되었습니다.",
  sso_denied: "회사 SSO 로그인이 취소되었습니다.",
  sso_not_found: "이 이메일 도메인에 연결된 회사 SSO가 없습니다.",
  sso_domain_not_allowed: "회사 SSO는 조직의 인증된 도메인 이메일만 사용할 수 있습니다.",
  sso_invalid_token: "회사 SSO 신원 확인에 실패했습니다.",
  sso_nonce_mismatch: "회사 SSO 신원 확인에 실패했습니다.",
  sso_email_missing: "회사 SSO가 확인된 이메일을 제공하지 않았습니다.",
  sso_token_failed: "회사 SSO 서버와 통신하지 못했습니다.",
  sso_discovery_failed: "회사 SSO 서버와 통신하지 못했습니다.",
};

function readSsoEmail(): string {
  try {
    return sessionStorage.getItem("lk_sso_email") ?? "";
  } catch {
    return "";
  }
}

export function LoginForm({
  next,
  google,
  googleConsent,
  ssoConsent = false,
  error: initialError,
  oneTapClientId = null,
}: {
  next: string;
  google: boolean;
  googleConsent: boolean;
  ssoConsent?: boolean;
  error: string | null;
  oneTapClientId?: string | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code" | "consent">(googleConsent || ssoConsent ? "consent" : "email");
  const [email, setEmail] = useState("");
  const [ssoEmailKnown, setSsoEmailKnown] = useState(false);
  useEffect(() => {
    if (!ssoConsent) return;
    const e = readSsoEmail();
    if (e) {
      setEmail(e);
      setSsoEmailKnown(true);
    }
  }, [ssoConsent]);
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ? (ERRORS[initialError] ?? null) : null);
  const allRequired = REQUIRED.every((r) => checks[r.type]);
  // F-060 One Tap: credential waiting for the consent step (new users only)
  const [oneTapCredential, setOneTapCredential] = useState<string | null>(null);

  useEffect(() => {
    try {
      const pending = sessionStorage.getItem(PENDING_ONETAP_KEY);
      if (pending) {
        sessionStorage.removeItem(PENDING_ONETAP_KEY);
        setOneTapCredential(pending);
        setStep("consent");
      }
    } catch {
      /* storage blocked */
    }
  }, []);

  const oneTap = async (credential: string, withConsents: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const consents = withConsents ? [...REQUIRED.map((r) => ({ type: r.type, granted: true })), { type: "marketing", granted: marketing }] : [];
      await api("/auth/google/onetap", { body: { credential, consents } });
      router.replace(next);
      router.refresh();
    } catch (err) {
      if (err instanceof ClientError && err.code === "consent_required") {
        setOneTapCredential(credential);
        setStep("consent");
      } else {
        setOneTapCredential(null);
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ devCode?: string }>("/auth/otp", { body: { email } });
      setDevCode(r.devCode ?? null);
      setStep("code");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (withConsents: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const consents = withConsents ? [...REQUIRED.map((r) => ({ type: r.type, granted: true })), { type: "marketing", granted: marketing }] : [];
      await api("/auth/verify", { body: { email, code, consents } });
      router.replace(next);
      router.refresh();
    } catch (err) {
      if (err instanceof ClientError && err.code === "consent_required") setStep("consent");
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const continueGoogle = () => {
    document.cookie = `lk_consent=${allRequired ? 1 : 0}; path=/; max-age=600; samesite=lax`;
    window.location.href = `/api/v1/auth/google?next=${encodeURIComponent(next)}`;
  };

  // F-008 회사 SSO: the work email's verified domain picks the org's OIDC IdP
  const continueSso = (withConsent: boolean) => {
    if (!email.includes("@")) {
      setError("회사 이메일을 입력하세요.");
      return;
    }
    try {
      sessionStorage.setItem("lk_sso_email", email);
    } catch {
      /* private mode */
    }
    if (withConsent) document.cookie = `lk_consent=${allRequired ? 1 : 0}; path=/; max-age=600; samesite=lax`;
    window.location.href = `/api/v1/auth/sso/start?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`;
  };

  // F-006 Passkey sign-in (discoverable credential, or scoped to the typed email)
  const signInWithPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const { challengeId, options } = await api<{ challengeId: string; options: any }>("/auth/passkey/login/options", { body: { email: email.includes("@") ? email : null } });
      const response = await startAuthentication({ optionsJSON: options });
      await api("/auth/passkey/login/verify", { body: { challengeId, response } });
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError((err as Error).name === "NotAllowedError" ? "패스키 로그인이 취소되었습니다." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      {oneTapClientId && step === "email" && <GoogleOneTap clientId={oneTapClientId} onCredential={(c) => oneTap(c, false)} />}
      <aside className="stage-ink grain relative hidden overflow-hidden p-12 lg:flex lg:flex-col">
        <Logo />
        <div className="my-auto">
          <p className="eyebrow">Business Identity & Relationship OS</p>
          <h2 className="display mt-4 text-[96px]">
            Meet.
            <br />
            Exchange.
            <br />
            <em className="text-[var(--color-signal)]">Remember.</em>
          </h2>
        </div>
        <p className="max-w-sm text-[15px] text-[var(--fg-mute)]">비밀번호 없이. 교환한 명함과 관계는 가입 후에도 그대로 이어집니다.</p>
      </aside>

      <section className="flex flex-col px-6 pb-10 pt-6 sm:px-10">
        <div className="lg:hidden">
          <Link href="/"><Logo /></Link>
        </div>
        <div className="mx-auto my-auto w-full max-w-sm animate-rise">
          {step === "email" && (
            <form onSubmit={requestCode}>
              <h1 className="display text-[54px]">
                시작하기<em className="text-[var(--color-ember)]">.</em>
              </h1>
              <p className="mt-2 text-[15px] text-[var(--fg-mute)]">이메일로 받은 6자리 코드로 로그인합니다.</p>
              {google && (
                <>
                  <button type="button" onClick={() => setStep("consent")} className="btn btn-ink btn-lg mt-8 w-full">
                    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
                    Google로 계속하기
                  </button>
                  <div className="my-5 flex items-center gap-3 text-[12px] text-[var(--fg-mute)]">
                    <span className="h-px flex-1 bg-[var(--line)]" /> 또는 <span className="h-px flex-1 bg-[var(--line)]" />
                  </div>
                </>
              )}
              <label className={`label ${google ? "" : "mt-8"}`} htmlFor="email">이메일</label>
              <input id="email" className="field" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
              <button className="btn btn-signal btn-lg mt-4 w-full" disabled={busy || !email.includes("@")}>
                {busy ? "보내는 중…" : "코드 받기"}
              </button>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button type="button" className="btn btn-ghost" onClick={signInWithPasskey} disabled={busy}>
                  <Icon name="lock" size={16} /> 패스키
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => continueSso(false)} disabled={busy}>
                  <Icon name="people" size={16} /> 회사 SSO
                </button>
              </div>
            </form>
          )}

          {step === "code" && (
            <form onSubmit={(e) => { e.preventDefault(); verify(false); }}>
              <button type="button" onClick={() => setStep("email")} className="mb-6 inline-flex items-center gap-1 text-[14px] text-[var(--fg-mute)]">
                <Icon name="back" size={16} /> {email}
              </button>
              <h1 className="display text-[54px]">
                코드 <em>입력</em>
              </h1>
              <p className="mt-2 text-[15px] text-[var(--fg-mute)]">메일함을 확인하세요. 10분간 유효합니다.</p>
              {devCode && (
                <p className="mt-4 rounded-2xl border border-dashed border-[var(--line-strong)] px-4 py-3 text-[13px]" data-testid="dev-code">
                  개발 모드(메일 미설정): 코드 <b className="num">{devCode}</b>
                </p>
              )}
              <input
                className="num field mt-6 text-center !text-[32px] font-semibold tracking-[0.4em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                aria-label="6자리 코드"
                autoFocus
              />
              <button className="btn btn-signal btn-lg mt-4 w-full" disabled={busy || code.length !== 6}>
                {busy ? "확인 중…" : "로그인"}
              </button>
            </form>
          )}

          {step === "consent" && (
            <div>
              <h1 className="display text-[48px]">
                약관 <em>동의</em>
              </h1>
              <p className="mt-2 text-[15px] text-[var(--fg-mute)]">필수 항목과 선택 항목을 분리해 기록합니다.</p>
              <button
                type="button"
                className="surface mt-6 flex w-full items-center gap-3 p-4 text-left text-[16px] font-semibold"
                onClick={() => {
                  const v = !allRequired;
                  setChecks(Object.fromEntries(REQUIRED.map((r) => [r.type, v])));
                  setMarketing(v);
                }}
              >
                <span className={`grid size-6 place-items-center rounded-full border ${allRequired && marketing ? "border-transparent bg-[var(--color-signal)] text-[var(--color-ink)]" : "border-[var(--line-strong)]"}`}>
                  <Icon name="check" size={14} strokeWidth={3} />
                </span>
                전체 동의
              </button>
              <ul className="mt-3 space-y-1">
                {REQUIRED.map((r) => (
                  <li key={r.type} className="flex items-center gap-3 px-2 py-2">
                    <input id={r.type} type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={!!checks[r.type]} onChange={(e) => setChecks({ ...checks, [r.type]: e.target.checked })} />
                    <label htmlFor={r.type} className="flex-1 text-[15px]">
                      <span className="mr-1 text-[var(--color-ember)]">[필수]</span>
                      {r.label}
                    </label>
                    {"href" in r && r.href ? <Link href={r.href} className="text-[13px] text-[var(--fg-mute)] underline">보기</Link> : null}
                  </li>
                ))}
                <li className="flex items-center gap-3 px-2 py-2">
                  <input id="marketing" type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
                  <label htmlFor="marketing" className="flex-1 text-[15px]">
                    <span className="mr-1 text-[var(--fg-mute)]">[선택]</span>마케팅 정보 수신
                  </label>
                </li>
              </ul>
              {oneTapCredential ? (
                <button className="btn btn-signal btn-lg mt-6 w-full" disabled={!allRequired || busy} onClick={() => oneTap(oneTapCredential, true)} data-testid="onetap-consent">
                  동의하고 Google 계정으로 가입
                </button>
              ) : ssoConsent ? (
                <>
                  {!ssoEmailKnown && <input className="field mt-6" type="email" placeholder="회사 이메일" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="회사 이메일" />}
                  <button className="btn btn-signal btn-lg mt-6 w-full" disabled={!allRequired} onClick={() => continueSso(true)}>
                    동의하고 회사 SSO로 계속
                  </button>
                </>
              ) : googleConsent || (!code && google) ? (
                <button className="btn btn-signal btn-lg mt-6 w-full" disabled={!allRequired} onClick={continueGoogle}>
                  동의하고 Google로 계속
                </button>
              ) : (
                <button className="btn btn-signal btn-lg mt-6 w-full" disabled={!allRequired || busy} onClick={() => verify(true)}>
                  동의하고 가입 완료
                </button>
              )}
            </div>
          )}
          {error && <p role="alert" className="mt-4 rounded-2xl bg-[var(--color-ember)]/10 px-4 py-3 text-[14px] text-[var(--color-ember)]">{error}</p>}
        </div>
      </section>
    </main>
  );
}
