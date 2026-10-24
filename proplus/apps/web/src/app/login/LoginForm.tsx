"use client";

/**
 * P-001 매직링크 요청 폼.
 *
 * 응답에 토큰이 없다(라우트 주석). 그래서 이 폼이 할 수 있는 일은 "보냈다"를 알리는 것뿐이고,
 * 세션은 메일 링크 → `/login/verify` 가 만든다. 여기서 성공 문구에 가입 여부를 쓰지 않는 이유도
 * 같다 — 서버가 구분해 주지 않는 것을 화면이 추측하면 계정 열거가 된다 (보안정책 §2).
 *
 * 두 가지 비운영 경로를 **서버가 돌려준 값으로만** 다룬다(화면이 환경을 추측하지 않는다):
 *   - `demo: true`   — DEMO_LOGIN=1. 응답이 세션 쿠키를 이미 심었으므로 바로 이동한다.
 *   - `devLoginToken` — SMTP 미설정 + 비운영. 메일함이 없는 로컬에서 흐름을 끝낼 링크를 보여 준다.
 *     (identity.ts 가 `NODE_ENV==='production'` 에서는 절대 채우지 않는다.)
 */

import Link from "next/link";
import { useId, useState } from "react";
import { ClientError, api } from "@/lib/client";

/** `POST /api/v1/auth/request-link` 의 응답 모양 (라우트가 돌려주는 세 가지 형태의 합집합). */
interface RequestLinkResult {
  sent: boolean;
  demo?: boolean;
  devLoginToken?: string;
}

type Phase = "idle" | "sending" | "sent";

export function LoginForm({ next, demoLogin }: { next: string; demoLogin: boolean }) {
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (phase === "sending") return;

    setPhase("sending");
    setError(null);
    setDevToken(null);
    try {
      const out = await api<RequestLinkResult>("/auth/request-link", { body: { email } });

      if (out.demo === true) {
        // 쿠키가 이미 심어졌다. 전체 내비게이션으로 이동해 서버가 새 세션으로 다시 렌더하게 한다
        // (클라이언트 라우터 캐시가 비로그인 상태의 화면을 들고 있을 수 있다).
        window.location.assign(next);
        return;
      }

      setDevToken(out.devLoginToken ?? null);
      setPhase("sent");
    } catch (e) {
      // 서버 메시지를 그대로 보여 준다 — 한도 초과·형식 오류의 문구는 모듈이 정한다 (전략 §3).
      setError(e instanceof ClientError ? e.message : "요청을 처리하지 못했습니다.");
      setPhase("idle");
    }
  }

  const sending = phase === "sending";

  return (
    <form onSubmit={submit} noValidate={false}>
      <label className="label" htmlFor={emailId}>
        이메일 주소
      </label>
      <input
        id={emailId}
        className="field"
        type="email"
        name="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        maxLength={254}
        placeholder="name@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        aria-describedby={`${emailId}-hint`}
      />
      <p id={`${emailId}-hint`} className="mt-2 text-[12.5px] text-[var(--fg-mute)]">
        {demoLogin
          ? "이 환경은 메일을 보내지 않고 입력한 주소로 바로 로그인합니다."
          : "이 주소로 로그인 링크를 보냅니다. 조직 메일을 쓰면 소속 확인에 쓸 수 있습니다."}
      </p>

      {/*
        DEMO_LOGIN 이 켜진 환경에서는 같은 요청이 메일 없이 세션을 내준다. 버튼을 하나 더 만드는 대신
        **라벨을 바꾼다**: 동작이 하나뿐인데 버튼이 둘이면 사용자는 무엇이 다른지 알 수 없고,
        화면이 없는 선택지를 있는 것처럼 말하게 된다. 운영에서는 이 분기가 아예 꺼져 있다.
      */}
      <button type="submit" className="btn btn-primary btn-lg mt-5 w-full" disabled={sending}>
        {sending ? "처리 중…" : demoLogin ? "테스트 계정으로 바로 시작" : "로그인 링크 받기"}
      </button>

      {demoLogin ? (
        <p className="chip mt-4 !border-[var(--pending)] font-semibold text-[var(--pending)]">
          DEMO_LOGIN 켜짐 · 테스트 환경
        </p>
      ) : null}

      {/* 상태 변화는 스크린리더에도 전달되어야 한다 (P-193). 색이나 위치만으로 말하지 않는다. */}
      <div aria-live="polite" className="mt-4 empty:mt-0">
        {phase === "sent" ? (
          <div className="panel p-4">
            <p className="text-[14.5px] font-semibold">메일을 확인하세요</p>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
              가입된 주소라면 로그인 링크를 보냈습니다. 10분 안에 한 번만 쓸 수 있고, 메일이 보이지 않으면
              스팸함을 확인한 뒤 다시 요청하세요.
            </p>
            {devToken ? (
              <p className="mt-3 text-[13px] leading-relaxed">
                <span className="font-semibold">메일을 보내지 않았습니다(SMTP 미설정 · 비운영).</span>{" "}
                <Link
                  href={`/login/verify?token=${encodeURIComponent(devToken)}&next=${encodeURIComponent(next)}`}
                  className="text-[var(--accent-text)] underline underline-offset-2"
                >
                  이 링크로 로그인 계속하기
                </Link>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-[13.5px] font-medium text-[var(--caution)]">
          {error}
        </p>
      ) : null}
    </form>
  );
}
