/**
 * P-021/P-027/P-028/P-029 프로필 편집 화면.
 *
 * 서버에서 **소유자 경로**(`profile.getMyProfile` / `listVersions` / `completenessFor`)로 한 번에
 * 읽고, 편집·발행만 클라이언트로 내린다. 공개 뷰(`public_profile_view`)를 읽지 않는 이유:
 * 여기서 보여야 하는 것은 "지금 저장된 내용"이고, 공개 뷰는 발행된 것만 돌려준다 —
 * 미발행 프로필을 편집할 수 없게 된다 (profile.ts 상단 주석의 두 경로 구분).
 *
 * 작성 안내(P-032)를 **서버에서 그리는** 이유가 두 가지다:
 *   - 라벨 표(`COMPLETENESS_LABEL_KO`)가 서버에만 있으면 도메인 패키지를 클라이언트 번들로
 *     끌어오지 않는다.
 *   - 저장·발행 뒤 클라이언트가 `router.refresh()` 를 부르면 이 서버 섹션이 다시 렌더된다 —
 *     안내를 클라이언트에서 따로 계산하지 않아도 항상 최신이다(계산하면 서버와 어긋날 수 있다).
 *
 * 이름을 `guidance` 로만 쓴다. "score"·"trust" 로 부르는 순간 표시도 점수가 된다 (N-3).
 */

import { profile } from "@proplus/api";
import { COMPLETENESS_ITEMS, COMPLETENESS_LABEL_KO } from "@proplus/domain";
import type { Metadata } from "next";
import { getViewer } from "@/lib/server";
import { ProfileEditor } from "./ProfileEditor";

export const metadata: Metadata = { title: "프로필", robots: { index: false, follow: false } };

function guidanceLabel(code: string): string {
  // Record<CompletenessItem,…> 는 임의 문자열로 색인할 수 없으므로 한 번 넓혀 읽는다.
  const table: Readonly<Record<string, string>> = COMPLETENESS_LABEL_KO;
  return table[code] ?? code;
}

export default async function ProfilePage() {
  const { userId, ctx } = await getViewer();
  // 레이아웃과 병렬로 렌더되므로 비로그인 상태를 여기서도 끊는다 (/app/page.tsx 주석과 같은 이유).
  if (!userId) return null;

  const mine = await profile.getMyProfile(ctx);
  const [versions, guidance] = mine
    ? await Promise.all([profile.listVersions(ctx), profile.completenessFor(ctx)])
    : [[], null];

  return (
    <div>
      <p className="eyebrow">프로필</p>
      <h1 className="display mt-4 text-[32px] sm:text-[42px]">{mine ? "내 프로필" : "프로필 만들기"}</h1>
      <p className="lede mt-4">
        여기 적은 내용은 자기기재입니다. 확인이 필요한 항목은 검증 화면에서 증거를 제출하면 배지로 따로
        표시됩니다 — 설명과 확인을 섞지 않는 것이 이 제품의 전제입니다.
      </p>

      {guidance && guidance.missing.length > 0 ? (
        <section aria-labelledby="h-guidance" className="panel mt-8 p-5">
          <h2 id="h-guidance" className="text-[15px] font-semibold">
            작성 안내
          </h2>
          <p className="mt-1 text-[13px] text-[var(--fg-mute)]">
            {COMPLETENESS_ITEMS.length}개 중 {COMPLETENESS_ITEMS.length - guidance.missing.length}개 작성됨. 신뢰도 점수가
            아니며 검색 노출 순서에 쓰이지 않습니다.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {guidance.missing.map((code) => (
              <li key={code} className="chip">
                {guidanceLabel(code)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ProfileEditor initial={mine} versions={versions} />
    </div>
  );
}
