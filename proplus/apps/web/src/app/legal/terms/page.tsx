/**
 * 이용 안내 — 로그인 화면과 푸터가 링크하는 주소.
 *
 * 정식 약관이 아니다. 출처 문서(00_통합기획서 §13, 10_전제와_미결정사항)가 결제·정산·환불 구조와
 * 서비스 역할을 **미결정**으로 두고 있어, 그 위에 계약 조건을 지어내면 그것이 곧 거짓이 된다.
 * 그래서 지금 확실한 것만 적는다: 이것이 테스트 운영이라는 사실과, 검증 배지의 의미.
 *
 * 특히 배지 문단은 제품의 핵심 주장(N-1·N-2·N-8)을 사용자 언어로 옮긴 것이고,
 * 그 주장들은 코드와 DB 제약으로 강제된다 — 즉 여기 적힌 것은 마케팅이 아니라 동작 설명이다.
 */

import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "이용 안내 — PROPLUS",
  robots: { index: false, follow: false },
};

export default function TermsPage() {
  return (
    <article>
      <p className="eyebrow">이용 안내</p>
      <h1 className="display mt-3 text-[30px] sm:text-[38px]">이용 안내</h1>

      <div className="panel mt-6 p-5">
        <p className="text-[14px] leading-relaxed">
          <b>이 서비스는 현재 테스트 운영 중입니다.</b> 정식 이용약관은 서비스 범위와 결제·정산 구조가
          확정된 뒤 공개됩니다. 테스트 기간에는 데이터가 예고 없이 초기화될 수 있고, 기능이 수시로 바뀝니다.
          실제 거래나 계약의 근거로 사용하지 마세요.
        </p>
      </div>

      <h2 className="mt-9 text-[18px] font-semibold">검증 배지가 뜻하는 것</h2>
      <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        배지는 점수가 아니라 <b>무엇을, 누가, 언제, 어떤 범위로 확인했는지</b>에 대한 기록입니다.
        배지마다 확인 방식·확인 범위·확인일을 함께 표시하며, 눌러서 상세를 볼 수 있습니다.
      </p>
      <ul className="mt-3 grid gap-1.5 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        <li>• <b>본인이 직접 적은 내용은 배지가 되지 않습니다.</b> 서류·발급기관·시스템 연동 중 하나로 확인된 항목만 배지가 됩니다.</li>
        <li>• <b>배지는 돈으로 살 수 없습니다.</b> 요금제는 기능 이용 범위만 정하고 검증 결과에는 영향을 주지 않습니다.</li>
        <li>• 거래 건수 같은 숫자는 <b>측정 기간·표본 수·집계 기준</b>을 함께 표시합니다. 그 셋이 없는 수치는 표시하지 않습니다.</li>
        <li>• 확인 내용이 만료되거나 취소되면 공개 화면에서 <b>즉시</b> 사라집니다.</li>
        <li>• 확인 결과에 이의가 있으면 이의제기를 접수할 수 있고, 절차가 진행되는 동안에는 “확인 필요”로만 표시합니다.</li>
      </ul>
      <p className="mt-3 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        배지는 확인한 범위 안에서만 사실을 말합니다. 거래 상대의 신뢰성 전체를 보증하지 않으며,
        거래 판단의 책임을 대신하지 않습니다.
      </p>

      <h2 className="mt-9 text-[18px] font-semibold">프로필에 올릴 수 없는 것</h2>
      <ul className="mt-2 grid gap-1.5 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        <li>• 근거 없는 과장 표현(“국내 1위”, “100% 검증” 등) — 저장 단계에서 거부됩니다.</li>
        <li>• 타인의 개인정보, 고객 계약서 등 제3자의 비공개 정보</li>
        <li>• 직접 작성한 스크립트·임의 HTML — 허용된 구성 요소로만 페이지를 만듭니다.</li>
      </ul>

      <h2 className="mt-9 text-[18px] font-semibold">상담 요청</h2>
      <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        상담 요청은 해당 프로필의 담당자에게 전달됩니다. 답변 시점과 내용은 담당자에게 달려 있으며,
        이 서비스는 응답 속도나 거래 성사를 약속하지 않습니다.
      </p>

      <h2 className="mt-9 text-[18px] font-semibold">신고</h2>
      <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        허위 정보나 부적절한 내용을 발견하면 신고할 수 있습니다. 접수된 신고는 기록으로 남고
        운영자가 확인합니다.
      </p>

      <p className="mt-10 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
        개인정보 처리에 대한 안내는{" "}
        <Link href="/legal/privacy" className="underline underline-offset-2">개인정보 처리 안내</Link>를 보세요.
        이 문서는 법률 자문이 아니며 정식 이용약관을 대체하지 않습니다.
      </p>
    </article>
  );
}
