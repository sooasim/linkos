"use client";

/**
 * P-167 / P-170 신고 큐의 상호작용 부분.
 *
 * ## 같은 대상에 몰린 신고를 표시하는 방식
 *
 * `admin.reportQueue()` 응답에는 **신고자가 없다**(`ReportItem` 에 reporter 필드가 없다). 그래서
 * "한 사람이 여러 건 올렸다"는 화면에서 말할 수 없고, 말하지 않는다 — 없는 데이터로 표적 신고를
 * 단정하면 그 판단 자체가 틀린 근거 위에 서게 된다. 여기서 할 수 있는 것은 **같은 대상에 몇 건이
 * 모였는지** 세는 것까지이고, 신고자 확인은 감사로그(`report.created` 의 actor)로 링크를 건다.
 *
 * ## 조치와 종결이 분리된 이유
 *
 * 이 폼은 `reports.status` 만 바꾼다. 프로필 비공개·배지 취소는 각 담당 모듈의 경로다.
 * 한 버튼으로 묶으면 "누가 무엇을 바꿨는가"가 감사로그에서 뒤섞인다.
 */

import type { admin } from "@proplus/api";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { ClientError, api, fmtDateTime } from "@/lib/client";

type ReportItem = admin.ReportItem;
type ReportAction = admin.ReportAction;

const SUBJECT_LABEL_KO: Readonly<Record<string, string>> = {
  profile: "프로필",
  badge: "배지",
  offer: "제공 항목",
  lead: "상담 요청",
};

const STATUS_LABEL_KO: Readonly<Record<string, string>> = {
  open: "접수",
  in_review: "검토중",
  actioned: "조치",
  dismissed: "기각",
};

const ACTIONS: readonly { value: ReportAction; label: string; hint: string }[] = [
  { value: "in_review", label: "검토 시작", hint: "처리 완료 시각을 찍지 않습니다 — 처리시간 집계가 왜곡되지 않게." },
  { value: "actioned", label: "조치", hint: "실제 집행(비공개·배지 취소)은 담당 화면에서 따로 실행합니다." },
  { value: "dismissed", label: "기각", hint: "조치하지 않기로 결정한 경우입니다." },
];

const FILTERS: readonly { value: string; label: string }[] = [
  { value: "open", label: "접수" },
  { value: "in_review", label: "검토중" },
  { value: "actioned", label: "조치" },
  { value: "dismissed", label: "기각" },
  { value: "all", label: "전체" },
];

function openLabel(h: number): string {
  if (h < 1) return "1시간 미만";
  if (h < 48) return `${Math.floor(h)}시간`;
  const days = Math.floor(h / 24);
  const rest = Math.floor(h % 24);
  return rest > 0 ? `${days}일 ${rest}시간` : `${days}일`;
}

