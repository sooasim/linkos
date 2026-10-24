/**
 * 개인정보 처리 안내 — 상담 동의 폼과 로그인 화면이 링크하는 주소.
 *
 * **지어내지 않는다.** 아래 내용은 전부 저장소에서 확인 가능한 사실이다:
 *   수집 항목 → `db/migrations/0001_proplus_core.sql` 의 `leads`·`consent_records`·`analytics_events`
 *   암호화    → `services/api/src/lib/crypto.ts` (AES-256-GCM), `leads.contact_channel_encrypted`
 *   보존기간  → `modules/lead.ts` 의 `DEFAULT_LEAD_RETENTION_DAYS = 180` + `retention_policies` 테이블
 *   동의 분리 → `domain/consent.ts` 의 `REQUIRED_FOR_LEAD = ['service']`
 *
 * 법적 약속(국외 이전, 위탁사 목록, 확정 보유기간)은 **미결정**이라 적지 않는다.
 * 출처 문서 10_전제와_미결정사항.md 가 그것들을 미정으로 명시한다.
 */

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "개인정보 처리 안내 — PROPLUS",
  robots: { index: false, follow: false },
};

export default function PrivacyPage() {
  return (
    <article>
      <p className="eyebrow">개인정보</p>
      <h1 className="display mt-3 text-[30px] sm:text-[38px]">개인정보 처리 안내</h1>

      <div className="panel mt-6 p-5">
        <p className="text-[14px] leading-relaxed">
          <b>이 서비스는 현재 테스트 운영 중입니다.</b> 아래 내용은 지금 시스템이 실제로 하는 일을 적은 것이며,
          법률 검토를 마친 정식 개인정보 처리방침이 아닙니다. 정식 방침은 서비스 범위와 데이터 흐름이
          확정된 뒤 전문가 검토를 거쳐 공개됩니다. 민감한 실제 개인정보를 입력하지 마세요.
        </p>
      </div>

      <h2 className="mt-9 text-[18px] font-semibold">무엇을 수집하나</h2>
      <h3 className="mt-5 text-[15px] font-semibold">상담을 요청할 때</h3>
      <ul className="mt-2 grid gap-1.5 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        <li>• 성함, 연락처(이메일 또는 휴대전화 번호 중 선택한 하나), 문의 내용</li>
        <li>• 어떤 프로필·상품을 보고 문의했는지, 유입 경로(UTM) 정보</li>
        <li>• 동의 기록 — <b>목적별로 분리</b>해 저장합니다(상담 처리 / 마케팅 수신). 동의 시점의 방침 버전을 함께 기록합니다.</li>
      </ul>

      <h3 className="mt-5 text-[15px] font-semibold">프로필을 만들 때</h3>
      <ul className="mt-2 grid gap-1.5 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        <li>• 로그인용 이메일, 공개 프로필에 직접 입력한 내용</li>
        <li>• 검증을 신청한 경우 제출한 증빙 파일과 그 검토 기록</li>
      </ul>

      <h3 className="mt-5 text-[15px] font-semibold">화면을 열 때</h3>
      <ul className="mt-2 grid gap-1.5 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        <li>• 조회·클릭 집계. <b>IP 주소와 브라우저 정보는 원문으로 저장하지 않습니다</b> — 되돌릴 수 없는 해시로만 기록합니다.</li>
        <li>• 유입 경로는 호스트 이름까지만 남기고 전체 주소는 남기지 않습니다.</li>
      </ul>

      <h2 className="mt-9 text-[18px] font-semibold">어떻게 보호하나</h2>
      <ul className="mt-2 grid gap-1.5 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        <li>• 남긴 연락처는 <b>암호화해 저장</b>합니다. 담당자 목록 화면에는 가려진 형태(<code>ab***@example.com</code>)로만 보입니다.</li>
        <li>• 담당자가 연락처 전문을 열람하면 <b>그 사실이 기록</b>됩니다.</li>
        <li>• 검증용으로 제출한 증빙 원본은 공개 프로필에 노출되지 않으며, 짧은 시간만 유효한 링크로만 열립니다.</li>
        <li>• 운영자가 개인 데이터를 조회하려면 <b>조회 사유를 입력</b>해야 하고, 그 사유가 기록으로 남습니다.</li>
        <li>• 로그와 외부 연동 기록에는 연락처 원문을 남기지 않습니다.</li>
      </ul>

      <h2 className="mt-9 text-[18px] font-semibold">얼마나 보관하나</h2>
      <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        상담 내역은 기본 <b>180일</b> 뒤 삭제·익명화합니다. 데이터 종류별 확정 보유기간은
        법률 검토 후 정해지며, 정해지기 전까지 이 기본값으로 운영합니다.
      </p>

      <h2 className="mt-9 text-[18px] font-semibold">마케팅 수신 동의</h2>
      <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        상담 처리 동의와 <b>분리해서</b> 받습니다. 마케팅 수신에 동의하지 않아도 상담은 그대로 진행됩니다.
        동의하지 않은 분에게는 상담과 무관한 안내를 보내지 않습니다.
      </p>

      <h2 className="mt-9 text-[18px] font-semibold">삭제·열람 요청</h2>
      <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--fg-mute)]">
        계정이 있으면 설정 화면에서 내 데이터를 내보내거나 계정 삭제를 요청할 수 있습니다.
        계정 없이 상담만 남긴 경우에는 문의한 프로필의 담당자에게 삭제를 요청하세요.
        테스트 운영 기간에는 전체 데이터가 예고 없이 초기화될 수 있습니다.
      </p>

      <p className="mt-10 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
        이 안내는 법률 자문이 아니며, 정식 개인정보 처리방침을 대체하지 않습니다.
      </p>
    </article>
  );
}
