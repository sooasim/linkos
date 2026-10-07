import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "개인정보 처리방침" };

// 초안: 출시 전 법률 검토 필수 (백서 12 — 법률 검토를 출시 게이트에 포함)
export default function Privacy() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 leading-relaxed">
      <Link href="/" className="text-[14px] text-[var(--fg-mute)]">← LINKOS</Link>
      <h1 className="display mt-6 text-[56px]">개인정보 처리방침</h1>
      <p className="mt-2 text-[13px] text-[var(--fg-mute)]">정책 버전 2026-10-01 · 출시 전 법률 검토 필요(초안)</p>
      <div className="mt-8 space-y-6 text-[15.5px]">
        <section><h2 className="text-[19px] font-semibold">1. 수집 항목</h2><p>계정: 이메일, (선택) 표시 이름. 명함 교환: 이용자가 직접 선택해 보낸 항목(이름, 회사, 직책, 연락처 등). 명함 사진은 기기 내에서만 분석되며 서버로 전송되지 않고, 인식된 텍스트와 신뢰도만 저장됩니다.</p></section>
        <section><h2 className="text-[19px] font-semibold">2. 이용 목적</h2><p>명함 교환 및 연락처 관리, 관계 기록, 이용자가 허용한 경우 Need↔Offer 추천, Google 연락처 동기화.</p></section>
        <section><h2 className="text-[19px] font-semibold">3. 동의의 분리</h2><p>서비스 약관, 개인정보 수집·이용, 마케팅 수신, 명함 교환, 외부 연동(Google), 회의 녹음 동의를 각각 별도로 기록하고 정책 버전을 남깁니다.</p></section>
        <section><h2 className="text-[19px] font-semibold">4. 보관 및 파기</h2><p>계정 삭제 요청 시 즉시 로그인과 교환 링크가 중지되며 7일 유예 후 영구 삭제됩니다. 비회원 교환으로 생성된 Claim 정보는 30일 후 만료됩니다.</p></section>
        <section><h2 className="text-[19px] font-semibold">5. 이용자의 권리</h2><p>설정 화면에서 언제든 내 데이터 전체를 내려받고(JSON), 동의를 철회하고, 계정을 삭제할 수 있습니다.</p></section>
        <section><h2 className="text-[19px] font-semibold">6. 보안</h2><p>교환 링크는 192비트 무작위 토큰이며 서버에는 해시만 저장됩니다. 로그와 분석 이벤트에는 전화번호·이메일 원문을 남기지 않습니다. 외부 연동 자격증명은 암호화하여 보관합니다.</p></section>
      </div>
    </main>
  );
}
