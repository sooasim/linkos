/**
 * P-005 세션 관리 · P-008 동의 · P-010 내보내기 · P-011 탈퇴.
 *
 * 세션 목록은 서버에서 `identity.listSessions(ctx)` 로 읽는다. 토큰 해시는 응답에 없고(모듈 주석)
 * 그래서 이 화면에는 "지금 쓰는 기기"를 표시할 수단이 없다 — 값이 없는 것을 추측해 "현재 기기"
 * 라벨을 붙이면 사용자가 잘못된 기기를 끊는다. 대신 어느 세션을 끊어도 그것이 **이 기기였을 때**
 * 다음 요청에서 로그인 화면으로 돌아간다는 사실을 적는다.
 *
 * 동의 기록(P-008)에는 **읽기 API 가 없다.** `identity.recordConsents()` 는 쓰기 전용이고
 * 조회 경로(`/api/v1/me/consents`)가 아직 없다. 그래서 목록을 지어내지 않고, 지금 확인할 수 있는
 * 경로(내보내기 파일의 `consents`)만 안내한다 (CLAUDE.md §7 "미결정은 임의로 결정하지 않는다").
 */

import { identity } from "@proplus/api";
import { CONSENT_PURPOSES, type ConsentPurpose } from "@proplus/domain";
import type { Metadata } from "next";
import { getViewer } from "@/lib/server";
import { SettingsClient } from "./SettingsClient";

export const metadata: Metadata = { title: "설정", robots: { index: false, follow: false } };

/**
 * 동의 목적의 화면 문구. `CONSENT_PURPOSES` 를 전수로 적어 두면 목적이 추가될 때 타입 에러가 난다 —
 * 새 목적이 라벨 없이 조용히 늘어나는 것을 막는다 (N-11).
 */
const PURPOSE_LABEL: Readonly<Record<ConsentPurpose, string>> = {
  service: "서비스 이용 · 상담 처리",
  privacy: "개인정보 처리",
  marketing: "마케팅 정보 수신 (선택)",
  verification: "검증 절차 진행",
  recording: "통화·회의 기록 (선택)",
};

export default async function SettingsPage() {
  const { userId, ctx } = await getViewer();
  // 레이아웃과 병렬로 렌더되므로 비로그인 상태를 여기서도 끊는다 (/app/page.tsx 주석과 같은 이유).
  if (!userId) return null;

  const sessions = await identity.listSessions(ctx);

  return (
    <div>
      <p className="eyebrow">설정</p>
      <h1 className="display mt-4 text-[32px] sm:text-[42px]">계정과 기기</h1>
      <p className="lede mt-4">
        로그인한 기기를 확인하고 끊을 수 있습니다. 내 데이터를 파일로 받거나 계정 삭제를 요청하는 것도
        여기서 합니다.
      </p>

      {/*
        동의 섹션은 세션과 내보내기 **사이**에 들어가야 읽는 순서가 맞다. 서버 컴포넌트를 클라이언트
        컴포넌트의 children 으로 넘기면 그 자리에 그대로 들어간다 — 이 설명 문구를 클라이언트 번들로
        옮기지 않고도 순서를 지킬 수 있다.
      */}
      <SettingsClient sessions={sessions}>
        <section aria-labelledby="h-consents" className="card flex flex-col gap-3 p-6">
          <h2 id="h-consents" className="text-[17px] font-semibold">
            동의 기록
          </h2>
          <p className="text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
            동의는 목적마다 따로 기록되고, 동의한 약관 버전이 함께 남습니다. 한 번의 체크로 여러 목적을
            묶지 않습니다.
          </p>
          <ul className="flex flex-wrap gap-2">
            {CONSENT_PURPOSES.map((purpose) => (
              <li key={purpose} className="chip">
                {PURPOSE_LABEL[purpose]}
              </li>
            ))}
          </ul>
          <p className="text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
            이 화면에는 아직 동의 이력 목록과 개별 철회 기능이 없습니다. 지금 확인하려면 아래 “내 데이터
            내보내기”로 받은 파일의 <code className="text-[12px]">consents</code> 항목을 보세요.
          </p>
        </section>
      </SettingsClient>
    </div>
  );
}
