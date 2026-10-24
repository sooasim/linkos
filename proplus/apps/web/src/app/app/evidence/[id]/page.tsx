/**
 * P-051 증거 상세 · P-053 당사자 전이 · P-063 이의제기 · P-164 당사자 응답 경계.
 *
 * 여기 **없는 것**이 설계다: 검증자 신원(`reviewer_id`)과 검증자 내부 메모는 당사자 응답에 들어오지
 * 않는다(P-164). 그래서 화면에도 그 자리를 만들지 않는다 — 비어 있는 칸을 그려 두면 "곧 보일 것"처럼
 * 읽히고, 나중에 누군가 그 칸을 채우려고 모듈을 고친다.
 *
 * 404 는 Next 의 not-found 로 넘긴다. 모듈의 404 메시지는 영문 리소스명(`evidence not found`)이고
 * 그것을 사용자 문구로 쓰면 안 되기 때문이다. 남의 증거의 **존재 여부**도 알려 주지 않는다는 성질은
 * 그대로 유지된다(모듈이 소유자 스코프로 404 를 냈다).
 */

import { ApiError, proof } from "@proplus/api";
import { DISPUTED_LABEL_KO, METHOD_LABEL_KO } from "@proplus/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBadgeDay } from "@/components/Badge";
import { PROOF_STATUS_NOTE_KO, StatusChip } from "@/components/StatusChip";
import { getViewer } from "@/lib/server";
import { AppealForm, OwnerActions } from "./AppealForm";

export const metadata: Metadata = { title: "증거 상세" };

const SOURCE_LABEL_KO: Record<string, string> = {
  user: "본인 제출",
  platform: "플랫폼 기록",
  organization: "조직 제출",
  third_party: "제3자 제공",
};

export default async function EvidenceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await getViewer();

  let item: proof.MyEvidenceDto | null = null;
  let failure: { code: string; message: string } | null = null;
  try {
    item = await proof.getMyEvidence(ctx, id);
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
          <p className="text-[15px] font-semibold">{failure?.message ?? "증거를 불러오지 못했습니다."}</p>
          <p className="mt-2 text-[13px] text-[var(--fg-mute)]">오류 코드: {failure?.code ?? "error"}</p>
          <Link href="/app/evidence" className="btn btn-ghost mt-5">
            내 증거로 돌아가기
          </Link>
        </div>
      </div>
    );
  }

  const latest = item.latest;
  // `getMyEvidence` 는 판정 이력을 오름차순으로 채운다. 목록 조회(listMyEvidence)에서는 빈 배열이다.
  const history = item.history;

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
      <nav aria-label="이동 경로" className="text-[13px] text-[var(--fg-mute)]">
        <Link href="/app/evidence" className="hover:text-[var(--fg)]">
          내 증거
        </Link>
        <span aria-hidden="true"> · </span>
        <span>{item.typeLabelKo}</span>
      </nav>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="display text-[30px] sm:text-[38px]">{item.typeLabelKo}</h1>
        <StatusChip status={item.status} />
      </div>
      <p className="lede mt-3 text-[15px]">{PROOF_STATUS_NOTE_KO[item.status]}</p>

      {/* ── 제출 내용 ────────────────────────────────────────── */}
      <section className="card mt-8 p-6" aria-labelledby="submission">
        <h2 id="submission" className="text-[17px] font-semibold">
          제출 내용
        </h2>
        <dl className="disclosure-dl mt-3">
          <dt>유형 코드</dt>
          <dd>{item.evidenceType}</dd>

          <dt>대상</dt>
          <dd>{item.subjectType === "organization" ? "조직" : "내 프로필"}</dd>

          <dt>자료 출처</dt>
          <dd>{SOURCE_LABEL_KO[item.sourceType] ?? item.sourceType}</dd>

          <dt>발급기관</dt>
          <dd>{item.issuerName ?? "해당 없음"}</dd>

          <dt>제출일</dt>
          <dd>{formatBadgeDay(item.submittedAt)}</dd>

          <dt>첨부 파일</dt>
          <dd>{item.fileCount}개</dd>
        </dl>
        {/* N-5: 파일 **개수**만 응답에 있다. 파일별 식별자가 없으므로 개별 다운로드 링크를 지어내지 않는다. */}
        <p className="disclosure-note">
          올린 원본은 이 화면에서도 내려받을 수 없습니다. 원본 열람은 검토 목적의 접근 사유와 함께 감사로그에 남는 별도
          경로에서만 가능합니다.
        </p>
      </section>

      {/* ── 검증 기록 ────────────────────────────────────────── */}
      <section className="card mt-6 p-6" aria-labelledby="verification">
        <h2 id="verification" className="text-[17px] font-semibold">
          검증 기록
        </h2>

        {/*
          판정 이력 전체를 시간순으로 보여준다 (`MyEvidenceDto.history`).
          최신 1건만 보여주면 "왜 반려됐고 재제출 후 무엇이 달라졌는지" 를 당사자가 알 수 없다 —
          반려 → 추가정보 → 재제출 → 확인 흐름이 이 목록의 요점이다.
          최신 항목을 가장 아래가 아니라 **위**에 두면 이력이 거꾸로 읽히므로 오름차순을 유지한다.
        */}
        {history.length > 0 ? (
          <ol className="mt-4 flex flex-col gap-4">
            {history.map((v, i) => (
              <li key={v.id} className="panel p-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <StatusChip status={v.status} />
                  <span className="text-[13px] text-[var(--fg-mute)]">
                    {v.createdAt ? `${formatBadgeDay(v.createdAt)} 처리` : "처리일 기록 없음"}
                  </span>
                  {i === history.length - 1 ? (
                    <span className="chip !text-[12px]">현재 상태</span>
                  ) : null}
                </div>
                <dl className="disclosure-dl mt-3">
                  <dt>확인 방식</dt>
                  <dd>{METHOD_LABEL_KO[v.method]}</dd>

                  <dt>확인 범위</dt>
                  <dd>{v.scope ?? "아직 확정되지 않았습니다"}</dd>

                  <dt>유효기간</dt>
                  <dd>{v.expiresAt ? `${formatBadgeDay(v.expiresAt)}까지` : "별도 만료일 없음 (변경 시 즉시 회수)"}</dd>

                  <dt>사유 코드</dt>
                  <dd>{v.reasonCode ?? "해당 없음"}</dd>
                </dl>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-3 text-[14px] text-[var(--fg-mute)]">아직 검증 기록이 없습니다. 검토 대기 중입니다.</p>
        )}

        {/* P-164: 당사자 응답에는 검증자 신원과 내부 메모가 없다. 왜 없는지도 같이 적는다. */}
        <p className="disclosure-note">
          검증자 개인 정보와 검토 과정의 내부 메모는 당사자 화면에 제공되지 않습니다.
        </p>
      </section>

      {/* ── 당사자 조치 ──────────────────────────────────────── */}
      <OwnerActions evidenceId={item.id} status={item.status} />

      {/* ── 이의제기 (P-063) ─────────────────────────────────── */}
      <AppealForm
        /**
         * `POST /me/verifications/{id}/appeal` 의 대상은 **최신 판정의 검증 id** 다.
         * `MyEvidenceDto.latest.id` 가 그 값이고, 모듈이 소유자 스코프를 이미 통과시킨 뒤
         * 돌려준 것이므로 남의 검증을 가리킬 수 없다.
         */
        verificationId={latest?.id ?? null}
        hasVerification={latest !== null}
        disputed={item.status === "disputed"}
        publicDisputedLabel={DISPUTED_LABEL_KO}
      />
    </div>
  );
}
