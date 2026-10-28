"use client";

/**
 * P-161 승인 · P-162 반려 · P-163 추가 정보 요청 · P-164 내부 메모.
 *
 * ## 경로의 `{id}` 가 둘이다 — 섞으면 조용히 404 가 난다
 *
 *   approve / reject / request-info  →  **증거 id** (`detail.evidenceId`)
 *   notes                            →  **검증 id** (`detail.verifications[].id`)
 *
 * 이유는 라우트 주석에 적혀 있다: `verifications` 행은 전이마다 새로 생기므로 승인 시점에 가리킬
 * "검증 id" 가 아직 없고, 메모는 "이 판정을 왜 이렇게 했는가"의 기록이라 판정 행에 붙어야 한다.
 * 그래서 메모 폼은 대상 판정을 **고르게** 한다 — 임의로 최신 행을 집으면 운영자가 어느 판정에
 * 메모를 달았는지 모르게 된다.
 *
 * ## 승인 방식에서 자기기재를 고를 수 없게 한 이유 (N-1)
 *
 * 자기기재는 어떤 경로로도 `verified` 가 되지 않는다 — 도메인 전이 함수가 거부한다. 서버가 막으니
 * UI 에 둬도 안전하긴 하지만, 고를 수 있는 선택지로 보이면 운영자는 "되는 선택"이라고 읽는다.
 * 그래서 선택지에서 빼고, 왜 없는지를 글로 적는다. 유형의 최소 강도보다 약한 방식도 같은 이유로
 * 비활성이다(disabled 로 두고 사라지게 하지 않는다 — 요구 강도가 무엇인지 보여야 한다).
 *
 * ## 이 패널은 권한을 판단하지 않는다
 *
 * 전이 가능성(`canTransition`)·권한(`mustCan`)은 모두 서버 판정이다. 여기서 같은 규칙을 다시
 * 구현하면 두 벌이 되고, 둘이 어긋나는 순간 화면이 거짓말을 한다. 실패하면 서버 메시지를 그대로 보여준다.
 */

import type { admin, proof } from "@proplus/api";
import { METHOD_LABEL_KO, VERIFICATION_METHODS, isAtLeast, type VerificationMethod } from "@proplus/domain";
import { useState } from "react";
import { ClientError, api } from "@/lib/client";
import { ReasonCodeSelect, reasonCodeError } from "@/components/ReasonCodeSelect";

type EvidenceDetail = admin.EvidenceDetail;
type TransitionOutcome = proof.TransitionOutcome;

/** N-1: 자기기재는 승인·반려 결정의 선택지가 아니다. 판정 강도로 쓸 수 있는 것은 이 셋이다. */
const DECIDABLE_METHODS = VERIFICATION_METHODS.filter((m) => m !== "self_declared");

type Feedback = { ok: boolean; text: string } | null;

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <p
      role={feedback.ok ? "status" : "alert"}
      className={`text-[13.5px] font-semibold ${feedback.ok ? "text-[var(--verified)]" : "text-[var(--caution)]"}`}
    >
      {feedback.text}
    </p>
  );
}

