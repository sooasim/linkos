/**
 * P-050/P-051/P-052 증거 제출 화면.
 *
 * 유형 목록은 서버에서 **모듈을 직접 호출해** 가져온다(`proof.listEvidenceTypes()`).
 * `GET /api/v1/evidence-types` 와 같은 데이터이고 그 라우트는 브라우저용이다 — 서버 컴포넌트가
 * 자기 API 를 fetch 하면 같은 프로세스를 한 번 더 돌게 된다.
 *
 * 유형은 코드 enum 이 아니라 참조 테이블이다(P-050). 그래서 목록을 하드코딩하지 않고,
 * **요구 강도(`minMethod`)와 발급기관 필요 여부(`requiresIssuer`)도 DB 값을 그대로 보여준다** —
 * 이 두 값이 "서류를 올려도 배지가 나오지 않는 유형"을 결정한다(P-067).
 */

import { ApiError, proof } from "@proplus/api";
import type { Metadata } from "next";
import Link from "next/link";
import { EvidenceForm } from "./EvidenceForm";

export const metadata: Metadata = { title: "증거 제출" };

export default async function NewEvidencePage() {
  let types: proof.EvidenceTypeDto[] = [];
  let failure: { code: string; message: string } | null = null;
  try {
    types = await proof.listEvidenceTypes();
  } catch (e) {
    failure =
      e instanceof ApiError
        ? { code: e.code, message: e.message }
        : { code: "internal_error", message: "일시적인 오류가 발생했습니다." };
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
      <nav aria-label="이동 경로" className="text-[13px] text-[var(--fg-mute)]">
        <Link href="/app/evidence" className="hover:text-[var(--fg)]">
          내 증거
        </Link>
        <span aria-hidden="true"> · </span>
        <span>증거 제출</span>
      </nav>

      <h1 className="display mt-4 text-[32px] sm:text-[40px]">증거 제출</h1>
      <p className="lede mt-3 text-[15px]">
        무엇을 확인받을지 고르면, 그 유형이 요구하는 확인 방식과 발급기관 조건을 함께 보여줍니다. 제출하면 검토 대기 상태로
        들어가고, 검토자가 추가 자료를 요청하면 알려 드립니다.
      </p>

      {/* N-1: 자기기재는 어떤 경로로도 '확인됨'이 되지 않는다. 제출 전에 알려 두는 것이 공정하다. */}
      <div className="panel mt-7 p-5">
        <h2 className="text-[15px] font-semibold">제출 전에 알아 두실 것</h2>
        <ul className="mt-3 flex flex-col gap-2 text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
          <li>· 직접 적은 내용(자기기재)만으로는 확인 완료가 되지 않습니다. 근거 자료가 필요합니다.</li>
          <li>· 올린 원본은 공개되지 않습니다. 공개되는 것은 확인 결과와 확인 방식·범위·확인일뿐입니다.</li>
          <li>· 제출 시점에 적는 범위는 “주장”입니다. 공개되는 범위는 검토자가 확인한 범위로 확정됩니다.</li>
          <li>· 파일은 JPEG·PNG·WebP·PDF 만 받고, 한 파일은 10MB 까지입니다.</li>
        </ul>
      </div>

      {failure ? (
        <div className="panel mt-8 p-6" role="alert">
          <p className="text-[15px] font-semibold">{failure.message}</p>
          <p className="mt-2 text-[13px] text-[var(--fg-mute)]">오류 코드: {failure.code}</p>
        </div>
      ) : (
        <EvidenceForm types={types} />
      )}
    </div>
  );
}
