"use client";

/**
 * P-168 이의제기 처리 폼.
 *
 * ## 보낸 키만 담는다 (라우트 주석 #9)
 *
 * `decision` 은 생략 가능하고, 생략하면 모듈이 기본값을 쓴다:
 *   번복 → `under_review`(재심) · 유지 → 분쟁 전 결정 복원.
 * 모듈은 `decision.scope === undefined`("지정 안 함")와 `null`("비우라는 지시")를 구분한다.
 * 그래서 **빈 입력을 null 로 채워 보내면 복원이 깨진다** — 원래 범위가 지워진 채 복원된다.
 * 이 파일의 모든 payload 조립이 `...(value ? { key } : {})` 꼴인 이유가 그것이고,
 * 비우기 전용 UI 는 두지 않았다(지금 필요한 조작이 아니고, 실수의 대가가 복원 실패다).
 *
 * ## 결과를 두 값으로만 받는 이유
 *
 * `upheld` / `overturned` 가 번복률의 분모·분자다. "처리됨" 같은 중립 라벨을 더하면 집계가 흐려진다.
 */

import type { admin } from "@proplus/api";
import { METHOD_LABEL_KO, VERIFICATION_METHODS, type VerificationMethod } from "@proplus/domain";
import Link from "next/link";
import { useCallback, useState } from "react";
import { ClientError, api, fmtDateTime } from "@/lib/client";
import { ReasonCodeSelect, reasonCodeError } from "@/components/ReasonCodeSelect";

type AppealItem = admin.AppealItem;

/** N-1: 자기기재는 판정 강도의 선택지가 아니다 (증거 상세의 승인 폼과 같은 규칙). */
const DECIDABLE_METHODS = VERIFICATION_METHODS.filter((m) => m !== "self_declared");

const STATUS_LABEL_KO: Readonly<Record<string, string>> = {
  open: "처리 전",
  upheld: "원 결정 유지",
  overturned: "번복",
  submitted: "대기",
  under_review: "처리중",
  needs_more_info: "추가정보 필요",
  verified: "승인",
  rejected: "반려",
  expired: "만료",
  revoked: "취소",
  disputed: "재확인 중",
};

const FILTERS: readonly { value: string; label: string }[] = [
  { value: "open", label: "처리 전" },
  { value: "upheld", label: "원 결정 유지" },
  { value: "overturned", label: "번복" },
  { value: "all", label: "전체" },
];

function openLabel(h: number): string {
  if (h < 1) return "1시간 미만";
  if (h < 48) return `${Math.floor(h)}시간`;
  const days = Math.floor(h / 24);
  const rest = Math.floor(h % 24);
  return rest > 0 ? `${days}일 ${rest}시간` : `${days}일`;
}

interface ResolveResult {
  appealId: string;
  outcome: "upheld" | "overturned";
  evidenceStatus: string;
  verificationId: string | null;
}

