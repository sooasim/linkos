/**
 * P-161~P-165 증거 상세 — **접근 사유 게이트**.
 *
 * ## 이 서버 컴포넌트는 증거를 조회하지 않는다
 *
 * `admin.evidenceDetail(ctx, id, accessPurpose)` 는 목적 없이는 거부하고, 조회가 성공하면
 * `audit_logs` 에 목적과 함께 한 줄이 남는다(기술백서 §5 "목적·승인·시간 제한·감사로그").
 * 여기서 미리 불러 두면 **운영자가 사유를 입력하기 전에 조회가 일어난다** — 링크를 잘못 눌러도
 * 감사로그에 조회 기록이 생기고, 반대로 사유 없이도 내용을 볼 수 있게 된다. 둘 다 P-165 의 실패다.
 *
 * 그래서 데이터 호출 전체를 `PurposeGate`(클라이언트)로 내렸다. 서버가 그리는 것은 증거 id 와
 * 이 화면의 규칙 설명뿐이고, 사유가 들어오기 전에는 증거 내용이 브라우저에 **도달하지도 않는다.**
 */

import Link from "next/link";
import { PurposeGate } from "./PurposeGate";

export default async function EvidenceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <div className="flex flex-col gap-7">
      <div>
        <p className="eyebrow">P-165 · 접근 사유 기록</p>
        <h1 className="display mt-3 text-[32px] sm:text-[40px]">증거 상세</h1>
        <p className="mt-3 text-[13px] text-[var(--fg-mute)]">
          증거 ID <code className="text-[12.5px]">{id}</code>
        </p>
        <Link href="/admin/queue" className="mt-4 inline-block text-[14px] text-[var(--accent-text)] hover:underline">
          ← 검토 큐로 돌아가기
        </Link>
      </div>

      <PurposeGate evidenceId={id} />
    </div>
  );
}
