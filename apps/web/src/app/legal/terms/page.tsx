import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "이용약관" };

export default function Terms() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 leading-relaxed">
      <Link href="/" className="text-[14px] text-[var(--fg-mute)]">← LINKOS</Link>
      <h1 className="display mt-6 text-[56px]">이용약관</h1>
      <p className="mt-2 text-[13px] text-[var(--fg-mute)]">정책 버전 2026-10-01 · 출시 전 법률 검토 필요(초안)</p>
      <div className="mt-8 space-y-6 text-[15.5px]">
        <p>LINKOS는 디지털 명함 교환, 연락처·관계 관리, 회의 기록, 비즈니스 매칭 기능을 제공합니다.</p>
        <p>이용자는 본인이 공유할 권한이 있는 정보만 교환해야 하며, 타인의 정보를 제3자에게 소개할 때는 양측의 동의를 받아야 합니다.</p>
        <p>회의 녹음 기능은 모든 참여자의 동의가 기록된 경우에만 사용할 수 있습니다.</p>
        <p>AI 추천(매칭, 브리핑, 후속 초안)은 참고용이며 자동으로 발송·확정되지 않습니다.</p>
      </div>
    </main>
  );
}
