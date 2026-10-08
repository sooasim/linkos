"use client";
// UX-011 People — search/tag filter (F-070), sort, error+retry, manual entry (F-065 Contact 레코드, 중복 확인 F-072) next to scan
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Avatar, Empty } from "@/components/Page";
import { OFFLINE_MESSAGE, api, isQueuedOffline, relTime } from "@/lib/client";

interface C {
  id: string;
  fullName: string;
  company: string | null;
  jobTitle: string | null;
  source: string;
  tags: string[];
  lastContactAt: string | null;
  nextFollowupAt: string | null;
}

type Sort = "recent" | "name" | "company";
const SORTS: [Sort, string][] = [
  ["recent", "최근 만남"],
  ["name", "이름"],
  ["company", "회사"],
];
const SORT_KEY = "linkos.people.sort";
const ko = new Intl.Collator("ko-KR");

const MANUAL_FIELDS = [
  ["fullName", "이름", "text", true],
  ["company", "회사", "text", false],
  ["jobTitle", "직책", "text", false],
  ["email", "이메일", "email", false],
  ["phone", "전화", "tel", false],
] as const;
type Manual = Record<(typeof MANUAL_FIELDS)[number][0], string>;
const EMPTY_MANUAL: Manual = { fullName: "", company: "", jobTitle: "", email: "", phone: "" };

