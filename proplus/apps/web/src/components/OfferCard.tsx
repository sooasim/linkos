/**
 * P-090 상품·서비스 카드 · P-092 품절·만료 비공개 · P-093 외부 링크형 상품 · P-033 외부 링크 규칙.
 *
 * 판단은 하지 않는다. 품절·만료·비공개 상품은 `public_offer_view` 가 이미 빼 놓았고
 * 가격도 뷰가 `price_display_policy = 'shown'` 일 때만 금액을 내려준다(0001_proplus_core.sql §M06).
 * 그래서 이 카드는 "받은 것만 그린다" — 가격을 숨길지 말지를 여기서 다시 계산하면 기준이 두 곳에 생긴다.
 *
 * 조직 상품(`ownerType = 'organization'`)은 그 사실만 적고 조직 이름은 적지 않는다:
 * 공개 DTO 에 조직 이름이 없기 때문이고(N-4 allowlist), 없는 값을 추측해 쓰면 제휴 오인이 된다.
 */

import type { profile } from "@proplus/api";
import Link from "next/link";
import { stripDangerousUrl } from "@proplus/domain";

interface OfferCardProps {
  offer: profile.PublicOffer;
  /** 상담 링크를 만들 프로필 주소. 카드가 slug 를 모르면 CTA 가 어디로 갈지 알 수 없다. */
  slug: string;
}

/**
 * 가격 한 줄.
 *
 * 'inquiry'·'hidden' 은 금액이 **없는 것이 정상**이므로 "가격 미정"처럼 부정적으로 적지 않고
 * 무엇을 하면 알 수 있는지를 적는다. 'shown' 인데 금액이 비는 조합은 DB CHECK 가 막지만
 * (`price_display_policy <> 'shown' OR (price_amount IS NOT NULL ...)`), 들어오면 금액 없이 그린다.
 */
function priceLine(offer: profile.PublicOffer): string {
  if (offer.priceDisplayPolicy === "shown" && offer.priceAmount !== null) {
    return formatPrice(offer.priceAmount, offer.priceCurrency);
  }
  if (offer.priceDisplayPolicy === "inquiry") return "가격은 상담 때 안내합니다";
  return "가격 비공개";
}

/**
 * ISO 통화 코드가 아니면 `Intl` 이 RangeError 를 던진다 — 공개 프로필이 그것 때문에 500 이 되면 안 되므로
 * 코드 모양을 먼저 보고, 아니면 숫자와 코드를 그대로 적는다(지어내지 않는다).
 */
function formatPrice(amount: number, currency: string | null): string {
  const code = currency ?? "";
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat("ko-KR", { style: "currency", currency: code, maximumFractionDigits: 0 }).format(amount);
    } catch {
      // 아래 폴백으로 떨어진다.
    }
  }
  const n = new Intl.NumberFormat("ko-KR").format(amount);
  return code.length > 0 ? `${n} ${code}` : n;
}

export function OfferCard({ offer, slug }: OfferCardProps) {
  // P-033: 저장 시점에 걸렀지만 렌더 직전에 한 번 더 본다. javascript: 스킴이 화면에 붙는 경로를 0 으로 둔다.
  const externalUrl = offer.externalUrl ? stripDangerousUrl(offer.externalUrl) : null;

  return (
    <li className="card flex flex-col gap-3 p-5" data-testid="offer-card">
      <div className="flex flex-col gap-2">
        <h3 className="text-[17px] font-semibold">{offer.title}</h3>
        {offer.ownerType === "organization" ? (
          <span className="chip w-fit">소속 조직이 제공하는 서비스</span>
        ) : null}
      </div>

      {/* N-10: 사용자 텍스트는 HTML 로 그리지 않는다. 줄바꿈만 살린다. */}
      {offer.description ? (
        <p className="whitespace-pre-line text-[14.5px] leading-relaxed text-[var(--fg-mute)]">{offer.description}</p>
      ) : null}

      <p className="text-[14px] font-semibold">{priceLine(offer)}</p>

      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        {/* 상품 문의는 모듈이 "그 프로필의 상품인지"를 다시 확인한다(lead.createLead) — 링크는 의도만 전달한다. */}
        <Link href={`/p/${slug}/contact?offer=${offer.id}`} className="btn btn-primary !min-h-11 text-[14px]">
          이 서비스로 문의하기
        </Link>
        {externalUrl ? (
          <a
            href={externalUrl}
            target="_blank"
            rel="nofollow noopener noreferrer"
            className="btn btn-ghost !min-h-11 text-[14px]"
          >
            외부 안내 페이지
            <span className="sr-only"> (새 창으로 열립니다)</span>
          </a>
        ) : null}
      </div>
    </li>
  );
}
