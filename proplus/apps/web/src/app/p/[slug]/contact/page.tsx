/**
 * P-100 공개 상담 요청 화면 (SSR, 인증 없음) · P-101 동의 분리 · P-036 상담 CTA 의 도착지.
 *
 * 이 페이지는 **폼의 틀과 맥락만** 서버에서 그린다. 제출은 client component(`LeadForm`)가
 * `/api/v1/public/profiles/{slug}/leads` 로 보낸다 — 공개 폼이라 로그인 벽이 없고(`auth: false`),
 * 그래도 쓰기이므로 origin 검사·rate limit·동의 검증은 서버에서 그대로 걸린다.
 *
 * 프로필을 한 번 읽는 이유는 두 가지다: (1) 미발행·없는 slug 로 들어온 상담 화면은 404 여야 한다
 * (보내도 서버가 404 를 줄 폼을 그려 놓으면 사용자는 쓴 글을 잃는다), (2) 누구에게 보내는지와
 * 어떤 상품 문의인지를 화면에 적어야 한다.
 *
 * 세션은 읽지 않는다 — 비회원이 쓰는 화면이고 개인화 분기가 없다(`/p/[slug]/page.tsx` 상단 주석).
 */

import { ApiError, profile as profileApi } from "@proplus/api";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LeadForm } from "./LeadForm";

export const dynamic = "force-dynamic";

/**
 * P-169: 동의 기록에 남길 약관 버전. **서버가 정해 폼에 내려보낸다** — 클라이언트가 고정값을 들고 있으면
 * 약관이 바뀌어도 옛 버전이 기록되고, 나중에 "무엇에 동의했는가"를 재현할 수 없다.
 *
 * `profile.currentPolicyVersion("privacy")` 가 `effective_at <= now()` 중 최신을 돌려준다.
 * 폴백 상수를 두는 이유: 정책 행이 없으면(마이그레이션 직후 등) 동의를 **받지 못하는** 것이 아니라
 * 기록이 없는 동의가 남는 쪽이 더 위험하다. 그래서 마이그레이션이 넣어 둔 초기 버전으로 떨어진다
 * (0001_proplus_core.sql 의 `INSERT INTO policy_versions`).
 */
const PRIVACY_POLICY_FALLBACK = "privacy-2026-10-22";

async function privacyPolicyVersion(): Promise<string> {
  try {
    return (await profileApi.currentPolicyVersion("privacy")) ?? PRIVACY_POLICY_FALLBACK;
  } catch {
    return PRIVACY_POLICY_FALLBACK;
  }
}

const PRIVACY_HREF = "/legal/privacy";

type PublicProfile = profileApi.PublicProfileDto;

async function loadProfile(slug: string): Promise<PublicProfile | null> {
  try {
    return await profileApi.getPublicProfile(slug, new Date());
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** 쿼리스트링은 배열로도 올 수 있다. 첫 값만 보고, 모양이 아니면 버린다. */
function firstParam(v: string | string[] | undefined): string | null {
  const raw = Array.isArray(v) ? v[0] : v;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const p = await loadProfile(slug);
  if (!p) return { title: "프로필을 찾을 수 없습니다", robots: { index: false, follow: false } };

  return {
    title: `${p.displayName} 상담 요청`,
    description: `${p.displayName} 에게 상담을 요청합니다. 상담 처리 동의와 마케팅 수신 동의를 따로 받습니다.`,
    // 개인정보를 입력하는 화면은 색인 대상이 아니다. 공개 프로필(`/p/{slug}`)이 색인 대상이다.
    robots: { index: false, follow: true },
  };
}

export default async function ContactPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const data = await loadProfile(slug);
  if (!data) notFound();

  /**
   * 상품 문의 맥락. **공개 DTO 에 있는 상품과 맞을 때만** 통과시킨다 —
   * 쿼리스트링에서 받은 id 를 그대로 폼에 심으면 (a) 모양이 틀린 값으로 서버가 400 을 주고,
   * (b) 이 프로필의 상품이 아닌 제목을 화면에 적을 길이 생긴다. 소유 관계는 서버가 다시 보지만
   * (`lead.createLead`), 화면이 먼저 사실만 말하는 편이 정확하다.
   */
  const requestedOfferId = firstParam(query.offer);
  const offer = requestedOfferId ? (data.offers.find((o) => o.id === requestedOfferId) ?? null) : null;

  // P-169: 지금 유효한 개인정보 정책 버전. 동의 레코드가 이 값을 참조한다.
  const policyVersion = await privacyPolicyVersion();

  return (
    <div>
      <header className="mx-auto flex max-w-2xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
        <Link href="/" className="display text-[19px] tracking-tight">
          PROPLUS
        </Link>
        <Link href={`/p/${data.slug}`} className="btn btn-ghost !min-h-10 text-[13.5px]">
          프로필로 돌아가기
        </Link>
      </header>

      <main id="main" className="mx-auto max-w-2xl px-5 pb-16 pt-2 sm:px-8 sm:pb-24">
        <p className="eyebrow">상담 요청</p>
        <h1 className="display mt-3 text-[30px] sm:text-[40px]">{data.displayName} 님에게 문의하기</h1>
        {data.headline ? (
          <p className="mt-3 text-[15.5px] leading-relaxed text-[var(--fg-mute)]">{data.headline}</p>
        ) : null}

        <p className="mt-5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
          연락처를 남기면 이 프로필의 담당자에게 전달됩니다. 답변 시점은 담당자에 따라 다르며, 이 화면은 응답 속도를 약속하지 않습니다.
        </p>

        <div className="mt-8">
          <LeadForm
            slug={data.slug}
            policyVersion={policyVersion}
            offerId={offer?.id ?? null}
            offerTitle={offer?.title ?? null}
            privacyHref={PRIVACY_HREF}
          />
        </div>
      </main>
    </div>
  );
}
