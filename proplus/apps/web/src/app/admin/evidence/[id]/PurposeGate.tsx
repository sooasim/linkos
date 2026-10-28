"use client";

/**
 * P-165 접근 사유 게이트 + 증거 내용 렌더.
 *
 * ## 두 단계인 이유
 *
 * 사유를 받기 전에는 증거를 **요청하지 않는다.** 모듈이 거부하기 때문이기도 하지만, 더 중요한 것은
 * 조회가 성공하면 감사로그에 "왜 열었는지"가 함께 남아야 하고 그 "왜"는 사람이 쓴 문장이라는 점이다.
 * 그래서 입력 전에는 아무 내용도 상태에 담지 않는다 — 화면을 숨기는 것이 아니라 데이터를 가져오지 않는다.
 *
 * ## 자유 입력인 이유
 *
 * 드롭다운만 두면 아무거나 고르고 지나간다. 그러면 감사로그에는 목적이 **있지만** 정기 접근검토로
 * 오남용을 가려낼 수 없다 — 모든 행이 똑같은 문구가 되기 때문이다. 예시는 제안으로만 두고,
 * 최종 값은 운영자가 쓴 문장이다. 모듈은 3자 이상만 요구한다.
 *
 * ## 헤더로 보내는 이유 (`x-access-purpose`)
 *
 * 라우트가 헤더를 쿼리스트링보다 먼저 본다. 목적 문구에는 사건번호·담당자 메모가 섞일 수 있고,
 * 쿼리스트링은 nginx 접근로그와 Referer 에 남는다. `lib/client.ts` 의 `api()` 에는 헤더를 넣는
 * 구멍이 없으므로 여기서만 `fetch` 를 직접 쓴다 — `api()` 를 쓰면 목적을 URL 에 실어야 한다.
 */

import type { admin } from "@proplus/api";
import { METHOD_LABEL_KO } from "@proplus/domain";
import { useCallback, useState } from "react";
import { fmtDateTime } from "@/lib/client";
import { ReviewPanel } from "./ReviewPanel";

type EvidenceDetail = admin.EvidenceDetail;

/** 운영자가 쓸 문장의 출발점. 고르면 입력란에 들어가고, 그대로 보내지 않고 고쳐 쓸 수 있다. */
const PURPOSE_EXAMPLES: readonly string[] = [
  "검토 큐 순차 처리",
  "추가 정보 제출분 재검토",
  "이의제기 재심 근거 확인",
  "신고 접수 건 확인",
  "발급기관 확인 통화 기록 대조",
];

const STATUS_LABEL_KO: Readonly<Record<string, string>> = {
  submitted: "대기",
  under_review: "처리중",
  needs_more_info: "추가정보 필요",
  verified: "승인",
  rejected: "반려",
  expired: "만료",
  revoked: "취소",
  disputed: "재확인 중",
};

const SOURCE_LABEL_KO: Readonly<Record<string, string>> = {
  user: "당사자 제출",
  platform: "플랫폼",
  organization: "조직",
  third_party: "제3자",
};

const SCAN_LABEL_KO: Readonly<Record<string, string>> = {
  pending: "검사 대기",
  clean: "이상 없음",
  infected: "악성 판정 — 열 수 없습니다",
  skipped: "검사하지 않음",
};

function bytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** claim 은 `Record<string, unknown>` 이다. 객체·배열이 와도 문자열로만 그린다(임의 HTML 경로를 만들지 않는다 — N-10). */
function claimValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 0 ? v : "—";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "(표시할 수 없는 값)";
  }
}

interface ApiErrorBody {
  code?: string;
  message?: string;
}

/**
 * 증거 상세 조회. 목적을 **헤더로만** 보낸다 (파일 §주석).
 * `api()` 를 쓰지 않는 유일한 자리이므로 실패 처리도 여기서 직접 한다.
 */
