"use client";

/**
 * 증거 상세의 **당사자 조치** 두 묶음.
 *
 *  - `OwnerActions`  : P-053 재제출·철회 + P-052 추가 파일 업로드
 *  - `AppealForm`    : P-063 이의제기
 *
 * 한 파일에 둔 이유: 둘 다 "당사자가 자기 증거에 하는 행동"이고, 상세 화면의 상호작용은 이 두 가지뿐이다.
 *
 * ## 이 컴포넌트가 하지 않는 것
 *
 * 전이 가능 여부를 **스스로 정하지 않는다.** 후보 목록은 도메인의 `allowedTransitions(status,'owner')` 에서
 * 그대로 가져오고(서버가 쓰는 같은 순수 함수), 라우트가 받는 목표 상태(`submitted`|`revoked`)로 한 번 더 좁힌다.
 * 최종 판정은 서버의 `canTransition()` 이고, 거절되면 그 code/message 를 그대로 보여준다 (전략 §3 / P-187).
 *
 * 업로드 가능 여부도 서버에 묻는다: 파일을 고르면 먼저 사전검사(`GET …/files`)를 호출해
 * 상태·형식·크기·남은 개수를 서버가 판정하게 하고, 통과한 뒤에만 바이트를 보낸다.
 * "이 상태에서는 올릴 수 없다"는 규칙을 화면이 복사해 두면 서버와 어긋나는 날이 온다.
 */

import type { proof } from "@proplus/api";
import { EVIDENCE_MIME, MAX_EVIDENCE_BYTES, type ProofStatus, allowedTransitions } from "@proplus/domain";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ClientError, api, uid, upload } from "@/lib/client";

/** 라우트가 받는 당사자 목표 상태 (`…/transition` 주석: 이 두 개만 받는다). */
const OWNER_TARGETS: readonly ProofStatus[] = ["submitted", "revoked"];

const TARGET_COPY: Record<string, { label: string; hint: string }> = {
  submitted: {
    label: "다시 검토 요청",
    hint: "보완한 자료를 올린 뒤 누르면 검토 대기열로 돌아갑니다.",
  },
  revoked: {
    label: "제출 철회",
    hint: "이 증거를 내립니다. 확인된 배지가 있었다면 공개 화면에서 즉시 내려갑니다. 나중에 다시 제출할 수 있습니다.",
  },
};

/**
 * 철회 사유 코드. 운영의 사유 코드 **분류 체계는 미결정**이므로(미결정 §2 / 모듈 `REASON_CODE_RE` 주석)
 * 분류를 발명하지 않고, 실제로 일어난 사실 한 가지("당사자가 철회했다")만 코드로 적는다.
 * 사람이 읽을 맥락은 `message` 로 보낸다.
 * TODO(미결정 §2): 운영이 사유 코드 목록을 확정하면 선택 UI 로 바꾼다.
 */
const WITHDRAW_REASON_CODE = "owner_withdraw";

const MAX_MB = Math.floor(MAX_EVIDENCE_BYTES / (1024 * 1024));

interface Notice {
  tone: "ok" | "error";
  message: string;
  code?: string;
}

