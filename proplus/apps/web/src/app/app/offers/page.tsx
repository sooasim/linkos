/**
 * P-090 상품 카드 · P-091 가격 표시 정책 · P-092 품절·만료 비공개 · P-093 외부 링크형 (모듈명세 M06).
 *
 * 목록은 초안·보관까지 **전부** 보여준다(`catalog.listMyOffers`). 공개 목록은 다른 경로
 * (`/public/profiles/{slug}/offers`)이고 거기서는 품절·만료·초안이 읽기 시점에 빠진다 —
 * 그래서 이 화면의 일은 "무엇이 지금 공개되고 있는지"를 상태 옆에 분명히 적는 것이다.
 */

import { ApiError, catalog } from "@proplus/api";
import type { Metadata } from "next";
import Link from "next/link";
import { getViewer } from "@/lib/server";
import { OfferManager } from "./OfferManager";

export const metadata: Metadata = { title: "상품 관리" };

export default async function OffersPage() {
  const { ctx } = await getViewer();

  let offers: catalog.Offer[] = [];
  let failure: { code: string; message: string } | null = null;
  try {
    offers = await catalog.listMyOffers(ctx);
  } catch (e) {
    failure =
      e instanceof ApiError
        ? { code: e.code, message: e.message }
        : { code: "internal_error", message: "일시적인 오류가 발생했습니다." };
  }

  return (
    <div className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
      <header>
        <p className="eyebrow">PROPLUS MARKET</p>
        <h1 className="display mt-3 text-[32px] sm:text-[42px]">상품 관리</h1>
        <p className="lede mt-3 text-[15px]">
          제공하는 상품·서비스를 카드로 정리합니다. 가격은 표시·문의·비공개 중에서 고를 수 있고, 결제는 플랫폼이 받지 않고
          외부 링크로 연결합니다.
        </p>
      </header>

      {failure ? (
        <div className="panel mt-8 p-6" role="alert">
          <p className="text-[15px] font-semibold">{failure.message}</p>
          <p className="mt-2 text-[13px] text-[var(--fg-mute)]">오류 코드: {failure.code}</p>
          {failure.code === "unauthorized" ? (
            <Link href="/login?next=/app/offers" className="btn btn-ghost mt-5">
              로그인
            </Link>
          ) : failure.code === "not_found" ? (
            <p className="mt-3 text-[13.5px]">먼저 프로필을 만들어야 상품 카드를 둘 수 있습니다.</p>
          ) : null}
        </div>
      ) : (
        <OfferManager offers={offers} />
      )}
    </div>
  );
}
