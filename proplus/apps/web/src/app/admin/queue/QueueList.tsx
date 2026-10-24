"use client";

/**
 * P-160 검토 큐의 상호작용 부분 — 상태 묶음 · 유형 필터 · 경과 시간 강조.
 *
 * ## 경과 시간을 "SLA 초과"라고 적지 않는 이유
 *
 * 처리시간 SLA 목표치는 아직 미확정이다(전략 §8 / 로드맵 미결정 §2). 임의의 숫자를 코드에 박아 두고
 * "SLA 초과"라고 적으면, 확정되지 않은 기준이 화면에서 확정된 사실처럼 보인다. 그래서 기준값은
 * **운영자가 조정하는 표시 기준**으로 두고 라벨도 "표시 기준"이라고 적는다. 기본값 48시간은
 * 정책이 아니라 초기값이다.
 *
 * ## 색만으로 말하지 않는다 (P-193 / 브랜드 §7)
 *
 * 지연 표시는 색(--pending) + 아이콘 + "표시 기준 초과" 문장 세 가지를 함께 쓴다.
 * 색을 못 보는 사람에게도, 흑백으로 인쇄해도 같은 정보가 남아야 한다.
 */

import type { admin } from "@proplus/api";
import { METHOD_LABEL_KO, type ProofStatus } from "@proplus/domain";
import Link from "next/link";
import { useCallback, useState } from "react";
import { ClientError, api, fmtDateTime } from "@/lib/client";

type ReviewQueue = admin.ReviewQueue;
type ReviewQueueItem = admin.ReviewQueueItem;

/** P-160 "대기·처리중·완료 구분". 큐에 머무는 세 상태가 곧 이 세 묶음이다. */
const GROUPS: readonly { status: ProofStatus; title: string; desc: string }[] = [
  { status: "submitted", title: "대기", desc: "제출된 뒤 아직 검토가 시작되지 않은 건입니다." },
  { status: "under_review", title: "처리중", desc: "검토가 시작된 건입니다." },
  { status: "needs_more_info", title: "추가정보 필요", desc: "당사자의 보완 제출을 기다리는 건입니다." },
];

const STATUS_LABEL_KO: Readonly<Record<string, string>> = {
  submitted: "대기",
  under_review: "처리중",
  needs_more_info: "추가정보 필요",
  verified: "승인",
  rejected: "반려",
  expired: "만료",
  revoked: "취소",
  disputed: "재확인 중",
};

const SUBJECT_LABEL_KO: Readonly<Record<"profile" | "organization", string>> = {
  profile: "개인 프로필",
  organization: "조직",
};

function waitingLabel(h: number): string {
  if (h < 1) return "1시간 미만";
  if (h < 48) return `${Math.floor(h)}시간`;
  const days = Math.floor(h / 24);
  const rest = Math.floor(h % 24);
  return rest > 0 ? `${days}일 ${rest}시간` : `${days}일`;
}

function ClockIcon() {
  return (
    <svg
      className="size-4 flex-none"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.4" />
      <polyline points="8,4.6 8,8.2 10.7,9.7" />
    </svg>
  );
}

