"use client";

/**
 * P-051 증거 제출 폼 · P-052 파일 업로드 · P-067 시스템 연동 전용 유형 경고.
 *
 * ## 유형을 고르는 순간 무엇을 알려 주는가
 *
 * 유형마다 **요구 강도**(`minMethod`)와 **발급기관 필요 여부**(`requiresIssuer`)가 다르다.
 * 특히 `minMethod === 'system_integrated'`(거래 실적·응답 시간·사후관리)는 서류로 확인되지 않는다 —
 * 집계값이라 "그 시점의 한 장"으로는 검증이 성립하지 않기 때문이다(P-067 / 기획서 §7).
 * 그 유형에 서류를 올려도 배지가 나오지 않으므로, **선택 시점에** 말해 준다. 제출 뒤에 알려 주면
 * 사용자는 이미 민감한 서류를 올린 상태다.
 *
 * ## 파일 사전 검사
 *
 * 형식·크기 검사는 `@proplus/domain` 의 `EVIDENCE_MIME`·`MAX_EVIDENCE_BYTES` 를 쓴다 —
 * 서버가 쓰는 **같은 상수**다. 화면이 따로 판정하는 것이 아니라 서버 판정을 한 발 앞당겨 보여주는 것이고,
 * 최종 판정은 여전히 서버다(매직바이트 교차검증은 서버만 할 수 있다 → 같은 코드가 응답으로 돌아온다).
 *
 * 왜 `upload` 메타를 제출 본문에 함께 보내는가: 라우트가 제출 직후 업로드 세션을 같은 응답에 끼워 주므로
 * (`POST /me/evidence` 주석) 왕복이 한 번 줄고, 허용 형식·남은 개수를 서버가 말한 값으로 받는다.
 */

import type { proof } from "@proplus/api";
import { EVIDENCE_MIME, type EvidenceSource, MAX_EVIDENCE_BYTES, METHOD_LABEL_KO } from "@proplus/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { ClientError, api, uid, upload } from "@/lib/client";

/** 출처 유형 라벨. `EvidenceSource` 는 도메인 타입이고 라벨은 화면 문구라 여기 둔다. */
const SOURCE_OPTIONS: readonly { value: EvidenceSource; label: string; hint: string }[] = [
  { value: "user", label: "본인이 제출", hint: "내가 가진 서류·증빙을 직접 올립니다." },
  { value: "organization", label: "조직이 제출", hint: "소속 조직이 발급·확인해 준 자료입니다." },
  { value: "third_party", label: "제3자가 제공", hint: "발급기관 등 외부에서 받은 자료입니다." },
  { value: "platform", label: "플랫폼 기록", hint: "서비스 내부 기록을 근거로 합니다." },
];

const ALLOWED_MIME_TEXT = "JPEG · PNG · WebP · PDF";
const MAX_MB = Math.floor(MAX_EVIDENCE_BYTES / (1024 * 1024));

interface Failure {
  code: string;
  message: string;
  /** 증거는 접수됐는데 파일만 실패한 경우. 사용자가 다시 올릴 곳을 알려 주기 위해 남긴다. */
  evidenceId?: string;
}