function AppealRow({ item, onChanged }: { item: AppealItem; onChanged: () => void }) {
  const [outcome, setOutcome] = useState<"" | "upheld" | "overturned">("");
  const [resolution, setResolution] = useState("");
  const [to, setTo] = useState<"" | "under_review" | "verified" | "rejected">("");
  const [method, setMethod] = useState<VerificationMethod | "">("");
  const [scope, setScope] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [expiresDay, setExpiresDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const open = item.status === "open";
  const needsReasonCode = to === "rejected";
  const codeError = needsReasonCode ? reasonCodeError(reasonCode) : null;
  const ready = outcome !== "" && resolution.trim().length >= 5 && codeError === null;

  const submit = async () => {
    setTouched(true);
    // `ready` 가 outcome !== "" 를 포함하므로 여기서 outcome 은 두 값 중 하나로 좁혀져 있다.
    if (!ready) return;
    setBusy(true);
    setFeedback(null);
    try {
      // 값이 있는 키만 담는다 (파일 상단 주석). 빈 문자열을 null 로 바꾸지 않는다.
      const decision = {
        ...(to ? { to } : {}),
        ...(method ? { method } : {}),
        ...(scope.trim() ? { scope: scope.trim() } : {}),
        ...(needsReasonCode && reasonCode.trim() ? { reasonCode: reasonCode.trim() } : {}),
        ...(expiresDay.length === 10 ? { expiresAt: `${expiresDay}T23:59:59.000Z` } : {}),
      };
      const out = await api<ResolveResult>(`/admin/appeals/${item.appealId}`, {
        method: "POST",
        body: {
          outcome,
          resolution: resolution.trim(),
          ...(Object.keys(decision).length > 0 ? { decision } : {}),
        },
      });
      setFeedback({
        ok: true,
        text: `${STATUS_LABEL_KO[out.outcome] ?? out.outcome}(으)로 처리했습니다 — 증거 상태 ${
          STATUS_LABEL_KO[out.evidenceStatus] ?? out.evidenceStatus
        }.`,
      });
      onChanged();
    } catch (e) {
      setFeedback({ ok: false, text: e instanceof ClientError ? e.message : "처리하지 못했습니다." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="card flex flex-col gap-4 p-5" data-testid="appeal-row">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h3 className="text-[16.5px] font-semibold">{STATUS_LABEL_KO[item.status] ?? item.status}</h3>
        <code className="text-[12px] text-[var(--fg-mute)]">{item.evidenceType}</code>
        <span className="chip">증거 {STATUS_LABEL_KO[item.evidenceStatus] ?? item.evidenceStatus}</span>
        <span className="chip">판정 {STATUS_LABEL_KO[item.verificationStatus] ?? item.verificationStatus}</span>
      </div>

      <dl className="grid gap-x-6 gap-y-1.5 text-[13.5px] sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-[var(--fg-mute)]">접수</dt>
          <dd>{fmtDateTime(item.createdAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-[var(--fg-mute)]">{item.resolvedAt ? "처리까지" : "경과"}</dt>
          <dd>{openLabel(item.openHours)}</dd>
        </div>
        {item.resolvedAt ? (
          <div className="flex gap-2">
            <dt className="text-[var(--fg-mute)]">처리</dt>
            <dd>{fmtDateTime(item.resolvedAt)}</dd>
          </div>
        ) : null}
      </dl>

      <div className="panel p-4">
        <p className="text-[12.5px] font-semibold text-[var(--fg-mute)]">당사자가 적은 이의 사유</p>
        <p className="mt-1.5 whitespace-pre-wrap break-words text-[14px]">{item.reason}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <Link href={`/admin/evidence/${item.evidenceId}`} className="text-[var(--accent-text)] hover:underline">
          증거 상세 열기
        </Link>
        <Link
          href={`/admin/audit?type=appeal&id=${item.appealId}`}
          className="text-[var(--accent-text)] hover:underline"
        >
          이 이의제기의 감사로그
        </Link>
      </div>

      {open ? (
        <form
          className="flex flex-col gap-4 border-t border-[var(--line)] pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset>
            <legend className="label">처리 결과 (번복률 집계에 사용)</legend>
            <div className="flex flex-col gap-2 text-[14px]">
              <label className="flex items-start gap-2.5">
                <input
                  type="radio"
                  name={`outcome-${item.appealId}`}
                  className="mt-[3px] size-4 accent-[var(--accent)]"
                  checked={outcome === "upheld"}
                  onChange={() => setOutcome("upheld")}
                />
                <span>
                  원 결정 유지
                  <span className="block text-[12.5px] text-[var(--fg-mute)]">
                    분쟁 전 결정을 그대로 복원합니다(그때의 강도·범위·사유 코드가 다시 적용됩니다).
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5">
                <input
                  type="radio"
                  name={`outcome-${item.appealId}`}
                  className="mt-[3px] size-4 accent-[var(--accent)]"
                  checked={outcome === "overturned"}
                  onChange={() => setOutcome("overturned")}
                />
                <span>
                  번복
                  <span className="block text-[12.5px] text-[var(--fg-mute)]">
                    기본값은 재검토(처리중)로 되돌리는 것입니다. 아래에서 바로 승인·반려로 보낼 수도 있습니다.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          <div>
            <label className="label" htmlFor={`resolution-${item.appealId}`}>
              처리 사유 <span aria-hidden="true">·</span> 필수 (5자 이상)
            </label>
            <textarea
              id={`resolution-${item.appealId}`}
              className="field min-h-24"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              maxLength={2000}
              rows={3}
              required
              aria-describedby={`resolution-note-${item.appealId}`}
            />
            <p
              id={`resolution-note-${item.appealId}`}
              className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--fg-mute)]"
            >
              이 문구가 당사자 통지에 쓰이고 감사로그에도 남습니다. 단정적인 비난 표현은 쓰지 않습니다.
            </p>
          </div>

          <details className="panel p-4">
            <summary className="cursor-pointer text-[14px] font-semibold">재심 결정을 직접 지정 (선택)</summary>
            <div className="mt-4 flex flex-col gap-4">
              <p className="text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
                비워 두면 위 결과에 따른 기본 처리가 적용됩니다. 지정하지 않은 항목은 아예 보내지 않으므로,
                “원 결정 유지”의 복원이 그대로 동작합니다.
              </p>

              <div>
                <label className="label" htmlFor={`to-${item.appealId}`}>
                  목표 상태
                </label>
                <select
                  id={`to-${item.appealId}`}
                  className="field"
                  value={to}
                  onChange={(e) => setTo(e.target.value as typeof to)}
                >
                  <option value="">기본 처리에 맡김</option>
                  <option value="under_review">처리중 (재검토)</option>
                  <option value="verified">승인</option>
                  <option value="rejected">반려</option>
                </select>
              </div>

              {to === "verified" || to === "rejected" ? (
                <div>
                  <label className="label" htmlFor={`method-${item.appealId}`}>
                    확인 강도
                  </label>
                  <select
                    id={`method-${item.appealId}`}
                    className="field"
                    value={method}
                    onChange={(e) => setMethod(e.target.value as VerificationMethod | "")}
                  >
                    <option value="">지정 안 함</option>
                    {DECIDABLE_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {METHOD_LABEL_KO[m]}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {to === "verified" ? (
                <>
                  <div>
                    <label className="label" htmlFor={`scope-${item.appealId}`}>
                      확인 범위
                    </label>
                    <input
                      id={`scope-${item.appealId}`}
                      className="field"
                      value={scope}
                      onChange={(e) => setScope(e.target.value)}
                      maxLength={200}
                    />
                  </div>
                  <div className="max-w-[220px]">
                    <label className="label" htmlFor={`expires-${item.appealId}`}>
                      만료일 (UTC, 해당 날짜 끝까지)
                    </label>
                    <input
                      id={`expires-${item.appealId}`}
                      className="field"
                      type="date"
                      value={expiresDay}
                      onChange={(e) => setExpiresDay(e.target.value)}
                    />
                  </div>
                </>
              ) : null}

              {needsReasonCode ? (
                <ReasonCodeSelect
                  id={`appeal-reason-${item.appealId}`}
                  value={reasonCode}
                  onChange={setReasonCode}
                  showError={touched}
                />
              ) : null}
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
              {busy ? "처리 중…" : "처리 기록"}
            </button>
            {!ready ? (
              <span className="text-[12.5px] text-[var(--fg-mute)]">결과와 처리 사유를 입력해야 활성화됩니다.</span>
            ) : null}
          </div>
        </form>
      ) : null}

      {feedback ? (
        <p
          role={feedback.ok ? "status" : "alert"}
          className={`text-[13.5px] font-semibold ${feedback.ok ? "text-[var(--verified)]" : "text-[var(--caution)]"}`}
        >
          {feedback.text}
        </p>
      ) : null}
    </li>
  );
}

export function AppealList({ initial, status }: { initial: AppealItem[]; status: string }) {
  const [items, setItems] = useState<AppealItem[]>(initial);
  const [filter, setFilter] = useState(status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (next: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ items: AppealItem[] }>(`/admin/appeals?status=${encodeURIComponent(next)}`);
      setItems(res.items);
    } catch (e) {
      setError(e instanceof ClientError ? e.message : "이의제기를 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <div className="panel flex flex-wrap items-end gap-3 p-5">
        <div className="min-w-[180px]">
          <label className="label" htmlFor="appeal-filter">
            처리 상태
          </label>
          <select
            id="appeal-filter"
            className="field"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              void load(e.target.value);
            }}
          >
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => void load(filter)} disabled={busy}>
          {busy ? "불러오는 중…" : "새로 고침"}
        </button>
      </div>

      <p aria-live="polite" className="sr-only">
        {busy ? "불러오는 중입니다." : `${items.length}건을 표시하고 있습니다.`}
      </p>

      {error ? (
        <p role="alert" className="card border-[var(--caution)] p-4 text-[14px] text-[var(--caution)]">
          {error}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="panel p-5 text-[14px] text-[var(--fg-mute)]">해당하는 이의제기가 없습니다.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((item) => (
            <AppealRow key={item.appealId} item={item} onChanged={() => void load(filter)} />
          ))}
        </ul>
      )}
    </div>
  );
}
