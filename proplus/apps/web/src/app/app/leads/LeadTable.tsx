"use client";

/**
 * P-103 inbox 표 · P-104 단계 변경 · P-109 내보내기.
 *
 * ## 단계 변경은 **한 필드만** 보낸다
 *
 * `PATCH /me/leads/{id}` 는 `stage` 와 `assignedTo` 를 **동시에 받지 않는다**(라우트 주석:
 * 둘을 한 요청으로 받으면 "단계는 바뀌었는데 배정은 실패"한 상태가 에러 뒤에 남는다).
 * 그래서 이 화면의 선택 상자는 `stage` 하나만 보낸다. 담당자 배정은 별개의 요청이고 이 표에서 하지 않는다.
 *
 * 선택 가능한 단계는 도메인의 `canChangeStage()` 로 좁힌다 — 서버가 쓰는 같은 순수 함수다.
 * 화면이 규칙을 복사하는 것이 아니라 같은 함수를 부르는 것이고, 거절 판정은 여전히 서버가 한다(409).
 *
 * ## 마케팅 발송 버튼이 없는 이유 (N-11)
 *
 * 상담처리 동의와 마케팅 동의는 분리 기록되고(`consent_records.purpose`), 마케팅 동의가 없는 상대에게
 * 보내는 것은 금지다. 그런데 이 목록·상세 응답에는 **동의 상태가 포함되지 않는다** —
 * 동의 여부를 모르는 화면에 발송 버튼을 두면 그 버튼은 언젠가 동의 없이 눌린다. 그래서 만들지 않았다.
 */

import type { lead as leadModule } from "@proplus/api";
import { type LeadStage, LEAD_STAGES, LEAD_STAGE_LABEL_KO, canChangeStage } from "@proplus/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LeadStageChip } from "@/components/StatusChip";
import { ClientError, api, fmtDateTime, uid } from "@/lib/client";

interface Notice {
  tone: "ok" | "error";
  message: string;
  code?: string;
}

const CONTACT_KIND_KO: Record<string, string> = { email: "이메일", phone: "전화" };

