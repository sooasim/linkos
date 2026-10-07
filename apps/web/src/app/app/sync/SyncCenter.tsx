"use client";
// F-179 재동기화: 대기·실패·충돌(409 version_conflict) 항목. 충돌은 필드별로 비교해 "내 변경 적용" 또는 "서버 버전 유지".
import { type OutboxItem, conflictFields } from "@linkos/domain";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Empty } from "@/components/Page";
import { relTime } from "@/lib/client";

const KIND: Record<OutboxItem["kind"], string> = {
  scan: "명함 스캔 저장",
  contact: "연락처 추가",
  contact_update: "연락처 수정",
  note: "메모",
  encounter: "만남 기록",
  event_lead: "행사 리드",
  profile_update: "내 명함 수정",
};

const FIELD: Record<string, string> = { fullName: "이름", company: "회사", jobTitle: "직책", department: "부서", email: "이메일", phone: "전화", address: "주소", website: "웹사이트", name: "이름", headline: "한 줄 소개" };

const label = (i: OutboxItem) => {
  const b = (i.body ?? {}) as Record<string, any>;
  return b.fullName ?? b.contact?.fullName ?? b.name ?? (typeof b.body === "string" ? b.body.slice(0, 40) : "");
};

export function SyncCenter() {
  const [items, setItems] = useState<OutboxItem[] | null>(null);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let off = () => undefined as void;
    const mod = import("@/lib/offline");
    const load = () => mod.then(async (m) => setItems(await m.listOutbox()));
    void mod.then((m) => {
      off = m.onOfflineChange(() => void load());
    });
    void load();
    setOnline(navigator.onLine);
    const net = () => setOnline(navigator.onLine);
    window.addEventListener("online", net);
    window.addEventListener("offline", net);
    return () => {
      off();
      window.removeEventListener("online", net);
      window.removeEventListener("offline", net);
    };
  }, []);

  const act = (fn: (m: typeof import("@/lib/offline")) => Promise<unknown>) => import("@/lib/offline").then(fn);

  if (!items) return <div className="surface h-32 animate-pulse" />;
  if (!items.length) return <Empty title="모두 동기화됐어요" body="오프라인에서 저장한 항목이 생기면 여기서 전송 상태를 볼 수 있어요." />;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-[14px]">
        <span>{online ? "온라인" : "오프라인 — 연결되면 자동 전송"}</span>
        <button className="btn btn-ink !min-h-10" disabled={!online} onClick={() => act((m) => m.flushOutbox())}>
          지금 동기화
        </button>
      </div>
      <ul className="space-y-3">
        {items.map((i) => {
          const diff = i.status === "conflict" ? conflictFields((i.body ?? {}) as Record<string, unknown>, i.conflict?.current as Record<string, unknown> | null) : [];
          return (
            <li key={i.id} className="surface space-y-3 p-4" data-testid={`outbox-${i.status}`}>
              <div className="flex items-start gap-3">
                <Icon name={i.status === "conflict" ? "merge" : i.status === "failed" ? "x" : "bolt"} size={18} />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{KIND[i.kind]} {label(i) && <span className="font-normal text-[var(--fg-mute)]">· {label(i)}</span>}</p>
                  <p className="text-[13px] text-[var(--fg-mute)]">
                    {relTime(new Date(i.createdAt))} 저장 · {i.status === "pending" ? `전송 대기${i.attempts ? ` (재시도 ${i.attempts}회)` : ""}` : i.status === "conflict" ? "다른 곳에서 먼저 수정됨" : `실패: ${i.lastError?.message || i.lastError?.code}`}
                  </p>
                </div>
              </div>
              {i.status === "conflict" && (
                <div className="space-y-2">
                  {diff.length > 0 ? (
                    <table className="w-full text-[13.5px]">
                      <thead>
                        <tr className="text-left text-[var(--fg-mute)]"><th className="font-medium">항목</th><th className="font-medium">내 변경</th><th className="font-medium">서버</th></tr>
                      </thead>
                      <tbody>
                        {diff.map((d) => (
                          <tr key={d.field} className="border-t border-[var(--line)]">
                            <td className="py-1.5 pr-2">{FIELD[d.field] ?? d.field}</td>
                            <td className="py-1.5 pr-2 font-semibold">{String(d.mine ?? "—")}</td>
                            <td className="py-1.5">{String(d.server ?? "—")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-[13.5px] text-[var(--fg-mute)]">서버 버전 {i.conflict?.serverVersion ?? "?"} 이 더 최신이에요.</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button className="btn btn-signal" onClick={() => act((m) => m.resolveOutboxConflict(i.id, "mine"))}>내 변경 적용</button>
                    <button className="btn btn-ghost" onClick={() => act((m) => m.resolveOutboxConflict(i.id, "theirs"))}>서버 버전 유지</button>
                    {i.kind === "contact_update" && <Link className="btn btn-ghost" href={i.path.replace("/contacts/", "/app/people/")}>연락처 열기</Link>}
                  </div>
                </div>
              )}
              {i.status === "failed" && (
                <div className="flex gap-2">
                  <button className="btn btn-ghost" onClick={() => act((m) => m.retryOutbox(i.id))}>다시 시도</button>
                  <button className="btn btn-ghost" onClick={() => act((m) => m.discardOutbox(i.id))}>삭제</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
