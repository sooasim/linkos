/**
 * P-166 감사로그 조회 — "append-only. 일반 사용자에게 수정/삭제 권한이 없다"(수용기준 / N-7).
 *
 * ## 수정·삭제 버튼이 없는 것이 이 화면의 요구사항이다
 *
 * `audit_logs` 는 `BEFORE UPDATE OR DELETE` 트리거가 예외를 던지므로 그런 버튼을 만들면 반드시
 * 런타임에 터진다. 하지만 더 중요한 이유는 **보이는 것**이다: 지울 수 있을 것처럼 보이는 화면은
 * 기록을 지울 수 있다고 말하는 것과 같다. 그래서 읽기 전용이라는 사실을 화면에 적는다.
 *
 * ## 조건 없는 전체 조회 UI 를 만들지 않는다
 *
 * `aggregateType` 이 필수다(라우트가 400 으로 막는다). 조건 없는 전체 감사로그 열람은
 * "운영자 내부 오남용"(보안정책 §2)의 가장 쉬운 형태이고, 화면에서 쓸 수 있는 양도 아니다.
 * 그래서 이 페이지는 유형이 없으면 **조회하지 않고** 입력 폼만 그린다.
 *
 * 조회 자체도 `admin.audit_viewed` 로 기록된다 — 감사로그를 누가 들여다봤는지가 정기 접근검토의 대상이다.
 */

import { ApiError, admin } from "@proplus/api";
import { getViewer } from "@/lib/server";

type AuditEntry = admin.AuditEntry;

/**
 * 모듈들이 실제로 쓰는 `aggregate_type` 값이다(`writeAudit` 호출부에서 수집). 입력을 돕는 제안이고,
 * 자유 입력을 막지 않는다 — 새 모듈이 새 유형을 쓰기 시작했을 때 이 목록 때문에 조회가 불가능해지면 안 된다.
 */
const AGGREGATE_TYPES: readonly string[] = [
  "appeal",
  "appointment",
  "badge",
  "consent_record",
  "evidence",
  "evidence_file",
  "lead",
  "login_token",
  "membership",
  "offer",
  "org_invite",
  "organization",
  "profile",
  "report",
  "session",
  "subscription",
  "user",
  "verification",
];

/** 서버 렌더에서 보는 사람의 시간대로 그리면 같은 기록이 사람마다 다른 시각으로 읽힌다. UTC 로 못 박는다. */
function utcStamp(iso: string): string {
  return `${iso.slice(0, 10).replaceAll("-", ".")} ${iso.slice(11, 19)} UTC`;
}

