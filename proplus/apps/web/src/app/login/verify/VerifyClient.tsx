"use client";

/**
 * 매직링크 → 세션. `POST /api/v1/auth/callback` 에 토큰을 **본문으로** 보낸다.
 *
 * 세 가지를 의도적으로 지킨다:
 *
 * 1. **읽는 즉시 주소창을 지운다.** 토큰이 URL 에 남으면 다음 페이지 요청의 Referer, 북마크,
 *    브라우저 히스토리 동기화에 전부 실린다. `replaceState` 는 히스토리 항목을 교체하므로
 *    뒤로 가기로도 토큰이 있는 주소로 돌아갈 수 없다.
 * 2. **한 번만 보낸다.** 토큰은 1회성이다(identity.consumeLoginLink). React 의 개발 모드
 *    이중 실행이나 리렌더로 두 번 POST 하면 **두 번째 요청이 실패로 보인다** — 사용자는 분명히
 *    한 번만 눌렀는데 "이미 사용된 링크"를 보게 된다. ref 로 막는다.
 * 3. **실패 사유를 서버 문구 그대로 쓴다.** 만료·재사용·존재하지 않음을 모듈이 일부러
 *    구분하지 않으므로(유효 토큰의 존재가 드러난다) 화면도 구분해 적지 않는다.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ClientError, api } from "@/lib/client";

interface CallbackResult {
  userId: string;
  expiresAt: string;
  /** 서버가 `safeNext()` 로 걸러 준 같은 출처 경로. 클라이언트는 다시 판단하지 않는다. */
  next: string;
}

type Phase = "working" | "missing" | "failed";

export function VerifyClient() {
  const started = useRef(false);
  const [phase, setPhase] = useState<Phase>("working");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const url = new URL(window.location.href);
    const token = url.searchParams.get("token");
    const next = url.searchParams.get("next");

    // 주소창 정리는 요청보다 먼저 한다. 요청 중에 사용자가 주소를 복사·공유할 수 있다.
    window.history.replaceState(null, "", url.pathname);

    if (!token) {
      setPhase("missing");
      return;
    }

    void (async () => {
      try {
        const out = await api<CallbackResult>("/auth/callback", {
          body: next ? { token, next } : { token },
        });
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
        <p className="eyebrow">로그인 확인</p>
        <h1 className="display mt-4 text-[30px] sm:text-[38px]">로그인하고 있습니다…</h1>
        <p className="lede mt-5">잠시만 기다려 주세요. 이 창을 닫지 마세요.</p>
      </div>
    );
  }

  return (
    <div role="alert">
      <p className="eyebrow">로그인 확인</p>
      <h1 className="display mt-4 text-[30px] sm:text-[38px]">로그인하지 못했습니다</h1>
      <p className="lede mt-5">
        {phase === "missing"
          ? "로그인 링크에 토큰이 없습니다. 메일에 있는 링크를 그대로 열었는지 확인하세요."
          : (message ?? "링크가 만료되었거나 이미 사용되었습니다. 다시 요청하세요.")}
      </p>
      <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
        링크는 10분 동안 한 번만 쓸 수 있습니다. 다시 요청하면 새 링크가 발송됩니다.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link href="/login" className="btn btn-primary btn-lg">
          로그인 링크 다시 요청
        </Link>
        <Link href="/" className="btn btn-ghost btn-lg">
          홈으로
        </Link>
      </div>
    </div>
  );
}
