/**
 * 워크스페이스 홈 — P-180 (요약 화면).
 *
 * ## 자기 API 를 fetch 하지 않는다
 *
 * 같은 프로세스이므로 `@proplus/api` 모듈을 직접 호출한다. HTTP 를 한 번 더 타면 쿠키 전달·
 * 절대 URL·타임아웃을 전부 다시 다뤄야 하고, 얻는 것이 없다 (전략 §3).
 *
 * ## 완성도를 "신뢰도"로 그리지 않는다 (P-032 / N-3)
 *
 * `profile.completenessFor()` 는 퍼센트와 빠진 항목을 같이 돌려주지만, 이 화면은 **빠진 항목만**
 * 쓴다. 큰 숫자 하나를 띄우면 그것이 곧 점수가 되고, 점수가 되면 "올리는 법"이 제품이 된다
 * (completeness.ts 주석). 그래서 "n개 작성됨" 같은 개수로만 적고 정렬·비교에 쓰지 않는다.
 *
 * ## 숫자에는 기간과 집계 기준을 붙인다 (N-8 과 같은 정신)
 *
 * 조회수는 `analytics.summary()` 가 돌려준 `period`·`basis` 와 함께 그린다. 요금제 때문에 기간이
 * 잘렸으면(`clampedByPlan`) 그 사실도 적는다 — "데이터가 없다"와 "요금제가 가린다"는 다른 사실이다.
 */

import { analytics, lead, profile, proof } from "@proplus/api";
import { COMPLETENESS_ITEMS, COMPLETENESS_LABEL_KO, type ProofStatus } from "@proplus/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { formatBadgeDay } from "@/components/Badge";
import { PROOF_STATUS_LABEL_KO, StatusChip } from "@/components/StatusChip";
import { getViewer } from "@/lib/server";

export const metadata: Metadata = { title: "워크스페이스", robots: { index: false, follow: false } };

/** 최근 조회 집계 창. 화면에 "최근 7일"이라고 적는 값과 같은 상수여야 한다. */
const RECENT_DAYS = 7;

/** 진행 상황 카드에 항상 보여 주는 세 단계. 0건도 0으로 보여 준다 — 빈 칸은 "없음"을 말하지 못한다. */
const PIPELINE: readonly ProofStatus[] = ["submitted", "under_review", "verified"];
/** 사용자가 **할 일이 있을 때만** 나타나는 상태들. */
const ATTENTION: readonly ProofStatus[] = ["needs_more_info", "disputed", "rejected", "expired", "revoked"];

/** 작성 안내 항목이 실제로 고칠 수 있는 화면. 안내만 하고 갈 곳이 없으면 안내가 아니다. */
const GUIDANCE_HREF: Readonly<Record<string, string>> = {
  headline: "/app/profile",
  bio: "/app/profile",
  specialties: "/app/profile",
  badges: "/app/evidence",
  offers: "/app/offers",
  cta: "/app/profile",
};

function guidanceLabel(code: string): string {
  // Record<CompletenessItem,…> 를 임의 문자열로 색인할 수 없으므로 한 번 넓혀 읽는다.
  const table: Readonly<Record<string, string>> = COMPLETENESS_LABEL_KO;
  return table[code] ?? code;
}

