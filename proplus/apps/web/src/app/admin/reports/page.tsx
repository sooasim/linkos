/**
 * P-167 신고 큐 · P-170 위반 처리 — "조치와 사유를 감사로그에 남긴다"(수용기준).
 *
 * 이 화면은 **결정만** 기록한다. 프로필 비공개는 profile 모듈, 배지 취소는 배지 취소 경로가 맡는다
 * (모듈은 다른 모듈의 테이블을 쓰지 않는다 — 전략 §3). 조치의 책임 주체를 감사로그에서 섞지 않으려는
 * 분리이고, 그래서 운영자는 보통 두 번 움직인다: 조치를 실행하고, 그 다음 신고를 종결한다.
 */

import { admin } from "@proplus/api";
import { getViewer } from "@/lib/server";
import { ReportList } from "./ReportList";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const { ctx } = await getViewer();
  const status = (sp.status ?? "").trim() || "open";
  const items = await admin.reportQueue(ctx, status);

  return (
    <div className="flex flex-col gap-7">
      <div>
        <p className="eyebrow">P-167 / P-170 · 신고</p>
        <h1 className="display mt-3 text-[32px] sm:text-[40px]">신고 처리</h1>
        <p className="lede mt-3 text-[15px]">
          접수 순으로 정렬합니다. 같은 대상에 여러 건이 몰린 경우를 따로 표시합니다 — 한 대상에 신고가
          집중되는 것은 실제 문제일 수도, 표적 신고일 수도 있어서 둘을 구분하려면 먼저 눈에 보여야 합니다.
        </p>
      </div>

      <ReportList initial={items} status={status} />
    </div>
  );
}