function outcomeText(label: string, out: TransitionOutcome): string {
  return `${label} — 상태 ${out.from} → ${out.to}. 배지 ${out.badgeId ? "발급됨" : "발급되지 않음"}.`;
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof ClientError ? e.message : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// P-161 승인
// ─────────────────────────────────────────────────────────────────────────────

function ApproveForm({ detail, onChanged }: { detail: EvidenceDetail; onChanged: () => void }) {
  const allowed = DECIDABLE_METHODS.filter((m) => isAtLeast(m, detail.minMethod));
  const [method, setMethod] = useState<VerificationMethod | null>(allowed[0] ?? null);
  const [scope, setScope] = useState("");
  /** "" = 아직 선택하지 않음. P-161 은 만료를 **입력하게** 하므로 기본 선택을 두지 않는다. */
  const [expiry, setExpiry] = useState<"" | "type_default" | "custom">("");
  const [customDay, setCustomDay] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const ready =
    method !== null &&
    scope.trim().length > 0 &&
    (expiry === "type_default" || (expiry === "custom" && customDay.length === 10));

  const submit = async () => {
    if (!ready || method === null) return;
    setBusy(true);
    setFeedback(null);
    try {
      const out = await api<TransitionOutcome>(`/admin/verifications/${detail.evidenceId}/approve`, {
        method: "POST",
        body: {
          method,
          scope: scope.trim(),
          // 키를 **보낼 때만** 담는다. 모듈은 값이 없으면 유형 기본 TTL 을 적용한다.
          ...(expiry === "custom" ? { expiresAt: `${customDay}T23:59:59.000Z` } : {}),
          ...(message.trim() ? { message: message.trim() } : {}),
        },
      });
      setFeedback({ ok: true, text: outcomeText("승인했습니다", out) });
      onChanged();
    } catch (e) {
      setFeedback({ ok: false, text: errorText(e, "승인하지 못했습니다.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card flex flex-col gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-[17px] font-semibold">승인</h3>
      <p className="text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
        방식·범위·만료를 모두 입력해야 승인됩니다. 이 셋이 그대로 공개 배지에 적히므로, 비어 있으면
        배지가 “무엇을 어떻게 언제 확인했는지” 말하지 못합니다.
      </p>

      <fieldset>
        <legend className="label">확인 방식 (강도)</legend>
        <div className="flex flex-col gap-2">
          {DECIDABLE_METHODS.map((m) => {
            const weak = !isAtLeast(m, detail.minMethod);
            return (
              <label
                key={m}
                className={`flex items-start gap-2.5 text-[14px] ${weak ? "text-[var(--fg-mute)]" : ""}`}
              >
                <input
                  type="radio"
                  name="approve-method"
                  className="mt-[3px] size-4 accent-[var(--accent)]"
                  value={m}
                  checked={method === m}
                  disabled={weak}
                  onChange={() => setMethod(m)}
                />
                <span>
                  {METHOD_LABEL_KO[m]}
                  {weak ? (
                    <span className="block text-[12.5px]">
                      이 유형의 최소 강도({METHOD_LABEL_KO[detail.minMethod]})보다 약해 선택할 수 없습니다.
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
          “{METHOD_LABEL_KO.self_declared}”는 선택지에 없습니다 — 자기기재 항목은 어떤 경로로도 승인되지
          않습니다. 근거를 확인하지 못했다면 승인하지 말고 추가 정보를 요청하세요.
        </p>
      </fieldset>

      <div>
        <label className="label" htmlFor="approve-scope">
          확인 범위 <span aria-hidden="true">·</span> 필수
        </label>
        <input
          id="approve-scope"
          className="field"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          maxLength={200}
          placeholder="예: 2020-03 ~ 2024-11 재직, 영업 직군"
          required
          aria-describedby="approve-scope-note"
        />
        <p id="approve-scope-note" className="mt-1.5 text-[12.5px] text-[var(--fg-mute)]">
          무엇이 확인되었는지 적습니다. 범위를 넘는 보증으로 읽히지 않게 기간·역할·대상을 좁혀 씁니다.
        </p>
      </div>

      <fieldset>
        <legend className="label">유효기간</legend>
        <div className="flex flex-col gap-2 text-[14px]">
          <label className="flex items-start gap-2.5">
            <input
              type="radio"
              name="approve-expiry"
              className="mt-[3px] size-4 accent-[var(--accent)]"
              checked={expiry === "type_default"}
              onChange={() => setExpiry("type_default")}
            />
            <span>
              {detail.defaultTtlDays === null
                ? "유형 기본값 — 이 유형에는 기본 유효기간이 없어 만료일 없이 발급됩니다"
                : `유형 기본값 — 확인일부터 ${detail.defaultTtlDays}일`}
            </span>
          </label>
          <label className="flex items-start gap-2.5">
            <input
              type="radio"
              name="approve-expiry"
              className="mt-[3px] size-4 accent-[var(--accent)]"
              checked={expiry === "custom"}
              onChange={() => setExpiry("custom")}
            />
            <span>직접 지정</span>
          </label>
          {expiry === "custom" ? (
            <div className="ml-7 max-w-[220px]">
              <label className="label" htmlFor="approve-expires">
                만료일 (UTC 기준, 해당 날짜 끝까지)
              </label>
              <input
                id="approve-expires"
                className="field"
                type="date"
                value={customDay}
                onChange={(e) => setCustomDay(e.target.value)}
                required
              />
            </div>
          ) : null}
        </div>
      </fieldset>

      <div>
        <label className="label" htmlFor="approve-message">
          당사자 안내 (선택)
        </label>
        <textarea
          id="approve-message"
          className="field min-h-20"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={300}
          rows={2}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
          {busy ? "처리 중…" : "승인"}
        </button>
        {!ready ? (
          <span className="text-[12.5px] text-[var(--fg-mute)]">방식·범위·유효기간을 모두 지정해야 활성화됩니다.</span>
        ) : null}
      </div>

      <FeedbackLine feedback={feedback} />
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// P-162 반려
// ─────────────────────────────────────────────────────────────────────────────

function RejectForm({ detail, onChanged }: { detail: EvidenceDetail; onChanged: () => void }) {
  const [reasonCode, setReasonCode] = useState("");
  const [method, setMethod] = useState<VerificationMethod | "">("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const codeError = reasonCodeError(reasonCode);

  const submit = async () => {
    setTouched(true);
    if (codeError) return;
    setBusy(true);
    setFeedback(null);
    try {
      const out = await api<TransitionOutcome>(`/admin/verifications/${detail.evidenceId}/reject`, {
        method: "POST",
        body: {
          reasonCode: reasonCode.trim(),
          ...(method ? { method } : {}),
          ...(message.trim() ? { message: message.trim() } : {}),
        },
      });
      setFeedback({ ok: true, text: outcomeText("반려했습니다", out) });
      onChanged();
    } catch (e) {
      setFeedback({ ok: false, text: errorText(e, "반려하지 못했습니다.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card flex flex-col gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-[17px] font-semibold">반려</h3>
      <p className="text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
        사유 코드가 필수입니다. 코드는 집계용이고, 당사자에게 전달되는 것은 아래 안내 문구입니다.
      </p>

      <ReasonCodeSelect id="reject-reason" value={reasonCode} onChange={setReasonCode} showError={touched} />

      <div>
        <label className="label" htmlFor="reject-method">
          확인 강도 (선택)
        </label>
        <select
          id="reject-method"
          className="field"
          value={method}
          onChange={(e) => setMethod(e.target.value as VerificationMethod | "")}
          aria-describedby="reject-method-note"
        >
          <option value="">직전 판정의 강도를 그대로 사용</option>
          {DECIDABLE_METHODS.map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL_KO[m]}
            </option>
          ))}
        </select>
        <p id="reject-method-note" className="mt-1.5 text-[12.5px] text-[var(--fg-mute)]">
          어떤 강도로 들여다본 끝에 반려했는지를 기록에 남깁니다.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="reject-message">
          당사자 안내 (선택)
        </label>
        <textarea
          id="reject-message"
          className="field min-h-24"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={300}
          rows={3}
          aria-describedby="reject-message-note"
        />
        <p id="reject-message-note" className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
          이의제기로 이어질 수 있는 단계입니다. 무엇이 확인되지 않았는지 사실만 적고, 단정적인 비난 표현은
          쓰지 않습니다.
        </p>
      </div>

      <button type="submit" className="btn btn-ghost self-start" disabled={busy}>
        {busy ? "처리 중…" : "반려"}
      </button>

      <FeedbackLine feedback={feedback} />
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// P-163 추가 정보 요청
// ─────────────────────────────────────────────────────────────────────────────

function RequestInfoForm({ detail, onChanged }: { detail: EvidenceDetail; onChanged: () => void }) {
  const [message, setMessage] = useState("");
  const [method, setMethod] = useState<VerificationMethod | "">("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const ready = message.trim().length >= 5;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setFeedback(null);
    try {
      const out = await api<TransitionOutcome>(`/admin/verifications/${detail.evidenceId}/request-info`, {
        method: "POST",
        body: {
          message: message.trim(),
          ...(method ? { method } : {}),
        },
      });
      setFeedback({ ok: true, text: outcomeText("추가 정보를 요청했습니다", out) });
      onChanged();
    } catch (e) {
      setFeedback({ ok: false, text: errorText(e, "요청하지 못했습니다.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card flex flex-col gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-[17px] font-semibold">추가 정보 요청</h3>

      <div>
        <label className="label" htmlFor="info-message">
          무엇을 더 제출해야 하는지 <span aria-hidden="true">·</span> 필수 (5자 이상)
        </label>
        <textarea
          id="info-message"
          className="field min-h-24"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={300}
          rows={3}
          required
          aria-describedby="info-message-note"
        />
        <p id="info-message-note" className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
          이 문구가 당사자에게 전달됩니다. “추가 정보 필요”만 적으면 무엇을 올려야 하는지 알 수 없고,
          그 증거는 큐에서 사라진 채 멈춥니다.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="info-method">
          확인 강도 (선택)
        </label>
        <select
          id="info-method"
          className="field"
          value={method}
          onChange={(e) => setMethod(e.target.value as VerificationMethod | "")}
        >
          <option value="">직전 판정의 강도를 그대로 사용</option>
          {DECIDABLE_METHODS.map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL_KO[m]}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" className="btn btn-ghost self-start" disabled={busy || !ready}>
        {busy ? "처리 중…" : "추가 정보 요청"}
      </button>

      <FeedbackLine feedback={feedback} />
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// P-164 내부 메모
// ─────────────────────────────────────────────────────────────────────────────

function NoteForm({ detail, onChanged }: { detail: EvidenceDetail; onChanged: () => void }) {
  const [picked, setPicked] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  /**
   * 선택값을 state 초기값으로 굳히지 않고 **파생**시킨다: 승인·반려를 처리하면 판정 행이 새로 생기고
   * `detail` 이 갱신되는데, 초기값으로 두면 "방금 판정했는데 메모 대상이 비어 있다"가 된다.
   */
  const verificationId = picked || (detail.verifications[0]?.id ?? "");
  const ready = verificationId.length > 0 && note.trim().length >= 2;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setFeedback(null);
    try {
      // 여기만 {id} 가 **검증 id** 다 (파일 상단 주석).
      await api<{ noteId: string }>(`/admin/verifications/${verificationId}/notes`, {
        method: "POST",
        body: { note: note.trim() },
      });
      setNote("");
      setFeedback({ ok: true, text: "메모를 저장했습니다." });
      onChanged();
    } catch (e) {
      setFeedback({ ok: false, text: errorText(e, "메모를 저장하지 못했습니다.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card flex flex-col gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-[17px] font-semibold">내부 메모</h3>
      <p className="text-[13.5px] font-semibold text-[var(--accent-text)]">
        당사자에게 보이지 않습니다. 공개 프로필에도 나가지 않습니다.
      </p>
      <p className="text-[13px] leading-relaxed text-[var(--fg-mute)]">
        판단 재료를 남기는 곳입니다(발급기관 통화 결과, 같은 서류가 다른 계정에서도 올라옴 등).
        당사자에게 전할 말은 반려·추가 정보 요청의 안내 문구에 적습니다.
      </p>

      {detail.verifications.length === 0 ? (
        <p className="panel p-4 text-[13.5px] text-[var(--fg-mute)]">
          메모는 판정 행에 붙습니다. 아직 판정 이력이 없어 메모를 남길 수 없습니다 — 먼저 승인·반려·추가 정보
          요청 중 하나를 처리하세요.
        </p>
      ) : (
        <>
          <div>
            <label className="label" htmlFor="note-verification">
              어느 판정에 대한 메모인지
            </label>
            <select
              id="note-verification"
              className="field"
              value={verificationId}
              onChange={(e) => setPicked(e.target.value)}
            >
              {detail.verifications.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.status} · {METHOD_LABEL_KO[v.method]} · {v.createdAt.slice(0, 16).replace("T", " ")} · {v.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="note-body">
              메모 <span aria-hidden="true">·</span> 필수 (2자 이상)
            </label>
            <textarea
              id="note-body"
              className="field min-h-28"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={4000}
              rows={4}
              required
            />
          </div>

          <button type="submit" className="btn btn-ghost self-start" disabled={busy || !ready}>
            {busy ? "저장 중…" : "메모 저장"}
          </button>
        </>
      )}

      <FeedbackLine feedback={feedback} />
    </form>
  );
}

export function ReviewPanel({ detail, onChanged }: { detail: EvidenceDetail; onChanged: () => void }) {
  return (
    <section aria-labelledby="review-panel" className="flex flex-col gap-4">
      <div>
        <h2 id="review-panel" className="text-[19px] font-semibold">
          검토 결정
        </h2>
        <p className="mt-1 text-[13.5px] text-[var(--fg-mute)]">
          결정은 모두 감사로그에 남습니다. 어떤 결정이 가능한지는 서버가 판정하므로, 불가능한 조합은
          실패 메시지로 알려 줍니다.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ApproveForm detail={detail} onChanged={onChanged} />
        <RejectForm detail={detail} onChanged={onChanged} />
        <RequestInfoForm detail={detail} onChanged={onChanged} />
        <NoteForm detail={detail} onChanged={onChanged} />
      </div>
    </section>
  );
}
