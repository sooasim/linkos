"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Empty } from "@/components/Page";
import { api } from "@/lib/client";

const STATE: Record<string, string> = { INTRO_PROPOSED: "양측 의사 확인 중", PARTY_A_ACCEPTED: "한쪽 동의", PARTY_B_ACCEPTED: "양측 동의", ROOM_CREATED: "Room 개설", MEETING_BOOKED: "미팅 예약", ACTIVE: "진행 중", WON: "성사", ARCHIVED: "보관", DECLINED: "거절됨" };

export function IntrosHub({ preA }: { preA: string | null }) {
  const [contacts, setContacts] = useState<any[]>([]);
  const [list, setList] = useState<any[] | null>(null);
  const [f, setF] = useState({ a: preA ?? "", b: "", reason: "" });
  const load = () => api<{ introductions: any[] }>("/introductions").then((r) => setList(r.introductions));
  useEffect(() => {
    api<{ contacts: any[] }>("/contacts?limit=200").then((r) => setContacts(r.contacts));
    load();
  }, []);
  const consent = async (id: string, party: "a" | "b", accepted: boolean) => {
    await api(`/introductions/${id}/consent`, { body: { party, accepted } });
    load();
  };
  return (
    <div className="space-y-8">
      <form className="surface space-y-3 p-5" onSubmit={async (e) => { e.preventDefault(); await api("/introductions", { body: { partyAContactId: f.a, partyBContactId: f.b, reason: f.reason } }); setF({ a: "", b: "", reason: "" }); load(); }}>
        <h2 className="font-semibold">두 사람 소개하기</h2>
        <p className="text-[13.5px] text-[var(--fg-mute)]">양쪽 모두 동의하기 전에는 서로의 연락처가 공개되지 않습니다.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["a", "b"] as const).map((k) => (
            <select key={k} className="field" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required aria-label={k === "a" ? "첫 번째 사람" : "두 번째 사람"}>
              <option value="">{k === "a" ? "첫 번째 사람" : "두 번째 사람"}</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.fullName}{c.company ? ` · ${c.company}` : ""}</option>)}
            </select>
          ))}
        </div>
        <textarea className="field min-h-20" placeholder="소개하는 이유 (양측에게 보여집니다)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required />
        <button className="btn btn-signal">소개 제안</button>
      </form>
      <section className="space-y-2">
        {!list ? <div className="surface h-24 animate-pulse" /> : list.length === 0 ? <Empty title="진행 중인 소개가 없어요" /> : list.map((i) => (
          <article key={i.id} className="surface p-4">
            <div className="flex items-center justify-between">
              <p className="font-semibold">{i.partyA.name} <Icon name="link" size={14} className="mx-1 inline" /> {i.partyB.name}</p>
              <span className="chip">{STATE[i.state] ?? i.state}</span>
            </div>
            <p className="mt-1 text-[14px] text-[var(--fg-mute)]">{i.reason}</p>
            {["INTRO_PROPOSED", "PARTY_A_ACCEPTED"].includes(i.state) && (
              <div className="mt-3 grid gap-2 text-[13.5px] sm:grid-cols-2">
                {(["a", "b"] as const).map((p) => {
                  const party = p === "a" ? i.partyA : i.partyB;
                  return (
                    <div key={p} className="flex items-center justify-between rounded-2xl border border-[var(--line)] px-3 py-2">
                      <span>{party.name}: {party.status === "pending" ? "응답 대기" : party.status === "accepted" ? "동의" : "거절"}</span>
                      {party.status === "pending" && (
                        <span className="flex gap-1">
                          <button className="btn btn-ghost !min-h-8 !px-2 text-[12px]" onClick={() => consent(i.id, p, false)}>거절</button>
                          <button className="btn btn-signal !min-h-8 !px-2 text-[12px]" onClick={() => consent(i.id, p, true)}>동의함</button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {i.roomId && <Link href={`/app/rooms/${i.roomId}`} className="btn btn-ink mt-3 !min-h-10 text-[14px]"><Icon name="room" size={16} />Connection Room</Link>}
          </article>
        ))}
      </section>
    </div>
  );
}
