/**
 * P-103 상담 상세 · P-102 연락처 복호화 경계 · P-106 비공개 메모 · P-165 접근 기록.
 *
 * **이 화면을 여는 것 자체가 기록을 만든다.** `lead.getLead()` 가 연락처를 복호화하면서
 * `lead.contact_viewed` 를 감사로그에 남긴다(모듈 주석 / 보안정책 §3). 그래서 화면에 그 사실을 적는다 —
 * 기록을 남기면서 당사자(담당자)에게 알리지 않는 것은 투명성 원칙에 맞지 않고,
 * 알고 있으면 "필요할 때만 연다"는 운영 습관이 생긴다.
 *
 * 같은 이유로 목록의 링크는 prefetch 를 끈다(`LeadTable`): 마우스가 지나간 것이 "열었다"가 되면 안 된다.
 */

import { ApiError, lead } from "@proplus/api";
import { LEAD_STAGE_LABEL_KO } from "@proplus/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LeadStageChip } from "@/components/StatusChip";
import { getViewer } from "@/lib/server";
import { LeadDetail } from "./LeadDetail";

export const metadata: Metadata = { title: "상담 상세" };

const CONTACT_KIND_KO: Record<string, string> = { email: "이메일", phone: "전화" };

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await getViewer();

  let item: lead.LeadDetail | null = null;
  let notes: lead.LeadNoteView[] = [];
  let failure: { code: string; message: string } | null = null;
  try {
    item = await lead.getLead(ctx, id);
    notes = await lead.listNotes(ctx, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    failure =
      e instanceof ApiError
        ? { code: e.code, message: e.message }
        : { code: "internal_error", message: "일시적인 오류가 발생했습니다." };
  }

  if (!item) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
        <div className="panel p-6" role="alert">
          <p className="text-[15px] font-semibold">{failure?.message ?? "상담을 불러오지 못했습니다."}</p>
          <p className="mt-2 text-[13px] text-[var(--fg-mute)]">오류 코드: {failure?.code ?? "error"}</p>
          <Link href="/app/leads" className="btn btn-ghost mt-5">
            상담 목록으로
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
      <nav aria-label="이동 경로" className="text-[13px] text-[var(--fg-mute)]">
        <Link href="/app/leads" className="hover:text-[var(--fg)]">
          상담 요청
        </Link>
        <span aria-hidden="true"> · </span>
        <span>{item.contactName}</span>
      </nav>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="display text-[30px] sm:text-[38px]">{item.contactName}</h1>
        <LeadStageChip stage={item.stage} />
      </div>

      {/* 투명성: 지금 이 조회가 남긴 기록을 숨기지 않는다 (P-165). */}
      <p className="mt-4 max-w-[62ch] text-[13px] leading-relaxed text-[var(--fg-mute)]" role="note">
        이 화면을 열면서 연락처를 복호화했고, “누가·언제·어떤 상담의 연락처를 열었는지”가 감사로그에 남았습니다. 연락처
        자체는 기록되지 않습니다.
      </p>

      <section className="card mt-7 p-6" aria-labelledby="contact">
        <h2 id="contact" className="text-[17px] font-semibold">
          연락처
        </h2>
        <dl className="disclosure-dl mt-3">
          <dt>종류</dt>
          <dd>{CONTACT_KIND_KO[item.contactKind] ?? item.contactKind}</dd>

          <dt>원문</dt>
          <dd>
            {item.contactPurged ? (
              <span className="text-[var(--fg-mute)]">보관기간이 지나 삭제되었습니다</span>
            ) : (
              (item.contact ?? item.contactMasked)
            )}
          </dd>

          <dt>가린 표시</dt>
          <dd>{item.contactMasked}</dd>

          <dt>보관기한</dt>
          <dd>{item.retentionUntil.slice(0, 10).replaceAll("-", ".")}</dd>
        </dl>
        <p className="disclosure-note">
          보관기한이 지나면 연락처는 자동으로 삭제되고, 통계에 필요한 단계·시각 정보만 남습니다.
        </p>
      </section>

      <section className="card mt-6 p-6" aria-labelledby="request">
        <h2 id="request" className="text-[17px] font-semibold">
          요청 내용
        </h2>
        <dl className="disclosure-dl mt-3">
          <dt>문의 목적</dt>
          <dd>{item.purpose ?? "적지 않았습니다"}</dd>

          <dt>현재 단계</dt>
          <dd>{LEAD_STAGE_LABEL_KO[item.stage]}</dd>

          <dt>담당</dt>
          <dd>{item.assignedTo ? "배정됨" : "미배정"}</dd>

          <dt>들어온 곳</dt>
          <dd>
            <Link href={`/p/${item.profileSlug}`} className="text-[var(--accent-text)] underline">
              /p/{item.profileSlug}
            </Link>
            {item.offerId ? " · 상품 카드에서 시작" : ""}
          </dd>
        </dl>

        {item.message ? (
          <div className="panel mt-4 p-4">
            <p className="text-[12.5px] font-semibold text-[var(--fg-mute)]">남긴 메시지</p>
            <p className="mt-2 whitespace-pre-wrap text-[14.5px] leading-relaxed">{item.message}</p>
          </div>
        ) : null}

        {/*
          N-11: 상담처리 동의와 마케팅 동의는 분리 기록된다. 그런데 이 응답에는 동의 상태가 없다 —
          그래서 동의 상태를 그리지 않고, 동의 없이 눌릴 수 있는 발송 기능도 두지 않는다.
        */}
        <p className="disclosure-note">
          상담 접수 시 동의는 목적별로 따로 기록됩니다(상담 처리 · 개인정보 · 마케팅). 이 화면의 응답에는 동의 상태가
          포함되지 않아 표시하지 않으며, 마케팅 발송 기능도 제공하지 않습니다.
        </p>
      </section>

      <LeadDetail leadId={item.id} stage={item.stage} notes={notes} />
    </div>
  );
}