function ReportRow({
  item,
  sameSubjectCount,
  onChanged,
}: {
  item: ReportItem;
  sameSubjectCount: number;
  onChanged: () => void;
}) {
  const [action, setAction] = useState<ReportAction | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const ready = action !== "" && reason.trim().length >= 3;

  const submit = async () => {
    // `ready` 가 action !== "" 를 포함하므로 여기서 action 은 세 조치 중 하나로 좁혀져 있다.
    if (!ready) return;
    setBusy(true);
    setFeedback(null);
    try {
      const out = await api<{ reportId: string; status: string }>(`/admin/reports/${item.reportId}`, {
        method: "POST",
        body: { action, reason: reason.trim() },
      });
      setFeedback({ ok: true, text: `처리했습니다 — 현재 상태 ${STATUS_LABEL_KO[out.status] ?? out.status}.` });
      onChanged();
    } catch (e) {
      setFeedback({ ok: false, text: e instanceof ClientError ? e.message : "처리하지 못했습니다." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="card flex flex-col gap-4 p-5" data-testid="report-row">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h3 className="text-[16.5px] font-semibold">
          {SUBJECT_LABEL_KO[item.subjectType] ?? item.subjectType} 신고
        </h3>
        <span className="chip font-semibold">{STATUS_LABEL_KO[item.status] ?? item.status}</span>
        <code className="text-[12px] text-[var(--fg-mute)]">{item.reasonCode}</code>
        {sameSubjectCount > 1 ? (
          <span className="text-[13px] font-semibold text-[var(--pending)]">
            같은 대상에 {sameSubjectCount}건
          </span>
        ) : null}
      </div>

      <dl className="grid gap-x-6 gap-y-1.5 text-[13.5px] sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-[var(--fg-mute)]">접수</dt>
          <dd>{fmtDateTime(item.createdAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-[var(--fg-mute)]">{item.handledAt ? "처리까지" : "경과"}</dt>
          <dd>{openLabel(item.openHours)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-[var(--fg-mute)]">대상 ID</dt>
          <dd>
            <code className="text-[12.5px]">{item.subjectId}</code>
          </dd>
        </div>
        {item.handledAt ? (
          <div className="flex gap-2">
            <dt className="text-[var(--fg-mute)]">처리</dt>
            <dd>{fmtDateTime(item.handledAt)}</dd>
          </div>
        ) : null}
      </dl>

      {item.detail ? (
        <div className="panel p-4">
          <p className="text-[12.5px] font-semibold text-[var(--fg-mute)]">신고 내용</p>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-[14px]">{item.detail}</p>
        </div>
      ) : (
        <p className="text-[13px] text-[var(--fg-mute)]">신고자가 상세 내용을 적지 않았습니다.</p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <Link
          href={`/admin/audit?type=report&id=${item.reportId}`}
          className="text-[var(--accent-text)] hover:underline"
        >
          이 신고의 감사로그 (신고자·처리 이력)
        </Link>
      </div>

      <form
        className="flex flex-col gap-4 border-t border-[var(--line)] pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset>
          <legend className="label">처리 조치</legend>
          <div className="flex flex-col gap-2 text-[14px]">
            {ACTIONS.map((a) => (
              <label key={a.value} className="flex items-start gap-2.5">
                <input
                  type="radio"
                  name={`action-${item.reportId}`}
                  className="mt-[3px] size-4 accent-[var(--accent)]"
                  checked={action === a.value}
                  onChange={() => setAction(a.value)}
                />
                <span>
                  {a.label}
                  <span className="block text-[12.5px] text-[var(--fg-mute)]">{a.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label className="label" htmlFor={`reason-${item.reportId}`}>
            처리 사유 <span aria-hidden="true">·</span> 필수 (3자 이상)
          </label>
          <textarea
            id={`reason-${item.reportId}`}
            className="field min-h-20"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            rows={3}
            required
            aria-describedby={`reason-note-${item.reportId}`}
          />
          <p id={`reason-note-${item.reportId}`} className="mt-1.5 text-[12.5px] text-[var(--fg-mute)]">
            조치와 사유가 감사로그에 남습니다.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-ghost" disabled={busy || !ready}>
            {busy ? "처리 중…" : "처리 기록"}
          </button>
          {/* 아무것도 고르지 않은 상태에서 미리 재촉하지 않는다 — 조치를 고른 뒤에만 안내한다. */}
          {action !== "" && !ready ? (
            <span className="text-[12.5px] text-[var(--fg-mute)]">처리 사유를 3자 이상 입력하세요.</span>
          ) : null}
        </div>
      </form>

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

export function ReportList({ initial, status }: { initial: ReportItem[]; status: string }) {
  const [items, setItems] = useState<ReportItem[]>(initial);
  const [filter, setFilter] = useState(status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 같은 대상 ID 가 몇 번 나오는지. **현재 목록 안에서만** 센 값이므로 화면에도 그렇게 적는다. */
  const countBySubject = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of items) m.set(r.subjectId, (m.get(r.subjectId) ?? 0) + 1);
    return m;
  }, [items]);

  const clustered = useMemo(
    () => [...countBySubject.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]),
    [countBySubject],
  );

  const load = useCallback(async (next: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ items: ReportItem[] }>(`/admin/reports?status=${encodeURIComponent(next)}`);
      setItems(res.items);
    } catch (e) {
      setError(e instanceof ClientError ? e.message : "신고를 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <div className="panel flex flex-wrap items-end gap-3 p-5">
        <div className="min-w-[180px]">
          <label className="label" htmlFor="report-filter">
            처리 상태
          </label>
          <select
            id="report-filter"
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

      {clustered.length > 0 ? (
        <section aria-labelledby="report-clusters" className="panel flex flex-col gap-2 p-5">
          <h2 id="report-clusters" className="text-[15px] font-semibold">
            같은 대상에 여러 건이 모인 경우
          </h2>
          <p className="text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
            지금 표시된 목록 안에서 센 값입니다. 신고자 정보는 이 목록에 포함되지 않으므로, 한 사람이 여러 건을
            올린 것인지는 각 건의 감사로그에서 확인해야 합니다.
          </p>
          <ul className="mt-1 flex flex-col gap-1.5 text-[13.5px]">
            {clustered.map(([subjectId, n]) => (
              <li key={subjectId} className="flex flex-wrap items-center gap-2">
                <code className="text-[12.5px]">{subjectId}</code>
                <span className="font-semibold text-[var(--pending)]">{n}건</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {busy ? "불러오는 중입니다." : `${items.length}건을 표시하고 있습니다.`}
      </p>

      {error ? (
        <p role="alert" className="card border-[var(--caution)] p-4 text-[14px] text-[var(--caution)]">
          {error}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="panel p-5 text-[14px] text-[var(--fg-mute)]">해당하는 신고가 없습니다.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((item) => (
            <ReportRow
              key={item.reportId}
              item={item}
              sameSubjectCount={countBySubject.get(item.subjectId) ?? 1}
              onChanged={() => void load(filter)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
