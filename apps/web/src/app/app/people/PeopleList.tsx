"use client";
// UX-011 People — search/tag filter (F-070), sort, error+retry, manual entry (F-065 Contact 레코드, 중복 확인 F-072) next to scan
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { useI18n } from "@/components/I18n";
import { Avatar, Empty } from "@/components/Page";
import { OFFLINE_MESSAGE, api, isQueuedOffline, relTime } from "@/lib/client";
import { intlLocale, tf } from "@/lib/i18n";

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
const SORTS: Sort[] = ["recent", "name", "company"];
const SORT_KEY = "linkos.people.sort";
const ko = new Intl.Collator("ko-KR");

// labels: m.person.fields[key] (F-177)
const MANUAL_FIELDS = [
  ["fullName", "text", true],
  ["company", "text", false],
  ["jobTitle", "text", false],
  ["email", "email", false],
  ["phone", "tel", false],
] as const;
type Manual = Record<(typeof MANUAL_FIELDS)[number][0], string>;
const EMPTY_MANUAL: Manual = { fullName: "", company: "", jobTitle: "", email: "", phone: "" };

// F-177 ko/en · company filter (client-side, over the loaded list)
export function PeopleList() {
  const router = useRouter();
  const { locale, m } = useI18n();
  const L = m.people;
  const lang = intlLocale(locale);
  const [company, setCompany] = useState("");
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
          setError((e as Error).message || L.loadFailed);
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

  const companies = useMemo(() => [...new Set((items ?? []).map((c) => c.company).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, lang)), [items, lang]);
  // a company that disappeared from the (search/tag-filtered) list no longer filters anything
  const activeCompany = companies.includes(company) ? company : "";
  const visible = useMemo(() => (activeCompany ? sorted.filter((c) => c.company === activeCompany) : sorted), [sorted, activeCompany]);
  const groups = useMemo(() => {
    const g = new Map<string, C[]>();
    for (const c of visible) {
      const k = c.company ?? L.noCompany;
      g.set(k, [...(g.get(k) ?? []), c]);
    }
    return g;
  }, [visible, L.noCompany]);

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
          {relTime(c.lastContactAt, lang)}
          {c.nextFollowupAt && <span className="block text-[var(--color-ember)]">{tf(L.followupIn, { when: relTime(c.nextFollowupAt, lang) })}</span>}
        </span>
      </Link>
    </li>
  );

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Icon name="search" size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--fg-mute)]" />
          <input className="field !pl-11" placeholder={L.searchPh} value={q} onChange={(e) => setQ(e.target.value)} aria-label={L.searchAria} />
        </div>
        <select className="field !w-auto shrink-0" aria-label={L.sort} value={sort} onChange={(e) => changeSort(e.target.value as Sort)} data-testid="people-sort">
          {SORTS.map((k) => (
            <option key={k} value={k}>{L.sorts[k]}</option>
          ))}
        </select>
      </div>
      {companies.length > 1 && (
        <label className="flex items-center gap-2 text-[14px]">
          <span className="shrink-0 font-medium text-[var(--fg-mute)]">{L.companyFilter}</span>
          <select className="field !min-h-11 !py-2 !text-[14px]" value={activeCompany} onChange={(e) => setCompany(e.target.value)} data-testid="company-filter">
            <option value="">{L.allCompanies}</option>
            {companies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      )}

      {allTags.length > 0 && (
        <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1" role="group" aria-label={L.tagFilter}>
          <button className={`chip ${!tag ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} aria-pressed={!tag} onClick={() => setTag(null)}>{m.common.all}</button>
          {allTags.map((t) => (
            <button key={t} className={`chip ${tag === t ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>#{t}</button>
          ))}
        </div>
      )}

      {addMsg && <p className="rounded-2xl bg-[var(--accent-soft)] px-4 py-2.5 text-[14px] font-medium text-[var(--accent-text)]" role="status">{addMsg}</p>}

      {adding ? (
        <form
          className="surface grid gap-3 p-4 sm:grid-cols-2"
          aria-label={L.manualAria}
          data-testid="manual-contact"
          onSubmit={(e) => {
            e.preventDefault();
            submitManual();
          }}
        >
          {MANUAL_FIELDS.map(([k, type, required]) => (
            <label key={k} className={k === "fullName" ? "sm:col-span-2" : ""}>
              <span className="label">{m.person.fields[k]}{required && " *"}</span>
              <input className="field" name={k} type={type} required={required} maxLength={k === "phone" ? 60 : 160} autoComplete="off" value={manual[k]} onChange={(e) => { setManual({ ...manual, [k]: e.target.value }); setDups(null); }} />
            </label>
          ))}
          {dups && (
            <div className="rounded-2xl border border-[var(--color-ember)]/40 p-3 text-[14px] sm:col-span-2" role="alert">
              <p className="font-semibold">{L.dupExists}</p>
              <ul className="mt-1.5 space-y-1">
                {dups.slice(0, 3).map((d) => (
                  <li key={d.contact.id}>
                    <Link href={`/app/people/${d.contact.id}`} className="underline">{d.contact.fullName}</Link>
                    <span className="text-[var(--fg-mute)]"> · {d.contact.company ?? "—"} ({d.reasons.join(", ")})</span>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-ghost mt-2 !min-h-10" disabled={saving} onClick={() => submitManual(true)}>{L.addAnyway}</button>
            </div>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" className="btn btn-signal" disabled={saving || !manual.fullName.trim()}>{saving ? m.common.saving : m.common.save}</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setAdding(false); setDups(null); }}>{m.common.cancel}</button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn btn-ghost !min-h-11 w-full" onClick={() => { setAdding(true); setAddMsg(null); }} data-testid="manual-add">
          <Icon name="plus" size={17} /> {L.manualAdd}
        </button>
      )}

      {error ? (
        <div className="surface flex flex-col items-start gap-3 p-6" role="alert" data-testid="people-error">
          <p className="text-[17px] font-semibold">{L.loadFailed}</p>
          <p className="text-[14.5px] text-[var(--fg-mute)]">{error}</p>
          <button type="button" className="btn btn-signal" onClick={retry}>{L.retry}</button>
        </div>
      ) : items === null ? (
        <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="surface h-[68px] animate-pulse" />)}</div>
      ) : items.length === 0 ? (
        <Empty title={q || tag ? L.noResults : L.empty} body={q || tag ? L.noResultsBody : L.emptyBody} action={q || tag ? undefined : <Link href="/app/exchange" className="btn btn-signal">{m.common.startExchange}</Link>} />
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
        <ul className="surface divide-y divide-[var(--line)] overflow-hidden" data-testid="people-list">{visible.map(row)}</ul>
      )}
    </div>
  );
}
