"use client";

/**
 * 세션 폐기(P-005) · 내보내기(P-010) · 탈퇴(P-011).
 *
 * ## 되돌릴 수 없는 동작은 확인 단계를 둔다
 *
 * "모든 기기에서 로그아웃"과 "계정 삭제"는 한 번 누르면 끝이다. 둘 다 **2단계**로 만든다:
 *   - 전체 폐기: 무엇이 일어나는지 적은 확인 패널 → 실행. 실행하면 지금 이 기기도 끊긴다.
 *   - 탈퇴: 위 두 단계에 **문구 입력**을 더한다. 탈퇴는 공개 중단·접근 차단을 즉시 일으키고
 *     클릭 실수로 일어날 일이 아니다.
 *
 * ## 401 이면 로그인 화면으로 보낸다
 *
 * 전체 폐기나 "이 기기"에 해당하는 세션을 끊으면 쿠키는 남아 있지만 세션 행이 죽는다.
 * 그 뒤의 요청은 401 이고, 그때 할 일은 에러 문구를 띄우는 것이 아니라 로그인으로 보내는 것이다.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClientError, api, fmtDateTime } from "@/lib/client";

/**
 * `identity.SessionSummary` 와 같은 모양. 서버 모듈 타입을 직접 import 하지 않고 다시 적는 이유는
 * ProfileEditor 의 ProfileDto 와 같다 — 어긋나면 서버 페이지의 prop 전달 지점에서 타입 에러가 난다.
 */
export interface SessionDto {
  id: string;
  kind: "web" | "native";
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/** 탈퇴 확인 입력. 짧고 모호하지 않은 단어 하나로 고정한다. */
const DELETE_PHRASE = "탈퇴";

type Busy = "none" | "session" | "all" | "export" | "delete";

export function SettingsClient({ sessions, children }: { sessions: SessionDto[]; children?: React.ReactNode }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>("none");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [phrase, setPhrase] = useState("");

  const working = busy !== "none";

  async function run(kind: Busy, fn: () => Promise<string | null>): Promise<void> {
    if (working) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
    } catch (e) {
      if (e instanceof ClientError && e.status === 401) {
        // 방금 끊은 세션이 이 기기였다. 남은 화면을 붙잡고 있을 이유가 없다.
        window.location.assign("/login?next=%2Fapp%2Fsettings");
        return;
      }
      setError(e instanceof ClientError ? e.message : "요청을 처리하지 못했습니다.");
    } finally {
      setBusy("none");
    }
  }