function QueueRow({ item, emphasisHours }: { item: ReviewQueueItem; emphasisHours: number }) {
  const overdue = item.waitingHours >= emphasisHours;

  return (
    <li
      className={`card flex flex-col gap-3 p-4${overdue ? " border-l-4 border-l-[var(--pending)]" : ""}`}
      data-testid="queue-row"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h4 className="text-[16.5px] font-semibold">{item.typeLabelKo}</h4>
        <code className="text-[12px] text-[var(--fg-mute)]">{item.evidenceType}</code>
        <span className="chip font-semibold">{STATUS_LABEL_KO[item.status] ?? item.status}</span>
        {overdue ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--pending)]">
            <ClockIcon />
            표시 기준 초과
          </span>
        ) : null}
      </div>

      <dl className="grid gap-x-6 gap-y-1.5 text-[13.5px] sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-[var(--fg-mute)]">요구 강도</dt>
          <dd className="font-semibold">{METHOD_LABEL_KO[item.minMethod]} 이상</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-[var(--fg-mute)]">제출</dt>
          <dd>{fmtDateTime(item.submittedAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-[var(--fg-mute)]">경과</dt>
          <dd className={overdue ? "font-semibold text-[var(--pending)]" : ""}>{waitingLabel(item.waitingHours)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-[var(--fg-mute)]">대상</dt>
          <dd>
            {SUBJECT_LABEL_KO[item.subjectType]}
            {item.subjectSlug ? ` · ${item.subjectSlug}` : " · 공개 식별자 없음"}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-[var(--fg-mute)]">첨부</dt>
          <dd>{item.fileCount}개</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-[var(--fg-mute)]">발급기관</dt>
          <dd>
            {item.requiresIssuer
              ? item.issuerName
                ? `${item.issuerName} · ${item.issuerAuthorityChecked ? "기관 권한 확인됨" : "기관 권한 미확인"}`
                : "필요 — 아직 지정되지 않음"
              : "요구되지 않음"}
          </dd>
        </div>
      </dl>

      {/* 열린 이의제기가 있는 건은 재심 중이므로 일반 승인 흐름과 다르게 다뤄야 한다 (P-168). */}
      {item.openAppeals > 0 ? (
        <p className="text-[13px] font-semibold text-[var(--caution)]">
          진행 중인 이의제기 {item.openAppeals}건 — 이의제기 화면에서 먼저 처리하세요.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/admin/evidence/${item.evidenceId}`} className="btn btn-ghost !min-h-11 text-[14px]">
          증거 상세 열기
        </Link>
        <span className="text-[12.5px] text-[var(--fg-mute)]">다음 화면에서 접근 사유를 입력해야 내용이 열립니다.</span>
      </div>
    </li>
  );
}

interface QueueListProps {
  initial: ReviewQueue;
  initialStatuses: readonly ProofStatus[];
  initialType: string;
}

export function QueueList({ initial, initialStatuses, initialType }: QueueListProps) {
  const [queue, setQueue] = useState<ReviewQueue>(initial);
  const [statuses, setStatuses] = useState<readonly ProofStatus[]>(initialStatuses);
  const [type, setType] = useState(initialType);
  const [emphasisHours, setEmphasisHours] = useState(48);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextStatuses: readonly ProofStatus[], nextType: string) => {
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ status: nextStatuses.join(",") });
      if (nextType.trim()) qs.set("type", nextType.trim());
      setQueue(await api<ReviewQueue>(`/admin/queue?${qs.toString()}`));
    } catch (e) {
      // 서버가 준 메시지를 그대로 보여준다 — UI 가 원인을 추측해 적지 않는다 (전략 §3).
      setError(e instanceof ClientError ? e.message : "큐를 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleStatus = (status: ProofStatus) => {
    const next = statuses.includes(status) ? statuses.filter((s) => s !== status) : [...statuses, status];
    // 전부 해제하면 모듈이 기본 범위로 떨어져 "필터를 껐는데 결과가 그대로"로 보인다. 마지막 하나는 남긴다.
    if (next.length === 0) return;
    setStatuses(next);
    void load(next, type);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="panel flex flex-col gap-4 p-5">
        <fieldset>
          <legend className="label">표시할 상태</legend>
          <div className="flex flex-wrap gap-2">
            {GROUPS.map((g) => {
              const on = statuses.includes(g.status);
              return (
                <label
                  key={g.status}
                  className={`chip cursor-pointer gap-2 ${on ? "font-semibold text-[var(--accent-text)]" : "text-[var(--fg-mute)]"}`}
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    checked={on}
                    onChange={() => toggleStatus(g.status)}
                  />
                  {g.title}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[180px]">
            <label className="label" htmlFor="queue-type">
              증거 유형 코드
            </label>
            <input
              id="queue-type"
              className="field"
              value={type}
              placeholder="예: license"
              onChange={(e) => setType(e.target.value)}
            />
          </div>
          <div className="min-w-[150px]">
            <label className="label" htmlFor="queue-emphasis">
              강조 표시 기준 (시간)
            </label>
            <input
              id="queue-emphasis"
              className="field"
              type="number"
              min={1}
              max={720}
              value={emphasisHours}
              onChange={(e) => setEmphasisHours(Math.max(1, Number(e.target.value) || 1))}
              aria-describedby="queue-emphasis-note"
            />
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => void load(statuses, type)} disabled={busy}>
            {busy ? "불러오는 중…" : "적용"}
          </button>
          <p id="queue-emphasis-note" className="w-full text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
            목표 처리시간(SLA)은 아직 확정되지 않았습니다. 이 값은 정책이 아니라 화면에서 눈에 띄게 할 기준이며,
            기준을 넘긴 건에는 경과 시간과 함께 “표시 기준 초과”가 적힙니다.
          </p>
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {busy ? "큐를 불러오는 중입니다." : `${queue.items.length}건을 표시하고 있습니다.`}
      </p>

      {error ? (
        <p role="alert" className="card border-[var(--caution)] p-4 text-[14px] text-[var(--caution)]">
          {error}
        </p>
      ) : null}

      {GROUPS.filter((g) => statuses.includes(g.status)).map((g) => {
        // 모듈이 제출 순(ASC)으로 돌려주므로 묶기만 하면 각 묶음도 오래된 건이 위에 온다.
        const rows = queue.items.filter((i) => i.status === g.status);
        return (
          <section key={g.status} aria-labelledby={`queue-${g.status}`} className="flex flex-col gap-3">
            <div>
              <h2 id={`queue-${g.status}`} className="text-[19px] font-semibold">
                {g.title} <span className="text-[var(--fg-mute)]">{rows.length}건</span>
              </h2>
              <p className="mt-1 text-[13.5px] text-[var(--fg-mute)]">{g.desc}</p>
            </div>
            {rows.length === 0 ? (
              <p className="panel p-4 text-[14px] text-[var(--fg-mute)]">이 상태의 건이 없습니다.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {rows.map((item) => (
                  <QueueRow key={item.evidenceId} item={item} emphasisHours={emphasisHours} />
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {/*
        countsByStatus 는 **필터와 무관한 전체 증거의 상태 분포**다(모듈이 조건 없이 GROUP BY 한다).
        "현재 큐의 건수"로 적으면 숫자가 위 묶음과 어긋나 보이므로 범위를 분명히 적는다.
      */}
      <section aria-labelledby="queue-counts" className="panel flex flex-col gap-2 p-5">
        <h2 id="queue-counts" className="text-[15px] font-semibold">
          전체 증거 상태 분포
        </h2>
        <p className="text-[12.5px] text-[var(--fg-mute)]">
          위 필터와 무관하게 저장된 모든 증거를 상태별로 센 값입니다.
        </p>
        <ul className="mt-1 flex flex-wrap gap-2">
          {Object.entries(queue.countsByStatus).map(([status, n]) => (
            <li key={status} className="chip">
              {STATUS_LABEL_KO[status] ?? status} {n}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
