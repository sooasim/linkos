"use client";

/**
 * P-051 증거 목록 렌더링 — 상태별 묶음 + 상태 필터.
 *
 * 클라이언트 컴포넌트인 이유는 **필터 하나**다. 서버 왕복 없이 묶음을 좁히는 것 외에는
 * 상태를 바꾸지 않는다 — 재제출·철회·이의제기는 모두 상세 화면의 일이다.
 * (목록에서 전이를 열면 무엇을 철회했는지 확인하지 않고 누르게 된다.)
 *
 * 묶음 순서의 기준: **당사자가 움직여야 하는 상태가 맨 위**다. `needs_more_info` 는
 * 검토자가 자료를 기다리는 상태여서, 당사자가 모르면 큐에서 영원히 멈춘다 (P-162 통지와 같은 목적).
 *
 * 상태 판단을 여기서 하지 않는다: 각 항목의 `status` 는 서버가 준 값이고, 만료 판정도 서버(읽기 시점, N-9)가 한다.
 */

import type { proof } from "@proplus/api";
import type { EvidenceSource, ProofStatus } from "@proplus/domain";
import { METHOD_LABEL_KO } from "@proplus/domain";
import Link from "next/link";
import { useMemo, useState } from "react";
import { PROOF_STATUS_LABEL_KO, PROOF_STATUS_NOTE_KO, StatusChip } from "@/components/StatusChip";
import { fmtDay } from "@/lib/client";

/**
 * 화면 순서. 전략 §4.2 의 전이도 순서가 아니라 **지금 할 일** 순서다:
 * 내가 움직여야 하는 것 → 남이 움직이는 중인 것 → 끝난 것.
 */
const GROUP_ORDER: readonly ProofStatus[] = [
  "needs_more_info",
  "submitted",
  "under_review",
  "disputed",
  "verified",
  "rejected",
  "expired",
  "revoked",
];

const SOURCE_LABEL_KO: Record<EvidenceSource, string> = {
  user: "본인 제출",
  platform: "플랫폼 기록",
  organization: "조직 제출",
  third_party: "제3자 제공",
};

export function EvidenceList({ items }: { items: readonly proof.MyEvidenceDto[] }) {
  const [filter, setFilter] = useState<ProofStatus | "all">("all");

  const groups = useMemo(() => {
    return GROUP_ORDER.map((status) => ({
      status,
      items: items.filter((it) => it.status === status),
    })).filter((g) => g.items.length > 0);
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="panel mt-8 p-6">
        <p className="text-[15px] font-semibold">아직 제출한 증거가 없습니다.</p>
        <p className="mt-2 max-w-[56ch] text-[14px] leading-relaxed text-[var(--fg-mute)]">
          확인받을 항목을 하나씩 올리면 됩니다. 유형마다 요구하는 확인 방식이 다르고, 자기기재 항목은 배지가 되지 않습니다.
        </p>
        <Link href="/app/evidence/new" className="btn btn-primary mt-5">
          첫 증거 제출
        </Link>
      </div>
    );
  }

  const visible = filter === "all" ? groups : groups.filter((g) => g.status === filter);

  return (
    <div className="mt-8">
      {/* 필터는 버튼 묶음이다 — 키보드 Tab/Enter 로 전부 조작되고, 선택 상태는 색이 아니라 aria-pressed 와 테두리로 말한다. */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="상태로 걸러 보기">
        <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
          전체 {items.length}건
        </FilterButton>
        {groups.map((g) => (
          <FilterButton key={g.status} active={filter === g.status} onClick={() => setFilter(g.status)}>
            {PROOF_STATUS_LABEL_KO[g.status]} {g.items.length}건
          </FilterButton>
        ))}
      </div>

      <div className="mt-7 flex flex-col gap-9">
        {visible.map((group) => (
          <section key={group.status} aria-labelledby={`group-${group.status}`}>
            <div className="flex flex-wrap items-center gap-3">
              <h2 id={`group-${group.status}`} className="text-[18px] font-semibold">
                {PROOF_STATUS_LABEL_KO[group.status]}
              </h2>
              <StatusChip status={group.status} />
              <span className="text-[13px] text-[var(--fg-mute)]">{group.items.length}건</span>
            </div>
            <p className="mt-2 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
              {PROOF_STATUS_NOTE_KO[group.status]}
            </p>

            <ul className="mt-4 flex flex-col gap-3">
              {group.items.map((item) => (
                <li key={item.id}>
                  <EvidenceRow item={item} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3.5 py-2 text-[13px] font-semibold ${
        active
          ? "border border-solid border-[color:var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]"
          : "border border-solid border-[color:var(--line-strong)] text-[var(--fg-mute)]"
      }`}
    >
      {children}
    </button>
  );
}

function EvidenceRow({ item }: { item: proof.MyEvidenceDto }) {
  const latest = item.latest;
  return (
    <Link
      href={`/app/evidence/${item.id}`}
      className="card flex flex-col gap-3 p-5 hover:border-[color:var(--accent)]"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[16.5px] font-semibold">{item.typeLabelKo}</span>
        <StatusChip status={item.status} />
        {item.subjectType === "organization" ? (
          <span className="text-[12.5px] text-[var(--fg-mute)]">조직 증거</span>
        ) : null}
      </div>

      <p className="text-[13px] text-[var(--fg-mute)]">
        {SOURCE_LABEL_KO[item.sourceType]}
        {item.issuerName ? ` · ${item.issuerName}` : ""}
        {` · ${fmtDay(item.submittedAt)} 제출`}
        {` · 첨부 ${item.fileCount}개`}
      </p>

      {/* 검증 결과는 "방식 · 범위 · 확인일 · 사유코드"를 한 줄에 같이 둔다 — 하나만 떼면 무엇을 확인한 건지 알 수 없다. */}
      {latest ? (
        <p className="text-[13px] text-[var(--fg-mute)]">
          최근 검토: {METHOD_LABEL_KO[latest.method]}
          {latest.scope ? ` · 범위 ${latest.scope}` : ""}
          {latest.verifiedAt ? ` · ${fmtDay(latest.verifiedAt)} 확인` : ""}
          {latest.expiresAt ? ` · ${fmtDay(latest.expiresAt)}까지` : ""}
          {latest.reasonCode ? ` · 사유 ${latest.reasonCode}` : ""}
        </p>
      ) : (
        <p className="text-[13px] text-[var(--fg-mute)]">아직 검토 기록이 없습니다.</p>
      )}
    </Link>
  );
}