  function revokeOne(id: string): Promise<void> {
    return run("session", async () => {
      await api<{ revoked: true }>(`/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      // 목록은 서버가 그린다 — 지운 항목을 클라이언트에서 추측해 지우지 않는다.
      router.refresh();
      return "해당 기기의 로그인을 끊었습니다.";
    });
  }

  function revokeAll(): Promise<void> {
    return run("all", async () => {
      await api<{ revoked: number }>("/me/sessions", { method: "DELETE" });
      // 지금 이 기기도 포함된다. 전체 내비게이션으로 로그인 화면으로 간다.
      window.location.assign("/login");
      return null;
    });
  }

  function exportData(): Promise<void> {
    return run("export", async () => {
      const data = await api<Record<string, unknown>>("/me/export");
      // 서버가 Content-Disposition 을 붙이지 않으므로(JSON API 다) 파일 저장은 브라우저에서 만든다.
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `proplus-내데이터-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      return "내 데이터 파일을 내려받았습니다.";
    });
  }

  function deleteAccount(): Promise<void> {
    return run("delete", async () => {
      await api<{ status: string }>("/me", { method: "DELETE" });
      window.location.assign("/");
      return null;
    });
  }

  return (
    <div className="mt-8 flex flex-col gap-5">
      <div aria-live="polite" className="empty:hidden">
        {notice ? <p className="panel p-4 text-[14px] font-medium">{notice}</p> : null}
      </div>
      {error ? (
        <p role="alert" className="card p-4 text-[14px] font-medium text-[var(--caution)]">
          {error}
        </p>
      ) : null}

      {/* ── 로그인한 기기 (P-005) ──────────────────────────── */}
      <section aria-labelledby="h-sessions" className="card flex flex-col gap-4 p-6">
        <h2 id="h-sessions" className="text-[17px] font-semibold">
          로그인한 기기
        </h2>
        <p className="text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
          로그인할 때마다 세션이 하나 생기고, 30일이 지나면 자동으로 만료됩니다. 모르는 기기가 있으면
          끊으세요. 지금 쓰는 기기를 끊으면 이 화면에서 바로 로그아웃됩니다.
        </p>

        {sessions.length === 0 ? (
          <p className="text-[14px] text-[var(--fg-mute)]">표시할 세션이 없습니다.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--line)]">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 py-3.5">
                <div className="min-w-0">
                  <p className="text-[14.5px] font-medium">
                    {s.kind === "native" ? "앱" : "웹 브라우저"}
                    <span className="font-normal text-[var(--fg-mute)]"> · 최근 사용 {fmtDateTime(s.lastSeenAt)}</span>
                  </p>
                  {/* 기기 식별에 쓸 수 있는 값은 user_agent 뿐이다. 해석해 "Chrome · 맥"으로 바꾸면
                      틀릴 수 있으므로 저장된 문자열을 그대로 보여 준다. */}
                  {s.userAgent ? (
                    <p className="mt-1 line-clamp-2 break-all text-[12px] text-[var(--fg-mute)]">{s.userAgent}</p>
                  ) : (
                    <p className="mt-1 text-[12px] text-[var(--fg-mute)]">기기 정보가 기록되지 않았습니다.</p>
                  )}
                  <p className="mt-1 text-[12px] text-[var(--fg-mute)]">
                    로그인 {fmtDateTime(s.createdAt)} · 만료 {fmtDateTime(s.expiresAt)}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost !min-h-10 text-[14px]"
                  onClick={() => void revokeOne(s.id)}
                  disabled={working}
                  aria-label={`${s.kind === "native" ? "앱" : "웹 브라우저"} 세션(최근 사용 ${fmtDateTime(s.lastSeenAt)}) 로그아웃`}
                >
                  로그아웃
                </button>
              </li>
            ))}
          </ul>
        )}

        <hr className="rule" />

        {confirmAll ? (
          <div className="panel flex flex-col gap-3 p-4" role="group" aria-labelledby="h-revoke-all">
            <p id="h-revoke-all" className="text-[14px] font-semibold text-[var(--caution)]">
              모든 기기에서 로그아웃합니다
            </p>
            <p className="text-[13px] leading-relaxed">
              지금 쓰는 이 기기까지 포함해 {sessions.length}개 세션이 모두 끊어집니다. 되돌릴 수 없고, 다시
              쓰려면 기기마다 로그인 링크를 새로 받아야 합니다.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary !min-h-11" onClick={() => void revokeAll()} disabled={working}>
                {busy === "all" ? "처리 중…" : "모두 로그아웃"}
              </button>
              <button
                type="button"
                className="btn btn-ghost !min-h-11"
                onClick={() => setConfirmAll(false)}
                disabled={working}
              >
                취소
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmAll(true)} disabled={working}>
              모든 기기에서 로그아웃
            </button>
            <p className="mt-2 text-[12px] text-[var(--fg-mute)]">
              계정이 도용된 것 같을 때 씁니다. 확인 단계가 한 번 더 있습니다.
            </p>
          </div>
        )}
      </section>

      {children}

      {/* ── 내보내기 (P-010) ───────────────────────────────── */}
      <section aria-labelledby="h-export" className="card flex flex-col gap-3 p-6">
        <h2 id="h-export" className="text-[17px] font-semibold">
          내 데이터 내보내기
        </h2>
        <p className="text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
          프로필·검증 항목·배지·동의 기록·세션 목록을 JSON 파일로 받습니다. 내보내기 사실은 기록에 남습니다.
        </p>
        <ul className="flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
          <li>· 검증에 제출한 증빙 원본 파일은 포함되지 않습니다. 원본 열람은 기록이 남는 별도 요청 경로입니다.</li>
          <li>· 상담 요청자의 연락처는 보호를 위해 마스킹된 값만 들어갑니다.</li>
        </ul>
        <div className="pt-1">
          <button type="button" className="btn btn-ghost" onClick={() => void exportData()} disabled={working}>
            {busy === "export" ? "준비 중…" : "JSON 파일로 받기"}
          </button>
        </div>
      </section>

      {/* ── 탈퇴 (P-011) ───────────────────────────────────── */}
      <section aria-labelledby="h-delete" className="card flex flex-col gap-3 p-6">
        <h2 id="h-delete" className="text-[17px] font-semibold">
          계정 삭제
        </h2>
        <p className="text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
          삭제를 요청하면 <strong className="text-[var(--fg)]">즉시</strong> 공개 프로필이 내려가고 모든 기기의
          로그인이 끊어집니다. 같은 주소로 다시 로그인해도 계정은 되살아나지 않습니다.
        </p>
        <p className="text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
          분쟁 대응과 법령 보존이 필요한 검증 이력·기록은 보존 기간 동안 남습니다. 그 기간이 확정되기 전에는
          기록을 즉시 파기하지 않습니다 — 지금 일어나는 일은 “공개 중단과 접근 차단”입니다.
        </p>

        {confirmDelete ? (
          <div className="panel flex flex-col gap-3 p-4" role="group" aria-labelledby="h-delete-confirm">
            <p id="h-delete-confirm" className="text-[14px] font-semibold text-[var(--caution)]">
              삭제를 확인합니다
            </p>
            <label className="label" htmlFor="delete-phrase">
              계속하려면 “{DELETE_PHRASE}”라고 입력하세요
            </label>
            <input
              id="delete-phrase"
              className="field"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoComplete="off"
              aria-describedby="delete-phrase-hint"
            />
            <p id="delete-phrase-hint" className="text-[12px] text-[var(--fg-mute)]">
              입력한 문구가 정확히 일치할 때만 버튼이 동작합니다.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary !min-h-11"
                onClick={() => void deleteAccount()}
                disabled={working || phrase.trim() !== DELETE_PHRASE}
              >
                {busy === "delete" ? "처리 중…" : "계정 삭제 요청"}
              </button>
              <button
                type="button"
                className="btn btn-ghost !min-h-11"
                onClick={() => {
                  setConfirmDelete(false);
                  setPhrase("");
                }}
                disabled={working}
              >
                취소
              </button>
            </div>
          </div>
        ) : (
          <div className="pt-1">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(true)} disabled={working}>
              계정 삭제 요청
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