export function LeadTable({ leads, stage }: { leads: readonly leadModule.LeadListItem[]; stage: LeadStage | null }) {
  const router = useRouter();
  /** 변경 직후의 낙관적 표시. 서버 재조회(`router.refresh()`)가 끝나면 같은 값이 내려온다. */
  const [overrides, setOverrides] = useState<Record<string, LeadStage>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function changeStage(id: string, next: LeadStage) {
    if (busyId) return;
    setBusyId(id);
    setNotice(null);
    try {
      await api(`/me/leads/${id}`, { method: "PATCH", body: { stage: next } });
      setOverrides((prev) => ({ ...prev, [id]: next }));
      setNotice({ tone: "ok", message: `단계를 “${LEAD_STAGE_LABEL_KO[next]}”로 바꿨습니다.` });
      router.refresh();
    } catch (err) {
      const e = err instanceof ClientError ? err : null;
      setNotice({ tone: "error", message: e?.message ?? "단계를 바꾸지 못했습니다.", code: e?.code });
    } finally {
      setBusyId(null);
    }
  }

  async function exportCsv() {
    if (busyId) return;
    setBusyId("export");
    setNotice(null);
    try {
      /**
       * `api()` 를 쓰지 않는 유일한 자리다 — 그 함수는 JSON 응답만 해석하고, 여기 오는 것은 CSV 바이트다.
       * POST 인 것도 설계다(라우트 주석): 고객 PII 묶음의 주소가 액세스 로그·브라우저 이력에 남지 않게 한다.
       * 원문 연락처(`includeContact`)는 접근 사유가 필수여서 이 화면에서 보내지 않는다 — 마스킹본만 내보낸다.
       */
      const res = await fetch("/api/v1/me/leads/export", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": uid() },
        body: JSON.stringify({ ...(stage ? { stage } : {}), limit: 1000 }),
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
        setNotice({
          tone: "error",
          message: data?.message ?? "내보내지 못했습니다.",
          code: data?.code ?? String(res.status),
        });
        return;
      }

      const count = res.headers.get("x-export-count") ?? "";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFrom(res.headers.get("content-disposition"));
      a.click();
      URL.revokeObjectURL(url);
      setNotice({
        tone: "ok",
        message: `${count ? `${count}건을 ` : ""}내보냈습니다. 이 내보내기는 감사로그에 남습니다.`,
      });
    } catch {
      setNotice({ tone: "error", message: "네트워크에 연결할 수 없습니다.", code: "network_error" });
    } finally {
      setBusyId(null);
    }
  }

  if (leads.length === 0) {
    return (
      <div className="panel mt-8 p-6">
        <p className="text-[15px] font-semibold">
          {stage ? `“${LEAD_STAGE_LABEL_KO[stage]}” 단계의 상담이 없습니다.` : "아직 접수된 상담이 없습니다."}
        </p>
        <p className="mt-2 max-w-[56ch] text-[14px] leading-relaxed text-[var(--fg-mute)]">
          공개 프로필의 상담 폼으로 요청이 들어오면 여기에 쌓이고, 새 요청은 알림으로도 알려 드립니다.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-[var(--fg-mute)]">
          {leads.length}건 · 연락처는 가려진 상태입니다. 원문은 상세 화면에서만 볼 수 있고, 그 조회는 기록으로 남습니다.
        </p>
        <button type="button" className="btn btn-ghost !min-h-10 text-[14px]" onClick={exportCsv} disabled={busyId !== null}>
          {busyId === "export" ? "내보내는 중…" : "CSV 내보내기"}
        </button>
      </div>

      {notice ? (
        <p
          className={`mt-4 text-[13.5px] font-semibold ${
            notice.tone === "ok" ? "text-[var(--verified)]" : "text-[var(--caution)]"
          }`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
          {notice.code ? <span className="block font-normal text-[var(--fg-mute)]">오류 코드: {notice.code}</span> : null}
        </p>
      ) : null}

      <div className="card mt-5 overflow-x-auto">
        <table className="w-full border-collapse text-left text-[14px]">
          <caption className="sr-only">접수된 상담 요청 목록. 각 행에서 진행 단계를 바꿀 수 있습니다.</caption>
          <thead>
            <tr className="border-b border-[var(--line)] text-[12.5px] text-[var(--fg-mute)]">
              <th scope="col" className="px-4 py-3 font-semibold">
                접수
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                성함 · 연락처(가림)
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                문의 목적
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                단계
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                담당
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                상세
              </th>
            </tr>
          </thead>
          <tbody>
            {leads.map((item) => {
              const current = overrides[item.id] ?? item.stage;
              return (
                <tr key={item.id} className="border-b border-[var(--line)] last:border-0 align-top">
                  {/* 접수 시각은 보는 사람의 시간대로 그린다(운영 화면). 서버 렌더와 시간대가 달라도 내용이 틀리지 않게 경고를 끈다. */}
                  <td className="px-4 py-4 text-[13px] text-[var(--fg-mute)]" suppressHydrationWarning>
                    {fmtDateTime(item.createdAt)}
                  </td>
                  <td className="px-4 py-4">
                    <span className="font-semibold">{item.contactName}</span>
                    <span className="block text-[13px] text-[var(--fg-mute)]">
                      {CONTACT_KIND_KO[item.contactKind] ?? item.contactKind} · {item.contactMasked}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-[13.5px]">{item.purpose ?? "—"}</td>
                  <td className="px-4 py-4">
                    <LeadStageChip stage={current} />
                    <label className="mt-2 block">
                      <span className="sr-only">{item.contactName} 상담의 진행 단계 바꾸기</span>
                      <select
                        className="field !min-h-10 text-[13px]"
                        value=""
                        disabled={busyId !== null}
                        onChange={(e) => {
                          const next = e.target.value;
                          if ((LEAD_STAGES as readonly string[]).includes(next)) changeStage(item.id, next as LeadStage);
                        }}
                      >
                        <option value="">단계 바꾸기…</option>
                        {LEAD_STAGES.filter((s) => canChangeStage(current, s)).map((s) => (
                          <option key={s} value={s}>
                            {LEAD_STAGE_LABEL_KO[s]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </td>
                  <td className="px-4 py-4 text-[13px] text-[var(--fg-mute)]">
                    {item.assignedTo ? "배정됨" : "미배정"}
                    {item.firstResponseAt ? (
                      <span className="block" suppressHydrationWarning>
                        첫 응답 {fmtDateTime(item.firstResponseAt)}
                      </span>
                    ) : (
                      <span className="block">첫 응답 전</span>
                    )}
                  </td>
                  <td className="px-4 py-4">
                    {/*
                      prefetch 를 끈다: 상세 조회는 연락처를 복호화하고 **감사로그를 남긴다**(P-165).
                      마우스가 지나갔다는 이유로 "연락처를 열었다"는 기록이 생기면 안 된다.
                    */}
                    <Link href={`/app/leads/${item.id}`} prefetch={false} className="text-[13.5px] text-[var(--accent-text)] underline">
                      열기
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 서버가 정한 파일명을 쓴다. 없을 때만 기본값을 만든다 — 파일명을 두 곳에서 정의하면 달라진다. */
function filenameFrom(disposition: string | null): string {
  const m = /filename="([^"]+)"/.exec(disposition ?? "");
  return m?.[1] ?? "proplus-leads.csv";
}