async function fetchDetail(evidenceId: string, purpose: string): Promise<EvidenceDetail> {
  const res = await fetch(`/api/v1/admin/evidence/${encodeURIComponent(evidenceId)}`, {
    headers: { "x-access-purpose": purpose },
    credentials: "same-origin",
    cache: "no-store",
  });
  const data: unknown = (res.headers.get("content-type") ?? "").includes("application/json")
    ? await res.json().catch(() => null)
    : null;
  if (!res.ok) {
    const body = (data ?? {}) as ApiErrorBody;
    throw new Error(body.message ?? "증거를 불러오지 못했습니다.");
  }
  return data as EvidenceDetail;
}

interface SignedLink {
  url: string;
  expiresInSec: number;
}

/**
 * P-073 증거 원본 링크. 버튼이 바로 새 탭을 열지 않고 **링크를 보여주는** 이유:
 * 발급은 비동기이고(그 사이 팝업 차단이 끼어든다), 무엇보다 "60초 뒤 만료"와 "다운로드가 기록된다"를
 * 운영자가 누르기 **전에** 읽어야 한다. 조용히 새 탭이 열리면 그 두 문장을 아무도 보지 않는다.
 */
function FileRow({ file, purpose }: { file: EvidenceDetail["files"][number]; purpose: string }) {
  const [link, setLink] = useState<SignedLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/files/${encodeURIComponent(file.fileId)}`, {
        headers: { "x-access-purpose": purpose },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data: unknown = (res.headers.get("content-type") ?? "").includes("application/json")
        ? await res.json().catch(() => null)
        : null;
      if (!res.ok) throw new Error(((data ?? {}) as ApiErrorBody).message ?? "링크를 발급하지 못했습니다.");
      setLink(data as SignedLink);
    } catch (e) {
      setError(e instanceof Error ? e.message : "링크를 발급하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="card flex flex-col gap-2.5 p-4">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[14px]">
        <span className="font-semibold">{file.contentType}</span>
        <span className="text-[var(--fg-mute)]">{bytes(file.byteSize)}</span>
        <span className="chip">{SCAN_LABEL_KO[file.scanStatus] ?? file.scanStatus}</span>
        <span className="text-[12.5px] text-[var(--fg-mute)]">{fmtDateTime(file.uploadedAt)} 업로드</span>
      </div>
      {/* 같은 서류가 다른 계정에서도 올라왔는지 대조하는 단서다. 앞 16자만으로 충분하다. */}
      <p className="text-[12px] text-[var(--fg-mute)]">
        SHA-256 <code>{file.sha256.slice(0, 16)}…</code>
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-ghost !min-h-11 text-[14px]" onClick={() => void issue()} disabled={busy}>
          {busy ? "발급 중…" : "원본 링크 발급"}
        </button>
        {link ? (
          <a
            className="btn btn-primary !min-h-11 text-[14px]"
            href={link.url}
            target="_blank"
            rel="noreferrer"
          >
            원본 열기
          </a>
        ) : null}
      </div>

      {/* 만료 시간은 서버 설정값이므로 숫자를 미리 적지 않는다 — 발급 응답의 값을 그대로 보여준다. */}
      <p className="text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
        {link
          ? `이 링크는 발급 시점부터 ${link.expiresInSec}초 뒤 만료됩니다. 만료되면 다시 발급해야 합니다.`
          : "발급된 링크는 짧은 시간(기본 60초) 뒤 만료됩니다."}{" "}
        발급과 열람은 매번 접근 사유와 함께 감사로그에 기록됩니다.
      </p>

      {error ? (
        <p role="alert" className="text-[13px] font-semibold text-[var(--caution)]">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function PurposeGate({ evidenceId }: { evidenceId: string }) {
  const [input, setInput] = useState("");
  /** 조회에 **실제로 사용된** 사유. 파일 링크 발급과 재조회가 같은 문장을 써야 감사로그가 일관된다. */
  const [purpose, setPurpose] = useState<string | null>(null);
  const [detail, setDetail] = useState<EvidenceDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fetchDetail(evidenceId, value);
      setDetail(next);
      setPurpose(value);
    } catch (e) {
      // 목적이 짧으면 모듈이 `access_purpose_required` 로 거부한다. 그 메시지를 그대로 보여준다.
      setError(e instanceof Error ? e.message : "증거를 불러오지 못했습니다.");
      setDetail(null);
      setPurpose(null);
    } finally {
      setBusy(false);
    }
  }, [evidenceId]);

  // 아직 사유가 없다 → 입력 폼만 그린다. 증거 내용은 이 시점에 브라우저에 없다.
  if (!detail || !purpose) {
    return (
      <form
        className="card flex max-w-2xl flex-col gap-4 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void open(input.trim());
        }}
      >
        <div>
          <h2 className="text-[19px] font-semibold">접근 사유를 입력하세요</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-[var(--fg-mute)]">
            이 화면에는 당사자의 이름·지역과 제출한 주장, 증빙 파일, 검증자 내부 메모가 들어 있습니다.
            조회는 입력한 사유와 함께 감사로그에 기록되며, 사유 없이는 조회할 수 없습니다.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="access-purpose">
            접근 사유 <span aria-hidden="true">·</span> 필수 (3자 이상)
          </label>
          <input
            id="access-purpose"
            className="field"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="예: 검토 큐 순차 처리"
            maxLength={200}
            autoComplete="off"
            required
            aria-describedby="access-purpose-note"
          />
          <p id="access-purpose-note" className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
            아래는 예시입니다. 실제로 지금 이 건을 여는 이유를 적어 주세요 — 모두 같은 문구로 남으면
            정기 접근검토가 아무 의미를 갖지 못합니다.
          </p>
        </div>

        <ul className="flex flex-wrap gap-1.5">
          {PURPOSE_EXAMPLES.map((x) => (
            <li key={x}>
              <button
                type="button"
                className="chip text-[var(--fg-mute)] hover:border-[var(--accent)] hover:text-[var(--accent-text)]"
                onClick={() => setInput(x)}
              >
                {x}
              </button>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={busy || input.trim().length < 3}>
            {busy ? "불러오는 중…" : "사유를 기록하고 열기"}
          </button>
        </div>

        {error ? (
          <p role="alert" className="text-[14px] font-semibold text-[var(--caution)]">
            {error}
          </p>
        ) : null}
      </form>
    );
  }

  const subjectName = detail.subject.displayName ?? "이름 없음";

  return (
    <div className="flex flex-col gap-7">
      <div className="panel flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <p className="text-[13.5px]">
          <span className="text-[var(--fg-mute)]">이 조회의 기록된 사유</span>{" "}
          <strong className="font-semibold">{purpose}</strong>
        </p>
        <button
          type="button"
          className="btn btn-ghost !min-h-10 ml-auto text-[13.5px]"
          onClick={() => void open(purpose)}
          disabled={busy}
        >
          {busy ? "새로 고치는 중…" : "같은 사유로 새로 고침"}
        </button>
      </div>

      {error ? (
        <p role="alert" className="card border-[var(--caution)] p-4 text-[14px] text-[var(--caution)]">
          {error}
        </p>
      ) : null}

      <section aria-labelledby="ev-summary" className="flex flex-col gap-3">
        <h2 id="ev-summary" className="text-[19px] font-semibold">
          요약
        </h2>
        <dl className="card grid gap-x-8 gap-y-3 p-5 text-[14px] sm:grid-cols-2">
          <div>
            <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">증거 유형</dt>
            <dd>
              {detail.typeLabelKo} <code className="text-[12px] text-[var(--fg-mute)]">{detail.evidenceType}</code>
            </dd>
          </div>
          <div>
            <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">현재 상태</dt>
            <dd className="font-semibold">{STATUS_LABEL_KO[detail.status] ?? detail.status}</dd>
          </div>
          <div>
            <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">요구 최소 강도</dt>
            <dd>{METHOD_LABEL_KO[detail.minMethod]} 이상</dd>
          </div>
          <div>
            <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">발급기관 확인</dt>
            <dd>{detail.requiresIssuer ? "필요" : "요구되지 않음"}</dd>
          </div>
          <div>
            <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">제출</dt>
            <dd>{fmtDateTime(detail.submittedAt)}</dd>
          </div>
          <div>
            <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">출처</dt>
            <dd>
              {SOURCE_LABEL_KO[detail.sourceType] ?? detail.sourceType}
              {detail.sourceReference ? ` · ${detail.sourceReference}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">승인 시 배지 라벨</dt>
            <dd>{detail.badgeLabelKo}</dd>
          </div>
          <div>
            <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">유형 기본 유효기간</dt>
            <dd>{detail.defaultTtlDays === null ? "없음" : `${detail.defaultTtlDays}일`}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="ev-subject" className="flex flex-col gap-3">
        <h2 id="ev-subject" className="text-[19px] font-semibold">
          대상
        </h2>
        <dl className="card grid gap-x-8 gap-y-3 p-5 text-[14px] sm:grid-cols-2">
          <div>
            <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">구분</dt>
            <dd>{detail.subject.type === "profile" ? "개인 프로필" : "조직"}</dd>
          </div>
          <div>
            <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">표시 이름</dt>
            <dd>{subjectName}</dd>
          </div>
          <div>
            <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">공개 주소</dt>
            <dd>{detail.subject.slug ? `/p/${detail.subject.slug}` : "발행되지 않음"}</dd>
          </div>
          <div>
            <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">지역</dt>
            <dd>{detail.subject.region ?? "미입력"}</dd>
          </div>
        </dl>
        {detail.issuer ? (
          <dl className="card grid gap-x-8 gap-y-3 p-5 text-[14px] sm:grid-cols-2">
            <div>
              <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">발급기관</dt>
              <dd className="font-semibold">{detail.issuer.name}</dd>
            </div>
            <div>
              <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">기관 종류</dt>
              <dd>{detail.issuer.kind}</dd>
            </div>
            <div>
              <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">기관 권한 확인</dt>
              <dd>
                {detail.issuer.authorityCheckedAt
                  ? `${fmtDateTime(detail.issuer.authorityCheckedAt)} 확인`
                  : "확인되지 않음"}
              </dd>
            </div>
          </dl>
        ) : detail.requiresIssuer ? (
          <p className="panel p-4 text-[14px] text-[var(--pending)]">
            이 유형은 발급기관 확인이 필요하지만 발급기관이 지정되지 않았습니다.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="ev-claim" className="flex flex-col gap-3">
        <h2 id="ev-claim" className="text-[19px] font-semibold">
          당사자가 제출한 주장
        </h2>
        {Object.keys(detail.claim).length === 0 ? (
          <p className="panel p-4 text-[14px] text-[var(--fg-mute)]">제출된 주장 필드가 없습니다.</p>
        ) : (
          <dl className="card grid gap-x-8 gap-y-3 p-5 text-[14px] sm:grid-cols-2">
            {Object.entries(detail.claim).map(([key, value]) => (
              <div key={key}>
                <dt className="text-[12.5px] font-semibold text-[var(--fg-mute)]">
                  <code>{key}</code>
                </dt>
                <dd className="break-words">{claimValue(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section aria-labelledby="ev-files" className="flex flex-col gap-3">
        <h2 id="ev-files" className="text-[19px] font-semibold">
          증빙 파일 {detail.files.length}개
        </h2>
        {detail.files.length === 0 ? (
          <p className="panel p-4 text-[14px] text-[var(--fg-mute)]">첨부된 파일이 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {detail.files.map((f) => (
              <FileRow key={f.fileId} file={f} purpose={purpose} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ev-history" className="flex flex-col gap-3">
        <h2 id="ev-history" className="text-[19px] font-semibold">
          검증 이력 {detail.verifications.length}건
        </h2>
        {/*
          공개 배지(Badge 컴포넌트)를 여기서 그리지 않는다: `verifications` 는 판정 이력이고
          공개 배지는 `badges` 테이블에서 따로 나온다(N-5). 판정 행으로 배지를 꾸며 보여주면
          "지금 공개되고 있는 상태"를 잘못 말하게 된다 — 배지는 취소·만료로 독립해서 내려간다.
        */}
        {detail.verifications.length === 0 ? (
          <p className="panel p-4 text-[14px] text-[var(--fg-mute)]">아직 판정 이력이 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {detail.verifications.map((v) => (
              <li key={v.id} className="card flex flex-col gap-2 p-4 text-[14px]">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className="font-semibold">{STATUS_LABEL_KO[v.status] ?? v.status}</span>
                  <span className="chip">{METHOD_LABEL_KO[v.method]}</span>
                  <span className="text-[12.5px] text-[var(--fg-mute)]">{fmtDateTime(v.createdAt)} 기록</span>
                </div>
                <p className="text-[13.5px] text-[var(--fg-mute)]">
                  범위 {v.scope ?? "—"} · 사유 코드 {v.reasonCode ?? "—"} · 정책 {v.policyVersion}
                </p>
                <p className="text-[13.5px] text-[var(--fg-mute)]">
                  확인일 {v.verifiedAt ? fmtDateTime(v.verifiedAt) : "—"} · 만료{" "}
                  {v.expiresAt ? fmtDateTime(v.expiresAt) : "없음"}
                </p>
                <p className="text-[12px] text-[var(--fg-mute)]">
                  검증 ID <code>{v.id}</code>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ev-notes" className="flex flex-col gap-3">
        <h2 id="ev-notes" className="text-[19px] font-semibold">
          검증자 내부 메모 {detail.notes.length}건
        </h2>
        {/* P-164: 이 영역은 검증 콘솔 전용이다. 당사자 조회 경로에는 조인되지 않는다. */}
        <p className="text-[13px] font-semibold text-[var(--accent-text)]">
          당사자에게 보이지 않습니다. 당사자에게 전할 말은 아래 “반려”·“추가 정보 요청”의 안내 문구에 적습니다.
        </p>
        {detail.notes.length === 0 ? (
          <p className="panel p-4 text-[14px] text-[var(--fg-mute)]">기록된 메모가 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {detail.notes.map((n) => (
              <li key={n.id} className="panel flex flex-col gap-1.5 p-4 text-[14px]">
                <p className="whitespace-pre-wrap break-words">{n.note}</p>
                <p className="text-[12px] text-[var(--fg-mute)]">
                  {fmtDateTime(n.createdAt)} · 작성자 <code>{n.reviewerId}</code> · 검증{" "}
                  <code>{n.verificationId}</code>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.appeals.length > 0 ? (
        <section aria-labelledby="ev-appeals" className="flex flex-col gap-3">
          <h2 id="ev-appeals" className="text-[19px] font-semibold">
            이의제기 {detail.appeals.length}건
          </h2>
          <ul className="flex flex-col gap-3">
            {detail.appeals.map((a) => (
              <li key={a.id} className="card flex flex-col gap-1.5 p-4 text-[14px]">
                <p className="font-semibold">{a.status === "open" ? "처리 전" : a.status}</p>
                <p className="text-[13px] text-[var(--fg-mute)]">
                  {fmtDateTime(a.createdAt)} 접수
                  {a.resolvedAt ? ` · ${fmtDateTime(a.resolvedAt)} 처리` : ""}
                </p>
                <p className="text-[12px] text-[var(--fg-mute)]">
                  이의제기 ID <code>{a.id}</code>
                </p>
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-[var(--fg-mute)]">
            처리 전 이의제기가 있으면 이의제기 화면에서 먼저 결정하세요. 재심 결정이 이 증거의 상태를 바꿉니다.
          </p>
        </section>
      ) : null}

      <ReviewPanel detail={detail} onChanged={() => void open(purpose)} />
    </div>
  );
}
