"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel, Empty } from "@/components/Page";
import { api } from "@/lib/client";

const STATE: Record<string, string> = { INTRO_PROPOSED: "양측 의사 확인 중", PARTY_A_ACCEPTED: "한쪽 동의", PARTY_B_ACCEPTED: "양측 동의", ROOM_CREATED: "Room 개설", MEETING_BOOKED: "미팅 예약", ACTIVE: "진행 중", WON: "성사", ARCHIVED: "보관", DECLINED: "거절됨" };
const OUTCOME: Record<string, string> = { none: "성과 기록 안 함", meeting: "미팅 성사", opportunity: "사업 기회", won: "계약/성사", lost: "무산" };

type Msg = { subject: string; body: string };
type Draft = { toA: Msg; toB: Msg; joint: Msg; provenance: string };

function DraftEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<{ draft: Draft | null }>(`/introductions/${id}/draft`).then((r) => (r.draft ? setD(r.draft) : api<{ draft: Draft }>(`/introductions/${id}/draft`, { body: {} }).then((x) => setD(x.draft))));
  }, [id]);
  if (!d) return <div className="mt-3 h-24 animate-pulse rounded-2xl border border-[var(--line)]" />;
  const part = (k: "toA" | "toB" | "joint", label: string) => (
    <fieldset key={k} className="space-y-1.5">
      <legend className="label">{label}</legend>
      <input className="field" value={d[k].subject} onChange={(e) => setD({ ...d, [k]: { ...d[k], subject: e.target.value } })} aria-label={`${label} 제목`} />
      <textarea className="field min-h-28" value={d[k].body} onChange={(e) => setD({ ...d, [k]: { ...d[k], body: e.target.value } })} aria-label={`${label} 본문`} />
      <a className="text-[12.5px] underline" href={`mailto:?subject=${encodeURIComponent(d[k].subject)}&body=${encodeURIComponent(d[k].body)}`}>내 메일 앱에서 열기</a>
    </fieldset>
  );
  return (
    <div className="mt-3 space-y-3 rounded-2xl border border-[var(--line)] p-4">
      <p className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--fg-mute)]">
        {d.provenance !== "user" && <AiLabel>{d.provenance === "ai_inferred" ? "AI 초안" : "템플릿 초안"}</AiLabel>}
        LINKOS는 메일을 보내지 않습니다. 확인·수정 후 직접 보내세요. 양측 동의 전에는 연락처를 넣지 마세요.
      </p>
      {part("toA", "① 첫 번째 분께 의사 확인")}
      {part("toB", "② 두 번째 분께 의사 확인")}
      {part("joint", "③ 양측 동의 후 소개 메일")}
      <div className="flex gap-2">
        <button className="btn btn-ink !min-h-10" onClick={async () => { await api(`/introductions/${id}/draft`, { method: "PUT", body: { toA: d.toA, toB: d.toB, joint: d.joint } }); setSaved(true); }}>{saved ? "저장됨" : "수정본 저장"}</button>
        <button className="btn btn-ghost !min-h-10" onClick={async () => { setD((await api<{ draft: Draft }>(`/introductions/${id}/draft`, { body: {} })).draft); setSaved(false); }}>다시 생성</button>
        <button className="btn btn-ghost !min-h-10" onClick={onClose}>닫기</button>
      </div>
    </div>
  );
}

// 소개와 Connection Room (백서 19) + F-152 AI 후보 · F-155 3자 메시지 · F-159 성과
export function IntrosHub({ preA }: { preA: string | null }) {
  const [contacts, setContacts] = useState<any[]>([]);
  const [list, setList] = useState<any[] | null>(null);
  const [cands, setCands] = useState<any[] | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [f, setF] = useState({ a: preA ?? "", b: "", reason: "" });
  const load = () => {
    api<{ introductions: any[] }>("/introductions").then((r) => setList(r.introductions));
    api("/introductions/stats").then(setStats).catch(() => undefined);
  };
  useEffect(() => {
    api<{ contacts: any[] }>("/contacts?limit=200").then((r) => setContacts(r.contacts));
    api<{ results: any[] }>("/ai/intro-candidates").then((r) => setCands(r.results)).catch(() => setCands([]));
    load();
  }, []);
  const consent = async (id: string, party: "a" | "b", accepted: boolean) => {
    await api(`/introductions/${id}/consent`, { body: { party, accepted } });
    load();
  };
  const fromCandidate = async (c: any) => {
    await api("/introductions/suggested", { body: { partyAContactId: c.partyA.id, partyBContactId: c.partyB.id, reason: c.reasons[0] } });
    setCands((cands ?? []).filter((x) => x !== c));
    load();
  };
  return (
    <div className="space-y-8">
      {stats?.all?.total > 0 && (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="소개 성과">
          {[
            ["소개", stats.all.total],
            ["양측 동의", stats.all.acceptRate == null ? "—" : `${stats.all.acceptRate}%`],
            ["미팅", stats.all.meetings],
            ["성사", stats.all.won],
          ].map(([k, v]) => (
            <div key={k as string} className="surface p-4">
              <p className="eyebrow">{k}</p>
              <p className="num display mt-1 text-[30px]">{v as string}</p>
            </div>
          ))}
        </section>
      )}

      {cands && cands.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 px-1 font-semibold">소개하면 좋을 두 사람 <AiLabel /></h2>
          {cands.slice(0, 5).map((c, i) => (
            <article key={i} className="surface p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">{c.partyA.name} <Icon name="link" size={14} className="mx-1 inline" /> {c.partyB.name}</p>
                <span className="chip">적합도 {Math.round(c.score * 100)}</span>
              </div>
              <ul className="mt-1 list-disc pl-5 text-[13.5px] text-[var(--fg-mute)]">
                {c.reasons.map((r: string, j: number) => <li key={j}>{r}</li>)}
              </ul>
              <p className="mt-1 text-[12px] text-[var(--fg-mute)]">경로: {c.path.join(" → ")}</p>
              <button className="btn btn-signal mt-3 !min-h-10 text-[14px]" onClick={() => fromCandidate(c)}>이 소개 제안하기</button>
            </article>
          ))}
        </section>
      )}

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
            <p className="mt-1 text-[14px] text-[var(--fg-mute)]">{i.reason}{i.source === "ai_suggested" && " · AI 후보에서 시작"}</p>
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
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {i.roomId && <Link href={`/app/rooms/${i.roomId}`} className="btn btn-ink !min-h-10 text-[14px]"><Icon name="room" size={16} />Connection Room</Link>}
              {i.state !== "DECLINED" && <button className="btn btn-ghost !min-h-10 text-[14px]" onClick={() => setDraftFor(draftFor === i.id ? null : i.id)}><Icon name="mail" size={16} />소개 메시지 {i.hasDraft ? "보기" : "초안"}</button>}
              {i.state !== "DECLINED" && (
                <select className="field !w-auto !py-1.5 text-[13px]" value={i.outcome ?? "none"} aria-label="소개 성과" onChange={async (e) => { await api(`/introductions/${i.id}/outcome`, { body: { outcome: e.target.value } }); load(); }}>
                  {Object.entries(OUTCOME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              )}
            </div>
            {draftFor === i.id && <DraftEditor id={i.id} onClose={() => { setDraftFor(null); load(); }} />}
          </article>
        ))}
      </section>
    </div>
  );
}