export default async function WorkspaceHome() {
  const { userId, ctx } = await getViewer();
  // 레이아웃이 비로그인을 이미 리다이렉트하지만, 레이아웃과 페이지는 **병렬로** 렌더된다.
  // 모듈에 null userId 를 넘겨 401 을 만들지 않도록 여기서도 끊는다.
  if (!userId) return null;

  const mine = await profile.getMyProfile(ctx);

  const [evidence, newLeads] = await Promise.all([
    proof.listMyEvidence(ctx),
    // 신규 상담만 센다. 전용 count API 가 없어 목록 길이를 쓰고, 상한에 닿으면 "200+" 로 적는다.
    lead.listLeads(ctx, { stage: "new", limit: 200 }),
  ]);

  const to = new Date();
  const from = new Date(to.getTime() - RECENT_DAYS * 86_400_000);
  // 두 함수 모두 프로필이 없으면 404 를 던진다(모듈). 프로필을 만들기 전에는 호출하지 않는다.
  const [guidance, recent] = mine
    ? await Promise.all([
        profile.completenessFor(ctx),
        analytics.summary(ctx, from.toISOString(), to.toISOString()),
      ])
    : [null, null];

  const counts = new Map<string, number>();
  for (const item of evidence) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const attention = ATTENTION.filter((s) => (counts.get(s) ?? 0) > 0);

  const filled = guidance ? COMPLETENESS_ITEMS.length - guidance.missing.length : 0;

  return (
    <div>
      <p className="eyebrow">워크스페이스</p>
      <h1 className="display mt-4 text-[32px] sm:text-[42px]">
        {mine ? mine.displayName : "프로필부터 만들어 주세요"}
      </h1>
      <p className="lede mt-4">
        {mine
          ? mine.publishedAt
            ? "프로필이 공개되어 있습니다. 확인받을 항목을 올리고 상담 요청을 처리하세요."
            : "프로필이 아직 공개되지 않았습니다. 내용을 확인한 뒤 발행하세요."
          : "공개 주소와 이름을 정하면 바로 시작할 수 있습니다. 확인받을 항목은 그 뒤에 하나씩 올립니다."}
      </p>

      {!mine ? (
        <div className="card mt-8 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[15px] text-[var(--fg-mute)]">
            아직 프로필이 없습니다. 주소(<code className="text-[13px]">/p/내아이디</code>)와 이름만 있으면 만들 수 있습니다.
          </p>
          <Link href="/app/profile" className="btn btn-primary">
            프로필 만들기
          </Link>
        </div>
      ) : null}

      <div className="mt-10 grid gap-5 lg:grid-cols-2">
        {/* ── 프로필 공개 상태 (P-027) ───────────────────────── */}
        <section aria-labelledby="h-profile" className="card flex flex-col gap-3 p-6">
          <h2 id="h-profile" className="text-[17px] font-semibold">
            프로필 공개 상태
          </h2>
          {mine ? (
            <>
              {/* 상태는 색이 아니라 말로 적는다 (브랜드 §7). */}
              <p className="text-[15px]">
                <span className="font-semibold">{mine.publishedAt ? "공개 중" : "비공개"}</span>
                {mine.publishedAt ? ` · ${formatBadgeDay(mine.publishedAt)} 발행` : " · 공개 주소는 아직 열리지 않습니다"}
              </p>
              <p className="text-[13.5px] text-[var(--fg-mute)]">
                공개 주소 <span className="font-medium text-[var(--fg)]">/p/{mine.slug}</span> · 저장 {mine.version}회
              </p>
              <div className="mt-auto flex flex-wrap gap-2 pt-2">
                <Link href="/app/profile" className="btn btn-ghost !min-h-10 text-[14px]">
                  프로필 편집
                </Link>
                {mine.publishedAt ? (
                  <Link href={`/p/${mine.slug}`} className="btn btn-ghost !min-h-10 text-[14px]">
                    공개 페이지 보기
                  </Link>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-[14.5px] text-[var(--fg-mute)]">프로필을 만들면 공개 상태가 여기에 표시됩니다.</p>
          )}
        </section>

        {/* ── 작성 안내 (P-032 / N-3) ────────────────────────── */}
        <section aria-labelledby="h-guidance" className="card flex flex-col gap-3 p-6">
          <h2 id="h-guidance" className="text-[17px] font-semibold">
            작성 안내
          </h2>
          {guidance ? (
            guidance.missing.length === 0 ? (
              <p className="text-[14.5px] text-[var(--fg-mute)]">
                안내 항목 {COMPLETENESS_ITEMS.length}개를 모두 작성했습니다. 이 안내는 점수가 아니며 검색 순서에 쓰이지 않습니다.
              </p>
            ) : (
              <>
                <p className="text-[13.5px] text-[var(--fg-mute)]">
                  {COMPLETENESS_ITEMS.length}개 중 {filled}개 작성됨 · 남은 항목을 채우면 방문자가 무엇을 맡길 수 있는지 더 빨리 알 수 있습니다.
                </p>
                <ul className="flex flex-col gap-1.5">
                  {guidance.missing.map((code) => (
                    <li key={code} className="flex items-start gap-3 text-[14.5px]">
                      <span aria-hidden="true" className="mt-[9px] size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                      <Link
                        href={GUIDANCE_HREF[code] ?? "/app/profile"}
                        className="text-[var(--accent-text)] underline underline-offset-2"
                      >
                        {guidanceLabel(code)}
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="mt-auto pt-2 text-[12px] text-[var(--fg-mute)]">
                  이 목록은 작성 안내입니다. 신뢰도 점수가 아니고, 검색 노출 순서에 쓰이지 않습니다.
                </p>
              </>
            )
          ) : (
            <p className="text-[14.5px] text-[var(--fg-mute)]">프로필을 만들면 남은 작성 항목을 알려 드립니다.</p>
          )}
        </section>

        {/* ── 검증 진행 상황 (P-050~P-061) ───────────────────── */}
        <section aria-labelledby="h-proof" className="card flex flex-col gap-4 p-6">
          <h2 id="h-proof" className="text-[17px] font-semibold">
            검증 진행 상황
          </h2>
          {/* 상태는 StatusChip 이 색 + 텍스트 + 아이콘 + 선 모양으로 함께 말한다 (브랜드 §7).
              라벨 표도 그 컴포넌트가 가진 것을 쓴다 — 같은 상태를 화면마다 다르게 부르지 않기 위해서다. */}
          <dl className="grid gap-3 sm:grid-cols-3">
            {PIPELINE.map((status) => (
              <div key={status} className="panel flex items-center justify-between gap-2 p-4">
                <dt>
                  <StatusChip status={status} />
                </dt>
                <dd className="text-[24px] font-semibold tabular-nums">{counts.get(status) ?? 0}</dd>
              </div>
            ))}
          </dl>

          {attention.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {attention.map((status) => (
                <li key={status} className="text-[13.5px] text-[var(--fg-mute)]">
                  <span className="font-semibold text-[var(--fg)]">{PROOF_STATUS_LABEL_KO[status]}</span>{" "}
                  {counts.get(status) ?? 0}건
                </li>
              ))}
            </ul>
          ) : null}

          <p className="text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
            제출한 증거 {evidence.length}건 기준입니다. 직접 적은 항목은 확인 절차를 거치지 않으므로 배지가 되지 않습니다.
          </p>
          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <Link href="/app/evidence" className="btn btn-ghost !min-h-10 text-[14px]">
              검증 항목 관리
            </Link>
          </div>
        </section>

        {/* ── 새 상담 · 최근 조회 ─────────────────────────────── */}
        <section aria-labelledby="h-activity" className="card flex flex-col gap-4 p-6">
          <h2 id="h-activity" className="text-[17px] font-semibold">
            최근 활동
          </h2>

          <dl className="grid grid-cols-2 gap-3">
            <div className="panel p-4">
              <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">새 상담 요청</dt>
              <dd className="mt-1 text-[24px] font-semibold tabular-nums">
                {newLeads.length >= 200 ? "200+" : newLeads.length}
              </dd>
            </div>
            <div className="panel p-4">
              <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">최근 {RECENT_DAYS}일 조회</dt>
              <dd className="mt-1 text-[24px] font-semibold tabular-nums">
                {recent ? recent.metrics.views : "—"}
              </dd>
            </div>
          </dl>

          {recent ? (
            <>
              <p className="text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
                {formatBadgeDay(recent.period.from)}–{formatBadgeDay(recent.period.to)} · 고유 방문자{" "}
                {recent.metrics.uniqueVisitors}명 · 집계 기준: {recent.basis}
              </p>
              {recent.period.clampedByPlan ? (
                <p className="text-[12.5px] text-[var(--pending)]">
                  요금제({recent.period.planCode})의 보관 기간 {recent.period.retentionDays}일 때문에 조회 기간이 잘렸습니다.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-[12.5px] text-[var(--fg-mute)]">프로필을 발행하면 조회 집계가 쌓입니다.</p>
          )}

          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <Link href="/app/leads" className="btn btn-ghost !min-h-10 text-[14px]">
              상담 처리
            </Link>
            <Link href="/app/analytics" className="btn btn-ghost !min-h-10 text-[14px]">
              분석 보기
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
