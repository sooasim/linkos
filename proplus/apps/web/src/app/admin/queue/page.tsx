/**
 * P-160 검증 검토 큐 — "검증자 역할만 접근. 대기·처리중·완료 구분"(수용기준).
 *
 * 서버에서 첫 화면을 그리는 이유는 속도가 아니라 **공유 가능성**이다: 운영자끼리 "유형 license 만 모아
 * 보고 있는 큐"를 링크로 주고받으려면 쿼리스트링이 그대로 서버 조회에 반영돼야 한다.
 * 그 뒤의 필터 변경·새로 고침은 `QueueList`(클라이언트)가 `/api/v1/admin/queue` 로 처리한다.
 *
 * 이 목록에는 이름·연락처가 없다. 모듈이 담지 않기 때문이고(P-165), 그래서 큐 열람은 접근 사유를
 * 요구하지 않는다 — 누구인지가 필요한 순간은 증거 상세이며 그 화면이 사유를 묻는다.
 */

import { admin } from "@proplus/api";
import { PROOF_STATUSES, type ProofStatus } from "@proplus/domain";
import { getViewer } from "@/lib/server";
import { QueueList } from "./QueueList";

/** 큐의 기본 범위. 모듈의 `PENDING_STATUSES` 와 같은 집합이고, 화면의 세 묶음이 이것이다. */
const PENDING: readonly ProofStatus[] = ["submitted", "under_review", "needs_more_info"];

function isProofStatus(v: string): v is ProofStatus {
  return (PROOF_STATUSES as readonly string[]).includes(v);
}

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string }>;
}) {
  const sp = await searchParams;
  const { ctx } = await getViewer();

  /*
    모르는 상태 값은 버린다. API 라우트는 같은 입력에 400 을 주는데(오타를 "빈 큐"로 감추지 않으려고),
    화면은 오래된 북마크 하나로 흰 화면이 되면 안 된다. 그래서 라우트가 엄격한 쪽을 맡고
    페이지는 알려진 값만 추려 기본 범위로 떨어진다 — 판정이 아니라 입력 정규화다.
  */
  const requested = (sp.status ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isProofStatus);
  const statuses = requested.length > 0 ? requested : PENDING;
  const evidenceType = (sp.type ?? "").trim() || null;

  const queue = await admin.reviewQueue(ctx, {
    status: statuses,
    evidenceType,
  });

  return (
    <div className="flex flex-col gap-7">
      <div>
        <p className="eyebrow">P-160 · 검토 큐</p>
        <h1 className="display mt-3 text-[32px] sm:text-[40px]">검증 검토 큐</h1>
        <p className="lede mt-3 text-[15px]">
          제출 순으로 정렬합니다. 목록에는 대상의 공개 식별자까지만 표시되고, 당사자 정보는 증거 상세에서
          접근 사유를 입력한 뒤에 열립니다.
        </p>
      </div>

      <QueueList initial={queue} initialStatuses={statuses} initialType={evidenceType ?? ""} />
    </div>
  );
}
