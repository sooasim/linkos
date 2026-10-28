/**
 * P-168 이의제기 — "결과와 사유를 당사자에게 전달하고 **번복률을 집계 가능하게** 남긴다"(수용기준).
 *
 * 처리 결과가 `upheld`(원 결정 유지) / `overturned`(번복) 두 값뿐인 것이 집계의 전부다.
 * "처리됨" 같은 중립 라벨을 하나 끼워 넣으면 번복률의 분모가 흐려지고, 검증 품질 지표가
 * 측정 불가능해진다. 그래서 화면에도 그 두 값만 두고, 집계에 쓰인다는 사실을 적어 둔다.
 */

import { admin } from "@proplus/api";
import { getViewer } from "@/lib/server";
import { AppealList } from "./AppealList";

export default async function AppealsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const { ctx } = await getViewer();
  // 모듈 기본값이 'open' 이고 'all' 이면 전체다. 상태 집합을 화면이 따로 정의하지 않는다(DB CHECK 와 두 벌이 된다).
  const status = (sp.status ?? "").trim() || "open";
  const items = await admin.listAppeals(ctx, status);

  return (
    <div className="flex flex-col gap-7">
      <div>
        <p className="eyebrow">P-168 · 이의제기</p>
        <h1 className="display mt-3 text-[32px] sm:text-[40px]">이의제기 처리</h1>
        <p className="lede mt-3 text-[15px]">
          접수 순으로 정렬합니다. 처리 결과(원 결정 유지 / 번복)와 사유는 감사로그에 남고,
          <strong className="font-semibold"> 번복률(번복 ÷ (유지 + 번복))</strong>로 집계됩니다 — 검증 품질을
          측정하는 지표이므로 결과를 뭉개지 않습니다.
        </p>
      </div>

      <AppealList initial={items} status={status} />
    </div>
  );
}
