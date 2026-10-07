"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AiLabel, Avatar, PageHeader } from "@/components/Page";
import { api, fmtDate, relTime } from "@/lib/client";

const FIELDS = [
  ["fullName", "이름"],
  ["company", "회사"],
  ["jobTitle", "직책"],
  ["department", "부서"],
  ["email", "이메일"],
  ["phone", "전화"],
  ["address", "주소"],
  ["website", "웹사이트"],
] as const;

type Timeline = {
  contact: any;
  encounters: any[];
  notes: any[];
  cards: any[];
  meetings: any[];
  followups: any[];
  actions: any[];
  linkedProfile: { slug: string; name: string } | null;
};

export function PersonDetail({ id }: { id: string }) {
  const router = useRouter();
  const [t, setT] = useState<Timeline | null>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [dups, setDups] = useState<any[]>([]);
  const [merge, setMerge] = useState<{ other: any; choices: Record<string, "primary" | "secondary"> } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<Timeline>(`/contacts/${id}`);
      setT(r);
      setForm(Object.fromEntries(FIELDS.map(([k]) => [k, r.contact[k] ?? ""])));
      const d = await api<{ candidates: any[] }>("/contacts/duplicates", { body: { fullName: r.contact.fullName, company: r.contact.company, email: r.contact.email, phone: r.contact.phone, excludeId: id } });
      setDups(d.candidates);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <p className="text-[var(--color-ember)]">{error}</p>;
  if (!t) return <div className="surface h-60 animate-pulse" />;
  const c = t.contact;

  const save = async () => {
    try {
      await api(`/contacts/${id}`, { method: "PATCH", body: { ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v || null])), fullName: form.fullName, version: c.version } });
      setEdit(false);
      setFlash("저장했어요");
      load();
    } catch (e) {
      setFlash((e as Error).message);
    }
  };

  const addNote = async () => {
    if (!note.trim()) return;
    await api(`/contacts/${id}/notes`, { body: { body: note } });
    setNote("");
    load();
  };

  const doMerge = async () => {
    if (!merge) return;
    await api(`/contacts/${id}/merge`, { body: { secondaryId: merge.other.id, choices: merge.choices } });
    setMerge(null);
    setFlash("병합했어요 · 되돌리기 가능");
    load();
  };

  const undo = async () => {
    await api(`/contacts/${id}/merge/undo`, { body: {} });
    setFlash("병합을 되돌렸어요");
    load();
  };

  const completeFollowup = async (fid: string) => {
    await api(`/followups/${fid}`, { method: "PATCH", body: { status: "done" } });
    load();
  };

  const remove = async () => {
    if (!confirm(`${c.fullName}님을 인맥에서 삭제할까요?`)) return;
    await api(`/contacts/${id}`, { method: "DELETE" });
    router.push("/app/people");
  };

  const events: { at: string; icon: IconName; title: string; body?: string; tag?: string }[] = [
    ...t.encounters.map((e) => ({ at: e.occurred_at, icon: "exchange" as IconName, title: e.source === "exchange" ? "명함 교환" : e.source === "scan" ? "명함 스캔" : "만남", body: [e.place_label, e.event_name, e.note].filter(Boolean).join(" · ") })),
    ...t.notes.map((n) => ({ at: n.created_at, icon: "edit" as IconName, title: "개인 메모", body: n.body, tag: "나만 보기" })),
    ...t.meetings.map((m) => ({ at: m.started_at ?? m.created_at, icon: "calendar" as IconName, title: m.title, body: m.purpose })),
    ...t.cards.map((b) => ({ at: b.captured_at, icon: "camera" as IconName, title: "명함 원본", body: b.source === "guest_exchange" ? "상대가 촬영해 보낸 명함" : "OCR 스캔" })),
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at));

  return (
    <div>
      <PageHeader back="/app/people" eyebrow={c.source === "exchange" ? "교환으로 연결됨" : c.source === "scan" ? "스캔으로 추가" : "Contact"} title={c.fullName} />
      {flash && (
        <p className="mb-4 flex items-center justify-between rounded-2xl bg-[var(--color-signal)]/25 px-4 py-2.5 text-[14px] font-medium" role="status">
          {flash}
          {flash.startsWith("병합했어요") && <button onClick={undo} className="font-semibold underline">되돌리기</button>}
        </p>
      )}

      <section className="surface p-5 animate-rise">
        <div className="flex items-start gap-4">
          <Avatar name={c.fullName} size={56} />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] text-[var(--fg-mute)]">{[c.company, c.department, c.jobTitle].filter(Boolean).join(" · ") || "—"}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {c.email && <a href={`mailto:${c.email}`} className="btn btn-ghost !min-h-10 !px-3 text-[14px]"><Icon name="mail" size={16} />메일</a>}
              {c.phone && <a href={`tel:${c.phone}`} className="btn btn-ghost !min-h-10 !px-3 text-[14px]"><Icon name="phone" size={16} />전화</a>}
              <a href={`/api/v1/contacts/${id}/vcard`} className="btn btn-ghost !min-h-10 !px-3 text-[14px]"><Icon name="download" size={16} />vCard</a>
              {t.linkedProfile && <Link href={`/p/${t.linkedProfile.slug}`} className="btn btn-signal !min-h-10 !px-3 text-[14px]"><Icon name="eye" size={16} />Living Card</Link>}
            </div>
          </div>
          <button onClick={() => setEdit(!edit)} className="grid size-10 place-items-center rounded-full border border-[var(--line)]" aria-label="정보 편집">
            <Icon name="edit" size={17} />
          </button>
        </div>

        {edit ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {FIELDS.map(([k, label]) => (
              <label key={k}>
                <span className="label">{label}</span>
                <input className="field" value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              </label>
            ))}
            <div className="flex gap-2 sm:col-span-2">
              <button onClick={save} className="btn btn-signal">저장</button>
              <button onClick={() => setEdit(false)} className="btn btn-ghost">취소</button>
              <button onClick={remove} className="btn ml-auto text-[var(--color-ember)]">삭제</button>
            </div>
          </div>
        ) : (
          <dl className="mt-5 grid gap-x-6 gap-y-3 text-[14.5px] sm:grid-cols-2">
            {FIELDS.slice(4).map(([k, label]) =>
              c[k] ? (
                <div key={k}>
                  <dt className="text-[11.5px] uppercase tracking-[0.12em] text-[var(--fg-mute)]">
                    {label}
                    {c.provenance?.[k] && <span className="ml-1.5 normal-case tracking-normal">· {c.provenance[k].source === "ocr" ? `OCR ${Math.round((c.provenance[k].confidence ?? 0) * 100)}%` : c.provenance[k].source === "user" ? "직접 입력" : c.provenance[k].source}</span>}
                  </dt>
                  <dd className="mt-0.5 break-words font-medium">{c[k]}</dd>
                </div>
              ) : null,
            )}
          </dl>
        )}
      </section>

      {dups.length > 0 && !merge && (
        <section className="mt-4 rounded-[22px] border border-[var(--color-ember)]/40 p-4">
          <p className="flex items-center gap-2 text-[14.5px] font-semibold"><Icon name="merge" size={18} />중복일 수 있는 연락처</p>
          {dups.map((d) => (
            <div key={d.contact.id} className="mt-3 flex items-center gap-3">
              <span className="min-w-0 flex-1 text-[14px]">
                <b>{d.contact.fullName}</b> · {d.contact.company ?? "—"} <span className="text-[var(--fg-mute)]">({d.reasons.join(", ")} · {Math.round(d.score * 100)}%)</span>
              </span>
              <button className="btn btn-ghost !min-h-10" onClick={() => setMerge({ other: d.contact, choices: {} })}>비교·병합</button>
            </div>
          ))}
        </section>
      )}

      {merge && (
        <section className="surface mt-4 p-4" aria-label="병합 검토">
          <h3 className="text-[16px] font-semibold">필드별로 남길 값을 고르세요</h3>
          <div className="mt-3 space-y-2">
            {FIELDS.map(([k, label]) => {
              const a = c[k] ?? "";
              const b = merge.other[k] ?? "";
              if (!a && !b) return null;
              const choice = merge.choices[k] ?? (a ? "primary" : "secondary");
              return (
                <div key={k} className="grid grid-cols-[70px_1fr_1fr] items-center gap-2 text-[14px]">
                  <span className="text-[var(--fg-mute)]">{label}</span>
                  {(["primary", "secondary"] as const).map((side) => (
                    <button key={side} disabled={a === b} onClick={() => setMerge({ ...merge, choices: { ...merge.choices, [k]: side } })} className={`truncate rounded-xl border px-3 py-2 text-left ${choice === side ? "border-[var(--fg)] bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] font-semibold" : "border-[var(--line)]"}`}>
                      {(side === "primary" ? a : b) || "—"}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={doMerge} className="btn btn-signal">병합</button>
            <button onClick={() => setMerge(null)} className="btn btn-ghost">취소</button>
          </div>
        </section>
      )}

      {t.followups.filter((f) => f.status === "open").length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-[17px] font-semibold">후속 할 일</h2>
          <ul className="space-y-2">
            {t.followups.filter((f) => f.status === "open").map((f) => (
              <li key={f.id} className="surface p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{f.title} {f.source === "ai_suggested" && <AiLabel>AI 제안</AiLabel>}</p>
                    {f.body_draft && <p className="mt-1.5 whitespace-pre-wrap text-[14px] text-[var(--fg-mute)]">{f.body_draft}</p>}
                    <p className="mt-1 text-[12.5px] text-[var(--fg-mute)]">{f.due_at ? `기한 ${fmtDate(f.due_at)}` : ""} · 자동 발송되지 않습니다</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2">
                    {c.email && f.body_draft && <a className="btn btn-ghost !min-h-9 !px-3 text-[13px]" href={`mailto:${c.email}?subject=${encodeURIComponent(f.title)}&body=${encodeURIComponent(f.body_draft)}`}>메일 쓰기</a>}
                    <button onClick={() => completeFollowup(f.id)} className="btn btn-signal !min-h-9 !px-3 text-[13px]">완료</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-[17px] font-semibold">메모 <span className="text-[13px] font-normal text-[var(--fg-mute)]">· 상대에게 절대 공개되지 않아요</span></h2>
        <div className="flex gap-2">
          <input className="field" placeholder="무슨 이야기를 나눴나요?" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNote()} />
          <button onClick={addNote} className="btn btn-ink shrink-0" aria-label="메모 추가"><Icon name="plus" size={18} /></button>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-4 text-[17px] font-semibold">관계 타임라인</h2>
        <ol className="relative space-y-5 border-l border-[var(--line-strong)] pl-6">
          {events.map((e, i) => (
            <li key={i} className="relative">
              <span className="absolute -left-[37px] grid size-7 place-items-center rounded-full border border-[var(--line-strong)] bg-[var(--bg)]">
                <Icon name={e.icon} size={14} />
              </span>
              <p className="text-[12px] text-[var(--fg-mute)]">{fmtDate(e.at, { year: "numeric", month: "short", day: "numeric" })} · {relTime(e.at)}</p>
              <p className="font-semibold">{e.title} {e.tag && <span className="chip ml-1 !py-0.5 text-[11px]"><Icon name="lock" size={11} />{e.tag}</span>}</p>
              {e.body && <p className="mt-0.5 whitespace-pre-wrap text-[14.5px] text-[var(--fg-mute)]">{e.body}</p>}
            </li>
          ))}
        </ol>
      </section>

      <div className="mt-8 flex flex-wrap gap-2">
        <Link href={`/app/meetings/new?contact=${id}`} className="btn btn-ghost"><Icon name="calendar" size={17} />미팅 카드 만들기</Link>
        <Link href={`/app/intros?a=${id}`} className="btn btn-ghost"><Icon name="room" size={17} />소개하기</Link>
      </div>
    </div>
  );
}
