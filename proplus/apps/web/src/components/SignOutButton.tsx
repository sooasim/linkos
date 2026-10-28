"use client";

/**
 * P-003 로그아웃 — `POST /api/v1/auth/logout`.
 *
 * **이 기기만 폐기된다.** 라우트가 `ctx.sessionId` 하나만 revoke 하기 때문이고, 그것이 의도다
 * (logout 라우트 주석: 휴대폰에서 로그아웃했다고 데스크톱이 끊기면 사용자는 사고로 받아들인다).
 * 그 사실을 버튼 옆에 적는다 — 적지 않으면 "모든 기기에서 로그아웃됐다"고 오해하고,
 * 기기를 잃어버린 사람이 필요한 조치(설정 → 모든 기기에서 로그아웃)를 하지 않는다.
 *
 * 응답이 쿠키를 비우므로 전체 내비게이션으로 홈에 보낸다. 클라이언트 라우터로 이동하면
 * 로그인 상태로 렌더된 화면이 캐시에 남아 있을 수 있다.
 */

import { useState } from "react";
import { ClientError, api } from "@/lib/client";

export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await api<{ ok: true; revoked: number }>("/auth/logout", { body: {} });
      window.location.assign("/");
    } catch (e) {
      setError(e instanceof ClientError ? e.message : "로그아웃하지 못했습니다.");
      setPending(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn btn-ghost !min-h-10 w-full text-[14px]" onClick={signOut} disabled={pending}>
        {pending ? "로그아웃 중…" : "로그아웃"}
      </button>
      <p className="mt-2 text-[12px] leading-relaxed text-[var(--fg-mute)]">
        이 기기에서만 로그아웃됩니다. 다른 기기를 함께 끊으려면 설정에서 “모든 기기에서 로그아웃”을 쓰세요.
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-[12.5px] font-medium text-[var(--caution)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