export function OwnerActions({ evidenceId, status }: { evidenceId: string; status: ProofStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawMessage, setWithdrawMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const targets = allowedTransitions(status, "owner").filter((t) => OWNER_TARGETS.includes(t));

  async function transition(to: ProofStatus) {
    if (busy) return;
    setBusy(to);
    setNotice(null);
    try {
      await api(`/me/evidence/${evidenceId}/transition`, {
        method: "POST",
        body: {
          to,
          // 철회에는 사유 코드가 필수다 (데이터모델 §4 / P-061). 재제출에는 요구되지 않는다.
          ...(to === "revoked"
            ? { reasonCode: WITHDRAW_REASON_CODE, message: withdrawMessage.trim() || null }
            : {}),
        },
      });
      setWithdrawOpen(false);
      setWithdrawMessage("");
      setNotice({ tone: "ok", message: to === "revoked" ? "제출을 철회했습니다." : "다시 검토를 요청했습니다." });
      // 상태 칩·조치 버튼은 서버 렌더 결과다. 로컬 상태로 흉내내지 않고 서버에서 다시 받는다.
      router.refresh();
    } catch (err) {
      const e = err instanceof ClientError ? err : null;
      setNotice({ tone: "error", message: e?.message ?? "처리하지 못했습니다.", code: e?.code });
    } finally {
      setBusy(null);
    }
  }

  async function sendFile() {
    if (busy || !file) return;
    setBusy("file");
    setNotice(null);
    try {
      /**
       * 사전검사. 바이트를 보내기 전에 서버가 상태·형식·크기·남은 개수를 판정한다
       * (`…/files` GET 주석). 쿼리에 파일명을 넣지 않는다 — 쿼리스트링은 접근로그에 남는다 (N-13).
       */
      const mime = file.type || "application/octet-stream";
      const session = await api<proof.UploadSession>(
        `/me/evidence/${evidenceId}/files?mime=${encodeURIComponent(mime)}&size=${file.size}`,
      );

      const path = session.uploadPath.replace(/^\/api\/v1/, "");
      await upload(path, file, { method: "POST", idempotencyKey: uid() });

      setFile(null);
      setNotice({
        tone: "ok",
        message: `파일을 올렸습니다. 이 증거에 더 올릴 수 있는 파일은 ${Math.max(session.remainingFiles - 1, 0)}개입니다.`,
      });
      router.refresh();
    } catch (err) {
      const e = err instanceof ClientError ? err : null;
      setNotice({ tone: "error", message: e?.message ?? "파일을 올리지 못했습니다.", code: e?.code });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card mt-6 p-6" aria-labelledby="owner-actions">
      <h2 id="owner-actions" className="text-[17px] font-semibold">
        내가 할 수 있는 조치
      </h2>

      {/* ── 추가 파일 ───────────────────────────────────────── */}
      <div className="mt-4">
        <label className="label" htmlFor="more-file">
          자료 추가
        </label>
        <input
          id="more-file"
          className="field"
          type="file"
          accept={[...EVIDENCE_MIME].join(",")}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          aria-describedby="more-file-hint"
        />
        <p id="more-file-hint" className="mt-2 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
          JPEG · PNG · WebP · PDF · 한 파일 {MAX_MB}MB 까지. 확정된 검증(확인됨·반려) 뒤에는 원본을 바꿀 수 없습니다 —
          올릴 수 있는 상태인지는 서버가 판정해 알려 줍니다.
        </p>
        <button type="button" className="btn btn-ghost mt-3" onClick={sendFile} disabled={!file || busy !== null}>
          {busy === "file" ? "올리는 중…" : "파일 올리기"}
        </button>
      </div>

      <hr className="rule my-6" />

      {/* ── 상태 전이 ───────────────────────────────────────── */}
      {targets.length === 0 ? (
        <p className="text-[14px] leading-relaxed text-[var(--fg-mute)]">
          지금 상태에서 당사자가 바꿀 수 있는 것은 없습니다. 검토 결과가 나오면 알려 드립니다.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {targets.map((to) => {
            const copy = TARGET_COPY[to];
            if (!copy) return null;
            const isWithdraw = to === "revoked";
            return (
              <div key={to}>
                <p className="text-[13.5px] leading-relaxed text-[var(--fg-mute)]">{copy.hint}</p>
                {isWithdraw && withdrawOpen ? (
                  <div className="mt-3">
                    <label className="label" htmlFor="withdraw-message">
                      철회 사유 (선택, 검토자에게 전달됩니다)
                    </label>
                    <textarea
                      id="withdraw-message"
                      className="field"
                      rows={3}
                      maxLength={300}
                      value={withdrawMessage}
                      onChange={(e) => setWithdrawMessage(e.target.value)}
                    />
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => transition("revoked")}
                        disabled={busy !== null}
                      >
                        {busy === "revoked" ? "처리 중…" : "철회 확정"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => setWithdrawOpen(false)}
                        disabled={busy !== null}
                      >
                        그만두기
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={`btn mt-3 ${isWithdraw ? "btn-ghost" : "btn-primary"}`}
                    onClick={() => (isWithdraw ? setWithdrawOpen(true) : transition(to))}
                    disabled={busy !== null}
                  >
                    {busy === to ? "처리 중…" : copy.label}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {notice ? (
        <p
          className={`mt-5 text-[13.5px] font-semibold ${
            notice.tone === "ok" ? "text-[var(--verified)]" : "text-[var(--caution)]"
          }`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
          {notice.code ? <span className="block font-normal text-[var(--fg-mute)]">오류 코드: {notice.code}</span> : null}
        </p>
      ) : null}
    </section>
  );
}

interface AppealFormProps {
  /** `POST /me/verifications/{id}/appeal` 의 대상. 당사자 응답에 없으면 null 이다 — 아래 주석 참조. */
  verificationId: string | null;
  hasVerification: boolean;
  disputed: boolean;
  /** N-14 의 공개 라벨 상수. 화면에서 문자열을 새로 쓰지 않고 도메인 값을 그대로 보여준다. */
  publicDisputedLabel: string;
}

export function AppealForm({ verificationId, hasVerification, disputed, publicDisputedLabel }: AppealFormProps) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const idemRef = useRef<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !verificationId) return;
    setBusy(true);
    setNotice(null);
    try {
      idemRef.current ??= uid();
      await api(`/me/verifications/${verificationId}/appeal`, {
        method: "POST",
        idempotencyKey: idemRef.current,
        body: { reason: reason.trim() },
      });
      idemRef.current = null;
      setReason("");
      setNotice({ tone: "ok", message: "이의제기가 접수되었습니다. 재확인 절차가 끝나면 알려 드립니다." });
      router.refresh();
    } catch (err) {
      const e = err instanceof ClientError ? err : null;
      setNotice({ tone: "error", message: e?.message ?? "접수하지 못했습니다.", code: e?.code });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card mt-6 p-6" aria-labelledby="appeal">
      <h2 id="appeal" className="text-[17px] font-semibold">
        결과에 이의가 있으신가요?
      </h2>

      {/* N-14 / 보안정책 §4.7: 접수되면 공개 화면에서 원래 라벨이 사라진다. 그 사실을 **접수 전에** 알린다. */}
      <p className="mt-3 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
        이의제기가 접수되면 이 항목은 재확인 상태가 되고, 공개 화면에는 원래 라벨 대신 “{publicDisputedLabel}”만
        표시됩니다. 절차가 끝나기 전까지는 확인됨으로도, 반려로도 표시되지 않습니다.
      </p>

      {disputed ? (
        <p className="mt-4 text-[14px] font-semibold">이미 재확인 절차가 진행 중입니다. 결과가 나오면 알려 드립니다.</p>
      ) : !hasVerification ? (
        <p className="mt-4 text-[14px] leading-relaxed text-[var(--fg-mute)]">
          아직 검증 결과가 없어 이의제기할 대상이 없습니다. 검토 결과가 나온 뒤에 이용할 수 있습니다.
        </p>
      ) : verificationId === null ? (
        /**
         * 데이터가 없어서 **열지 않은** 창구다. 이의제기는 검증 id 를 대상으로 하는데
         * 당사자 응답(`MyEvidenceDto.latest`)에는 그 id 가 없다. 임의의 id 를 만들어 보내면
         * 404 이거나 남의 검증을 가리킬 수 있으므로, 버튼을 그려 두고 실패하게 만들지 않는다.
         */
        <div className="panel mt-4 p-4">
          <p className="text-[14px] font-semibold">이 화면에서는 아직 접수할 수 없습니다.</p>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--fg-mute)]">
            이의제기는 특정 검증 결과 하나를 대상으로 접수됩니다. 지금 이 화면이 받는 응답에는 그 검증 결과의 식별자가
            포함되지 않아, 접수 창구를 열어 두지 않았습니다. 재확인이 필요하시면 고객센터로 문의해 주세요.
          </p>
        </div>
      ) : (
        <form className="mt-4" onSubmit={submit} aria-busy={busy}>
          <label className="label" htmlFor="appeal-reason">
            어떤 점이 사실과 다른지 적어 주세요
          </label>
          <textarea
            id="appeal-reason"
            className="field"
            rows={5}
            minLength={5}
            maxLength={2000}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby="appeal-reason-hint"
          />
          <p id="appeal-reason-hint" className="mt-2 text-[12.5px] text-[var(--fg-mute)]">
            5자 이상 2000자 이내. 적어 주신 내용은 재확인 담당자만 봅니다.
          </p>
          <button type="submit" className="btn btn-primary mt-4" disabled={busy}>
            {busy ? "접수 중…" : "이의제기 접수"}
          </button>
        </form>
      )}

      {notice ? (
        <p
          className={`mt-5 text-[13.5px] font-semibold ${
            notice.tone === "ok" ? "text-[var(--verified)]" : "text-[var(--caution)]"
          }`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
          {notice.code ? <span className="block font-normal text-[var(--fg-mute)]">오류 코드: {notice.code}</span> : null}
        </p>
      ) : null}
    </section>
  );
}
