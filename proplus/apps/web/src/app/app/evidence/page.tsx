/**
 * P-051 내 증거 목록 (모듈명세 M04).
 *
 * 서버 컴포넌트가 기본이다 — 데이터는 `getViewer()` 로 ctx 를 얻어 **모듈을 직접 호출**한다.
 * 자기 API 를 fetch 하지 않는 이유: 같은 프로세스이고, 한 번 더 왕복하면 쿠키·세션 회전까지
 * 다시 태워야 한다 (전략 §3 "라우트는 얇은 어댑터").
 *
 * 권한을 판단하지 않는다: 소유자 스코프는 `listMyEvidence` 의 WHERE 에 박혀 있고,
 * 거부되면 모듈이 ApiError 를 던진다. 이 화면이 하는 일은 **그 메시지를 보여주는 것**뿐이다.
 */

import { ApiError, proof } from "@proplus/api";
import type { Metadata } from "next";
import Link from "next/link";
import { getViewer } from "@/lib/server";
import { EvidenceList } from "./EvidenceList";

export const metadata: Metadata = { title: "내 증거" };

export default async function MyEvidencePage() {
  const { ctx } = await getViewer();

  let items: proof.MyEvidenceDto[] = [];
  let failure: { code: string; message: string } | null = null;
  try {
    items = await proof.listMyEvidence(ctx);
  } catch (e) {
    // 401(로그인 필요)·403 도 여기로 온다. 서버가 고른 문구를 바꾸지 않고 그대로 싣는다 (P-187).
    failure =
      e instanceof ApiError
        ? { code: e.code, message: e.message }
        : { code: "internal_error", message: "일시적인 오류가 발생했습니다." };
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">PROPLUS VERIFIED</p>
          <h1 className="display mt-3 text-[32px] sm:text-[42px]">내 증거</h1>
          <p className="lede mt-3 text-[15px]">
            제출한 자료가 어떤 단계에 있는지, 지금 내가 해야 할 일이 있는지 보여줍니다. 확인 방식과 확인일은 확인이 끝난 뒤
            공개 화면에 함께 표시됩니다.
          </p>
        </div>
        <Link href="/app/evidence/new" className="btn btn-primary shrink-0">
          증거 제출
        </Link>
      </header>

      {failure ? (
        <div className="panel mt-8 p-6" role="alert">
          <p className="text-[15px] font-semibold">{failure.message}</p>
          <p className="mt-2 text-[13px] text-[var(--fg-mute)]">오류 코드: {failure.code}</p>
          {failure.code === "unauthorized" ? (
            <Link href="/login?next=/app/evidence" className="btn btn-ghost mt-5">
              로그인
            </Link>
          ) : null}
        </div>
      ) : (
        <EvidenceList items={items} />
      )}

      {/* N-5 / 보안정책 §2: 원본은 공개 경로에서 접근할 수 없다. 당사자에게도 그 사실을 적어 둔다. */}
      <p className="mt-10 max-w-[62ch] text-[13px] leading-relaxed text-[var(--fg-mute)]">
        제출한 증빙 원본은 공개되지 않습니다. 공개되는 것은 확인 결과와 확인 방식·범위·확인일뿐이고, 원본 열람은 접근 사유와
        함께 감사로그에 남습니다.
      </p>
    </div>
  );
}