export function EvidenceForm({ types }: { types: readonly proof.EvidenceTypeDto[] }) {
  const router = useRouter();
  const [typeCode, setTypeCode] = useState<string>(types[0]?.code ?? "");
  const [sourceType, setSourceType] = useState<EvidenceSource>("user");
  const [scope, setScope] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  /**
   * 같은 제출을 두 번 보내지 않기 위한 키. 네트워크 오류 뒤 사용자가 다시 누르면 **같은 키**로 가서
   * 서버가 재생으로 처리한다(CLAUDE.md §5). 성공하면 버린다.
   */
  const idemRef = useRef<string | null>(null);

  const selected = useMemo(() => types.find((t) => t.code === typeCode) ?? null, [types, typeCode]);
  const systemOnly = selected?.minMethod === "system_integrated";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setFailure(null);

    if (file) {
      const mime = (file.type || "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!EVIDENCE_MIME.has(mime)) {
        setFailure({ code: "mime_not_allowed", message: "이미지(JPEG·PNG·WebP) 또는 PDF 만 올릴 수 있습니다." });
        return;
      }
      if (file.size > MAX_EVIDENCE_BYTES) {
        setFailure({ code: "file_too_large", message: `파일은 ${MAX_MB}MB 이하여야 합니다.` });
        return;
      }
    }

    setBusy(true);
    let createdId: string | null = null;
    try {
      idemRef.current ??= uid();
      const created = await api<{ evidenceId: string; upload?: proof.UploadSession }>("/me/evidence", {
        method: "POST",
        idempotencyKey: idemRef.current,
        body: {
          evidenceType: typeCode,
          sourceType,
          scope: scope.trim() || null,
          sourceReference: sourceReference.trim() || null,
          ...(file ? { upload: { declaredMime: file.type, byteSize: file.size } } : {}),
        },
      });
      createdId = created.evidenceId;

      if (file && created.upload) {
        /**
         * `uploadPath` 는 이미 `/api/v1` 로 시작한다. `upload()` 가 또 붙이므로 접두사를 뗀다 —
         * 떼지 않으면 `/api/v1/api/v1/...` 로 가서 404 가 된다.
         *
         * 파일명은 넘기지 않는다: 라우트 주석대로 raw 업로드의 파일명 헤더는 프록시 로그에 남고,
         * 모듈은 파일명을 저장하지도 않는다 (N-13).
         */
        const path = created.upload.uploadPath.replace(/^\/api\/v1/, "");
        await upload(path, file, { method: "POST", idempotencyKey: `${idemRef.current}-file` });
      }

      idemRef.current = null;
      router.push(`/app/evidence/${created.evidenceId}`);
      return;
    } catch (err) {
      const e = err instanceof ClientError ? err : null;
      setFailure({
        code: e?.code ?? "error",
        message: e?.message ?? "제출하지 못했습니다.",
        // 증거는 만들어졌는데 파일만 실패한 경우를 숨기지 않는다 — 사용자가 "제출 안 됨"으로 오해하면 중복 제출이 쌓인다.
        ...(createdId ? { evidenceId: createdId } : {}),
      });
    } finally {
      setBusy(false);
    }
  }

  if (types.length === 0) {
    return (
      <div className="panel mt-8 p-6">
        <p className="text-[15px] font-semibold">지금 제출할 수 있는 증거 유형이 없습니다.</p>
        <p className="mt-2 text-[13.5px] text-[var(--fg-mute)]">
          유형은 운영에서 추가합니다. 잠시 후 다시 확인해 주세요.
        </p>
      </div>
    );
  }

  return (
    <form className="mt-8 flex flex-col gap-7" onSubmit={onSubmit} aria-busy={busy}>
      <div>
        <label className="label" htmlFor="evidence-type">
          무엇을 확인받으시겠습니까?
        </label>
        <select
          id="evidence-type"
          className="field"
          value={typeCode}
          onChange={(e) => setTypeCode(e.target.value)}
          aria-describedby="evidence-type-detail"
        >
          {types.map((t) => (
            <option key={t.code} value={t.code}>
              {t.labelKo}
            </option>
          ))}
        </select>

        {/* 유형의 조건을 **값으로** 보여준다. 문장으로 요약하면 DB 가 바뀌어도 화면이 옛말을 한다. */}
        {selected ? (
          <div id="evidence-type-detail" className="panel mt-3 p-4">
            <dl className="disclosure-dl">
              <dt>확인되면 붙는 라벨</dt>
              <dd>{selected.badgeLabelKo}</dd>

              <dt>필요한 확인 방식</dt>
              <dd>{METHOD_LABEL_KO[selected.minMethod]} 이상</dd>

              <dt>발급기관 확인</dt>
              <dd>{selected.requiresIssuer ? "필요합니다" : "필요하지 않습니다"}</dd>

              <dt>기본 유효기간</dt>
              <dd>{selected.defaultTtlDays ? `${selected.defaultTtlDays}일` : "별도 만료일 없음 (변경 시 즉시 회수)"}</dd>
            </dl>

            {selected.requiresIssuer ? (
              <p className="disclosure-note">
                이 유형은 발급·확인 권한이 있는 기관의 확인이 필요합니다. 본인이 올린 서류만으로는 확인이 끝나지 않습니다.
              </p>
            ) : null}

            {/* P-067: 집계 수치는 연동 데이터만 검증한다. 서류를 올려도 배지가 나오지 않는다. */}
            {systemOnly ? (
              <p className="mt-3 text-[13px] font-semibold leading-relaxed text-[var(--caution)]" role="note">
                이 유형은 연동된 시스템이 보내온 데이터만 확인할 수 있습니다. 서류를 올려도 배지는 발급되지 않습니다. 또한
                수치는 측정 기간·표본 수·집계 기준을 함께 공개할 수 있을 때만 표시됩니다.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <fieldset>
        <legend className="label">자료의 출처</legend>
        <div className="flex flex-col gap-2">
          {SOURCE_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-start gap-3 text-[14.5px]">
              <input
                type="radio"
                name="sourceType"
                value={opt.value}
                checked={sourceType === opt.value}
                onChange={() => setSourceType(opt.value)}
                className="mt-1"
              />
              <span>
                <span className="font-semibold">{opt.label}</span>
                <span className="block text-[13px] text-[var(--fg-mute)]">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label className="label" htmlFor="evidence-scope">
          확인받고 싶은 범위 (선택)
        </label>
        <input
          id="evidence-scope"
          className="field"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          maxLength={200}
          placeholder="예) 2023-03 ~ 2025-08, 영업관리 직무"
          aria-describedby="evidence-scope-hint"
        />
        <p id="evidence-scope-hint" className="mt-2 text-[12.5px] text-[var(--fg-mute)]">
          여기 적는 범위는 “주장”입니다. 공개되는 범위는 검토자가 확인한 범위로 확정됩니다.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="evidence-reference">
          참고 정보 (선택)
        </label>
        <input
          id="evidence-reference"
          className="field"
          value={sourceReference}
          onChange={(e) => setSourceReference(e.target.value)}
          maxLength={300}
          placeholder="예) 자격증 번호, 발급 문서 번호"
        />
      </div>

      <div>
        <label className="label" htmlFor="evidence-file">
          근거 파일 (선택)
        </label>
        <input
          id="evidence-file"
          className="field"
          type="file"
          accept={[...EVIDENCE_MIME].join(",")}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          aria-describedby="evidence-file-hint"
        />
        <p id="evidence-file-hint" className="mt-2 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
          {ALLOWED_MIME_TEXT} · 한 파일 {MAX_MB}MB 까지. 제출 뒤 상세 화면에서 파일을 더 올릴 수 있습니다. 올린 원본은
          공개되지 않고, 열람은 접근 사유와 함께 감사로그에 남습니다.
        </p>
      </div>

      {failure ? (
        <div className="panel p-5" role="alert">
          <p className="text-[14.5px] font-semibold">{failure.message}</p>
          <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]">오류 코드: {failure.code}</p>
          {failure.evidenceId ? (
            <>
              <p className="mt-3 text-[13.5px] leading-relaxed">
                증거 자체는 접수되었습니다. 다시 제출하지 말고 상세 화면에서 파일만 올려 주세요.
              </p>
              <Link href={`/app/evidence/${failure.evidenceId}`} className="btn btn-ghost mt-4">
                접수된 증거 열기
              </Link>
            </>
          ) : null}
        </div>
      ) : null}

      {/* 주요 행동은 아래에 둔다 (브랜드 §7 모바일 우선 — 한 손 엄지 영역). */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? "제출 중…" : "검토 요청"}
        </button>
        <Link href="/app/evidence" className="btn btn-ghost btn-lg">
          취소
        </Link>
      </div>
    </form>
  );
}