function payloadText(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return "(표시할 수 없는 값)";
  }
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; id?: string; limit?: string }>;
}) {
  const sp = await searchParams;
  const { ctx } = await getViewer();

  const type = (sp.type ?? "").trim();
  const id = (sp.id ?? "").trim();
  const limitRaw = Number(sp.limit ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 100;

  let entries: AuditEntry[] | null = null;
  let error: string | null = null;
  if (type.length >= 2) {
    try {
      entries = await admin.auditTrail(ctx, type, id || null, limit);
    } catch (e) {
      // 잘못된 uuid 는 모듈이 입력 오류로 돌려준다. UI 는 그 메시지를 보여주는 일만 한다.
      if (!(e instanceof ApiError)) throw e;
      error = e.message;
    }
  }

  return (
    <div className="flex flex-col gap-7">
      <div>
        <p className="eyebrow">P-166 · 감사로그</p>
        <h1 className="display mt-3 text-[32px] sm:text-[40px]">감사로그 조회</h1>
        <p className="lede mt-3 text-[15px]">
          기록은 추가만 되고 수정·삭제할 수 없습니다. 이 화면은 읽기 전용이며, 조회한 사실도 기록으로 남습니다.
        </p>
      </div>

      {/* JS 없이 동작하는 GET 폼. 조회 조건이 URL 에 남으므로 운영자끼리 같은 화면을 공유할 수 있다. */}
      <form method="get" action="/admin/audit" className="panel flex flex-wrap items-end gap-3 p-5">
        <div className="min-w-[200px]">
          <label className="label" htmlFor="audit-type">
            대상 유형 <span aria-hidden="true">·</span> 필수
          </label>
          <input
            id="audit-type"
            name="type"
            className="field"
            list="audit-types"
            defaultValue={type}
            minLength={2}
            maxLength={60}
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="예: evidence"
            aria-describedby="audit-type-note"
          />
          <datalist id="audit-types">
            {AGGREGATE_TYPES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
        <div className="min-w-[280px] flex-1">
          <label className="label" htmlFor="audit-id">
            대상 ID (선택)
          </label>
          <input
            id="audit-id"
            name="id"
            className="field"
            defaultValue={id}
            autoComplete="off"
            spellCheck={false}
            placeholder="한 리소스의 이력만 보려면 UUID 를 입력합니다"
          />
        </div>
        <div className="min-w-[110px]">
          <label className="label" htmlFor="audit-limit">
            최대 건수
          </label>
          <input id="audit-limit" name="limit" className="field" type="number" min={1} max={500} defaultValue={limit} />
        </div>
        <button type="submit" className="btn btn-ghost">
          조회
        </button>
        <p id="audit-type-note" className="w-full text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
          대상 유형 없이 전체를 훑는 조회는 제공하지 않습니다. 전체 흐름이 필요하면 운영 KPI 를 쓰세요.
        </p>
      </form>

      {error ? (
        <p role="alert" className="card border-[var(--caution)] p-4 text-[14px] text-[var(--caution)]">
          {error}
        </p>
      ) : null}

      {entries === null && error === null ? (
        <p className="panel p-5 text-[14px] text-[var(--fg-mute)]">
          대상 유형을 입력하면 기록이 표시됩니다.
        </p>
      ) : null}

      {entries !== null ? (
        <section aria-labelledby="audit-results" className="flex flex-col gap-3">
          <h2 id="audit-results" className="text-[19px] font-semibold">
            결과 {entries.length}건{" "}
            <span className="text-[14px] font-normal text-[var(--fg-mute)]">
              (최신순 · 최대 {limit}건 · 유형 {type}
              {id ? ` · ID ${id}` : ""})
            </span>
          </h2>

          {entries.length === 0 ? (
            <p className="panel p-5 text-[14px] text-[var(--fg-mute)]">조건에 해당하는 기록이 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {entries.map((e) => (
                <li key={e.id} className="card flex flex-col gap-2.5 p-5" data-testid="audit-entry">
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <code className="text-[14.5px] font-semibold">{e.eventType}</code>
                    <span className="text-[12.5px] text-[var(--fg-mute)]">{utcStamp(e.occurredAt)}</span>
                  </div>

                  <dl className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
                    <div className="flex gap-2">
                      <dt className="text-[var(--fg-mute)]">행위자</dt>
                      <dd>
                        {e.actorId ? <code className="text-[12.5px]">{e.actorId}</code> : "시스템"}
                        {e.actorRole ? ` · ${e.actorRole}` : ""}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-[var(--fg-mute)]">대상</dt>
                      <dd>
                        {e.aggregateType}
                        {e.aggregateId ? (
                          <>
                            {" · "}
                            <code className="text-[12.5px]">{e.aggregateId}</code>
                          </>
                        ) : null}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-[var(--fg-mute)]">접근 사유</dt>
                      <dd>{e.accessPurpose ?? "해당 없음"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-[var(--fg-mute)]">상관 ID</dt>
                      <dd>{e.correlationId ? <code className="text-[12.5px]">{e.correlationId}</code> : "—"}</dd>
                    </div>
                    {e.tenantId ? (
                      <div className="flex gap-2">
                        <dt className="text-[var(--fg-mute)]">조직</dt>
                        <dd>
                          <code className="text-[12.5px]">{e.tenantId}</code>
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  {Object.keys(e.payload).length > 0 ? (
                    <details>
                      <summary className="cursor-pointer text-[13px] font-semibold text-[var(--accent-text)]">
                        기록된 값 보기
                      </summary>
                      {/* payload_minimized — 전화·이메일·증거 내용 원문은 애초에 담기지 않는다 (N-13). */}
                      <pre className="panel mt-2 overflow-x-auto p-3 text-[12px] leading-relaxed">
                        {payloadText(e.payload)}
                      </pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <p className="text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
            기록된 값에는 전화·이메일·증거 내용 원문이 들어가지 않습니다(식별자와 최소 정보만 남깁니다).
            이 목록에는 수정·삭제 기능이 없습니다 — 감사로그는 추가만 가능합니다.
          </p>
        </section>
      ) : null}
    </div>
  );
}
