"use client";

/**
 * LINKOS assertion → `pp_session`. `POST /api/v1/auth/linkos/start` 에 **본문으로** 보낸다.
 *
 * 근거: `proplus/docs/05_LINKOS_INTEGRATION.md` §1 흐름 4~6.
 *
 * `/login/verify` 와 같은 네 가지를 지킨다:
 *
 * 1. **읽는 즉시 주소창을 지운다.** assertion 이 URL 에 남으면 다음 요청의 Referer, 북마크,
 *    브라우저 히스토리 동기화에 전부 실린다. `replaceState` 는 히스토리 항목을 교체하므로
 *    뒤로 가기로도 토큰이 있는 주소로 돌아갈 수 없다.
 * 2. **한 번만 보낸다.** assertion 은 1회성이다(`sso_assertions.jti` UNIQUE). React 개발 모드의
 *    이중 실행이나 리렌더로 두 번 POST 하면 **두 번째가 "이미 사용된 로그인 요청"으로 실패**하고,
 *    사용자는 한 번만 눌렀는데 실패 화면을 본다. ref 로 막는다.
 * 3. **state 도 같이 보낸다.** 서버가 `pp_sso_state` 쿠키와 대조한다(로그인 CSRF).
 *    클라이언트는 대조하지 않는다 — 쿠키는 httpOnly 라 읽을 수 없고, 읽을 수 있으면 의미도 없다.
 * 4. **LINKOS 가 준 문자열을 화면에 그대로 쓰지 않는다.** `?error=` 값은 외부가 채우는 값이라
 *    그대로 보여 주면 우리 화면에 남의 문구를 띄우는 자리가 된다(피싱). 우리 문구로 바꿔 쓴다.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ClientError, api } from "@/lib/client";

interface LinkosLoginResult {
  userId: string;
  expiresAt: string;
  isNew: boolean;
  /** 서버가 정한 같은 출처 경로. 클라이언트는 다시 판단하지 않는다. */
  next: string;
}

type Phase = "working" | "missing" | "denied" | "failed";

export function LinkosCallback() {
  const started = useRef(false);
  const [phase, setPhase] = useState<Phase>("working");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const url = new URL(window.location.href);
    const assertion = url.searchParams.get("assertion");
    const state = url.searchParams.get("state");
    const denied = url.searchParams.get("error") !== null;

    // 주소창 정리는 요청보다 먼저 한다. 요청 중에 사용자가 주소를 복사·공유할 수 있다.
    window.history.replaceState(null, "", url.pathname);

    if (denied) {
      setPhase("denied");
      return;
    }
    if (!assertion || !state) {
      setPhase("missing");
      return;
    }

    void (async () => {
      try {
        const out = await api<LinkosLoginResult>("/auth/linkos/start", { body: { assertion, state } });
        // 세션 쿠키가 막 심어졌다. 전체 내비게이션으로 넘겨 서버가 로그인 상태로 다시 렌더하게 한다.
        window.location.assign(out.next);
      } catch (e) {
        setMessage(e instanceof ClientError ? e.message : "로그인하지 못했습니다.");
        setPhase("failed");
      }
    })();
  }, []);

  if (phase === "working") {
    return (
      <div aria-live="polite">
        <p className="eyebrow">LINKOS 계정으로 로그인</p>
        <h1 className="display mt-4 text-[30px] sm:text-[38px]">로그인하고 있습니다…</h1>
        <p className="lede mt-5">잠시만 기다려 주세요. 이 창을 닫지 마세요.</p>
      </div>
    );
  }

  return (
    <div role="alert">
      <p className="eyebrow">LINKOS 계정으로 로그인</p>
      <h1 className="display mt-4 text-[30px] sm:text-[38px]">로그인하지 못했습니다</h1>
      <p className="lede mt-5">{explain(phase, message)}</p>
      <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
        LINKOS 로그인 요청은 1분 동안 한 번만 쓸 수 있습니다. 다시 시작하면 새 요청이 만들어집니다.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link href="/login" className="btn btn-primary btn-lg">
          로그인 다시 시작
        </Link>
        <Link href="/" className="btn btn-ghost btn-lg">
          홈으로
        </Link>
      </div>
    </div>
  );
}

/** 서버가 준 문구는 그대로 쓴다(모듈이 사람 말로 쓴다). 그 외에는 이 화면이 설명한다. */
function explain(phase: Phase, message: string | null): string {
  if (phase === "denied") {
    return "LINKOS 에서 로그인이 완료되지 않았습니다. 다시 시도하거나 메일 링크로 로그인하세요.";
  }
  if (phase === "missing") {
    return "로그인 정보가 주소에 없습니다. LINKOS 로그인 화면에서 다시 시작해 주세요.";
  }
  return message ?? "로그인 요청이 만료되었거나 이미 사용되었습니다. 다시 시도해 주세요.";
}
