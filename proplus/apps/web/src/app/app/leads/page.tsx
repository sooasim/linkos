/**
 * P-103 상담 inbox (모듈명세 M07).
 *
 * 목록에는 **마스킹된 연락처만** 나온다(P-102): 모듈이 복호화하지 않고 `contact_masked` 컬럼을 그대로
 * 읽기 때문이다. 담당자가 100건을 훑는 동작이 100번의 복호화와 감사로그를 만들 이유가 없다.
 * 원문이 필요하면 상세 화면을 열고, 그 조회는 기록으로 남는다.
 *
 * 단계 필터를 **서버 쿼리**로 돌리는 이유: 목록은 최대 200건으로 잘리므로(모듈 `clamp`),
 * 받아 온 뒤 브라우저에서 거르면 "검토 중 리드가 0건"처럼 **사실과 다른 화면**이 나온다.
 * 링크로 거르면 JS 없이도 동작한다.
 */

import { ApiError, lead } from "@proplus/api";
import { LEAD_STAGES, LEAD_STAGE_LABEL_KO, type LeadStage } from "@proplus/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { getViewer } from "@/lib/server";
import { LeadTable } from "./LeadTable";

export const metadata: Metadata = { title: "상담 요청" };

/** 값의 **모양**만 본다. 권한·범위는 모듈의 `scopeSql()` 이 긋는다 (전략 §3). */
function parseStage(raw: string | string[] | undefined): LeadStage | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && (LEAD_STAGES as readonly string[]).includes(v) ? (v as LeadStage) : null;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const stage = parseStage(sp.stage);
  const { ctx } = await getViewer();

  let leads: lead.LeadListItem[] = [];
  let failure: { code: string; message: string } | null = null;
  try {
    leads = await lead.listLeads(ctx, { stage, limit: 100 });
  } catch (e) {
    failure =
      e instanceof ApiError
        ? { code: e.code, message: e.message }
        : { code: "internal_error", message: "일시적인 오류가 발생했습니다." };
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
      <header>
        <p className="eyebrow">PROPLUS MARKET</p>
        <h1 className="display mt-3 text-[32px] sm:text-[42px]">상담 요청</h1>
        <p className="lede mt-3 text-[15px]">
          접수된 상담을 단계별로 관리합니다. 목록에는 연락처가 가려진 상태로 표시되고, 원문은 상세 화면에서만 볼 수 있습니다.
        </p>
      </header>

      {/* 필터는 링크다 — 주소를 공유할 수 있고, JS 없이도 동작한다. */}
      <nav className="mt-7 flex flex-wrap gap-2" aria-label="단계로 걸러 보기">
        <Link
          href="/app/leads"
          aria-current={stage === null ? "page" : undefined}
          className={`rounded-full px-3.5 py-2 text-[13px] font-semibold ${
            stage === null
              ? "border border-solid border-[color:var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]"
              : "border border-solid border-[color:var(--line-strong)] text-[var(--fg-mute)]"
          }`}
        >
          전체
        </Link>
        {LEAD_STAGES.map((s) => (
          <Link
            key={s}
            href={`/app/leads?stage=${s}`}
            aria-current={stage === s ? "page" : undefined}
            className={`rounded-full px-3.5 py-2 text-[13px] font-semibold ${
              stage === s
                ? "border border-solid border-[color:var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]"
                : "border border-solid border-[color:var(--line-strong)] text-[var(--fg-mute)]"
            }`}
          >
            {LEAD_STAGE_LABEL_KO[s]}
          </Link>
        ))}
      </nav>

      {failure ? (
        <div className="panel mt-8 p-6" role="alert">
          <p className="text-[15px] font-semibold">{failure.message}</p>
          <p className="mt-2 text-[13px] text-[var(--fg-mute)]">오류 코드: {failure.code}</p>
          {failure.code === "unauthorized" ? (
            <Link href="/login?next=/app/leads" className="btn btn-ghost mt-5">
              로그인
            </Link>
          ) : null}
        </div>
      ) : (
        <LeadTable leads={leads} stage={stage} />
      )}
    </div>
  );
}