export function PeopleList() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("recent");
  const [items, setItems] = useState<C[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const [adding, setAdding] = useState(false);
  const [manual, setManual] = useState<Manual>(EMPTY_MANUAL);
  const [dups, setDups] = useState<{ contact: C; reasons: string[] }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [addMsg, setAddMsg] = useState<string | null>(null);

  useEffect(() => {
    try {
      const s = localStorage.getItem(SORT_KEY);
      if (s === "recent" || s === "name" || s === "company") setSort(s);
    } catch {
      /* storage unavailable — default sort */
    }
  }, []);
  const changeSort = (s: Sort) => {
    setSort(s);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    const t = setTimeout(() => {
      const sp = new URLSearchParams();
      if (q) sp.set("q", q);
      if (tag) sp.set("tag", tag);
      api<{ contacts: C[] }>(`/contacts?${sp}`)
        .then((r) => {
          setItems(r.contacts);
          setError(null);
        })
        .catch((e) => {
          setError((e as Error).message || "인맥을 불러오지 못했어요.");
        });
    }, 180);
    return () => clearTimeout(t);
  }, [q, tag, reload]);

  // tag chips come from the whole book, not the filtered result — otherwise picking a tag hides all the others
  useEffect(() => {
    api<{ contacts: C[] }>("/contacts?limit=200")
      .then((r) => {
        const count = new Map<string, number>();
        for (const c of r.contacts) for (const tg of c.tags) count.set(tg, (count.get(tg) ?? 0) + 1);
        setAllTags([...count.entries()].sort((a, b) => b[1] - a[1] || ko.compare(a[0], b[0])).map(([tg]) => tg).slice(0, 20));
      })
      .catch(() => undefined);
  }, [reload]);

  const retry = () => {
    setError(null);
    setItems(null);
    setReload((n) => n + 1);
  };

  const sorted = useMemo(() => {
    const list = [...(items ?? [])];
    if (sort === "name") list.sort((a, b) => ko.compare(a.fullName, b.fullName));
    else if (sort === "company") list.sort((a, b) => ko.compare(a.company ?? "￿", b.company ?? "￿") || ko.compare(a.fullName, b.fullName));
    else list.sort((a, b) => +new Date(b.lastContactAt ?? 0) - +new Date(a.lastContactAt ?? 0));
    return list;
  }, [items, sort]);

  const groups = useMemo(() => {
    const g = new Map<string, C[]>();
    for (const c of sorted) {
      const k = c.company ?? "회사 미입력";
      g.set(k, [...(g.get(k) ?? []), c]);
    }
    return g;
  }, [sorted]);

  const submitManual = async (force = false) => {
    const fullName = manual.fullName.trim();
    if (!fullName) return;
    setSaving(true);
    setAddMsg(null);
    try {
      if (!force) {
        const d = await api<{ candidates: { contact: C; reasons: string[] }[] }>("/contacts/duplicates", {
          body: { fullName, company: manual.company || null, email: manual.email || null, phone: manual.phone || null },
          offline: false,
        }).catch(() => ({ candidates: [] }));
        if (d.candidates.length) {
          setDups(d.candidates);
          return;
        }
      }
      const body: Record<string, unknown> = { source: "manual", fullName, provenance: {} as Record<string, { source: string }> };
      for (const [k] of MANUAL_FIELDS) {
        const v = manual[k].trim();
        if (!v) continue;
        body[k] = v;
        (body.provenance as Record<string, { source: string }>)[k] = { source: "user" };
      }
      const r = await api<{ contactId: string }>("/contacts", { body });
      setManual(EMPTY_MANUAL);
      setDups(null);
      setAdding(false);
      router.push(`/app/people/${r.contactId}`);
    } catch (e) {
      if (isQueuedOffline(e)) {
        setManual(EMPTY_MANUAL);
        setDups(null);
        setAdding(false);
        setAddMsg(OFFLINE_MESSAGE);
      } else setAddMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const row = (c: C) => (
    <li key={c.id}>
      <Link href={`/app/people/${c.id}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-[color-mix(in_srgb,var(--fg)_4%,transparent)]">
        <Avatar name={c.fullName} size={40} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15.5px] font-semibold">{c.fullName}</span>
          <span className="block truncate text-[13px] text-[var(--fg-mute)]">{(sort === "company" ? c.jobTitle : [c.company, c.jobTitle].filter(Boolean).join(" · ")) || "—"}</span>
        </span>
        <span className="text-right text-[12px] text-[var(--fg-mute)]">
          {relTime(c.lastContactAt)}
          {c.nextFollowupAt && <span className="block text-[var(--color-ember)]">후속 {relTime(c.nextFollowupAt)}</span>}
        </span>
      </Link>
    </li>
  );

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Icon name="search" size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--fg-mute)]" />
          <input className="field !pl-11" placeholder="이름, 회사, 직책, 이메일 검색" value={q} onChange={(e) => setQ(e.target.value)} aria-label="인맥 검색" />
        </div>
        <select className="field !w-auto shrink-0" aria-label="정렬" value={sort} onChange={(e) => changeSort(e.target.value as Sort)} data-testid="people-sort">
          {SORTS.map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
      </div>

      {allTags.length > 0 && (
        <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1" role="group" aria-label="태그 필터">
          <button className={`chip ${!tag ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} aria-pressed={!tag} onClick={() => setTag(null)}>전체</button>
          {allTags.map((t) => (
            <button key={t} className={`chip ${tag === t ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>#{t}</button>
          ))}
        </div>
      )}

      {addMsg && <p className="rounded-2xl bg-[var(--accent-soft)] px-4 py-2.5 text-[14px] font-medium text-[var(--accent-text)]" role="status">{addMsg}</p>}

      {adding ? (
        <form
          className="surface grid gap-3 p-4 sm:grid-cols-2"
          aria-label="연락처 직접 추가"
          data-testid="manual-contact"
          onSubmit={(e) => {
            e.preventDefault();
            submitManual();
          }}
        >
          {MANUAL_FIELDS.map(([k, label, type, required]) => (
            <label key={k} className={k === "fullName" ? "sm:col-span-2" : ""}>
              <span className="label">{label}{required && " *"}</span>
              <input className="field" name={k} type={type} required={required} maxLength={k === "phone" ? 60 : 160} autoComplete="off" value={manual[k]} onChange={(e) => { setManual({ ...manual, [k]: e.target.value }); setDups(null); }} />
            </label>
          ))}
          {dups && (
            <div className="rounded-2xl border border-[var(--color-ember)]/40 p-3 text-[14px] sm:col-span-2" role="alert">
              <p className="font-semibold">이미 비슷한 연락처가 있어요</p>
              <ul className="mt-1.5 space-y-1">
                {dups.slice(0, 3).map((d) => (
                  <li key={d.contact.id}>
                    <Link href={`/app/people/${d.contact.id}`} className="underline">{d.contact.fullName}</Link>
                    <span className="text-[var(--fg-mute)]"> · {d.contact.company ?? "—"} ({d.reasons.join(", ")})</span>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-ghost mt-2 !min-h-10" disabled={saving} onClick={() => submitManual(true)}>그래도 새로 추가</button>
            </div>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" className="btn btn-signal" disabled={saving || !manual.fullName.trim()}>{saving ? "저장 중…" : "저장"}</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setAdding(false); setDups(null); }}>취소</button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn btn-ghost !min-h-11 w-full" onClick={() => { setAdding(true); setAddMsg(null); }} data-testid="manual-add">
          <Icon name="plus" size={17} /> 직접 추가
        </button>
      )}

      {error ? (
        <div className="surface flex flex-col items-start gap-3 p-6" role="alert" data-testid="people-error">
          <p className="text-[17px] font-semibold">인맥을 불러오지 못했어요</p>
          <p className="text-[14.5px] text-[var(--fg-mute)]">{error}</p>
          <button type="button" className="btn btn-signal" onClick={retry}>다시 시도</button>
        </div>
      ) : items === null ? (
        <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="surface h-[68px] animate-pulse" />)}</div>
      ) : items.length === 0 ? (
        <Empty title={q || tag ? "검색 결과가 없어요" : "아직 인맥이 없어요"} body={q || tag ? "다른 검색어나 태그를 시도해 보세요." : "명함을 교환하거나 스캔하면 여기에 쌓입니다."} action={q || tag ? undefined : <Link href="/app/exchange" className="btn btn-signal">교환 시작</Link>} />
      ) : sort === "company" ? (
        <div className="space-y-6" data-testid="people-list">
          {[...groups.entries()].map(([company, list]) => (
            <section key={company}>
              <h2 className="eyebrow mb-2 px-1">{company} · {list.length}</h2>
              <ul className="surface divide-y divide-[var(--line)] overflow-hidden">{list.map(row)}</ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="surface divide-y divide-[var(--line)] overflow-hidden" data-testid="people-list">{sorted.map(row)}</ul>
      )}
    </div>
  );
}
