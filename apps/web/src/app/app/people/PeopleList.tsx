"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Avatar, Empty } from "@/components/Page";
import { api, relTime } from "@/lib/client";

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

export function PeopleList() {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [items, setItems] = useState<C[] | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      const sp = new URLSearchParams();
      if (q) sp.set("q", q);
      if (tag) sp.set("tag", tag);
      api<{ contacts: C[] }>(`/contacts?${sp}`).then((r) => setItems(r.contacts)).catch(() => setItems([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q, tag]);

  const tags = useMemo(() => [...new Set((items ?? []).flatMap((c) => c.tags))].slice(0, 12), [items]);
  const groups = useMemo(() => {
    const g = new Map<string, C[]>();
    for (const c of items ?? []) {
      const k = c.company ?? "회사 미입력";
      g.set(k, [...(g.get(k) ?? []), c]);
    }
    return g;
  }, [items]);

  return (
    <div className="space-y-5">
      <div className="relative">
        <Icon name="search" size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--fg-mute)]" />
        <input className="field !pl-11" placeholder="이름, 회사, 직책, 이메일 검색" value={q} onChange={(e) => setQ(e.target.value)} aria-label="인맥 검색" />
      </div>
      {tags.length > 0 && (
        <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1">
          <button className={`chip ${!tag ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} onClick={() => setTag(null)}>전체</button>
          {tags.map((t) => (
            <button key={t} className={`chip ${tag === t ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} onClick={() => setTag(t)}>#{t}</button>
          ))}
        </div>
      )}
      {items === null ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="surface h-[68px] animate-pulse" />)}</div>
      ) : items.length === 0 ? (
        <Empty title={q ? "검색 결과가 없어요" : "아직 인맥이 없어요"} body="명함을 교환하거나 스캔하면 여기에 쌓입니다." action={<Link href="/app/exchange" className="btn btn-signal">교환 시작</Link>} />
      ) : (
        <div className="space-y-6">
          {[...groups.entries()].map(([company, list]) => (
            <section key={company}>
              <h2 className="eyebrow mb-2 px-1">{company} · {list.length}</h2>
              <ul className="surface divide-y divide-[var(--line)] overflow-hidden">
                {list.map((c) => (
                  <li key={c.id}>
                    <Link href={`/app/people/${c.id}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-[color-mix(in_srgb,var(--fg)_4%,transparent)]">
                      <Avatar name={c.fullName} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15.5px] font-semibold">{c.fullName}</span>
                        <span className="block truncate text-[13px] text-[var(--fg-mute)]">{c.jobTitle ?? "—"}</span>
                      </span>
                      <span className="text-right text-[12px] text-[var(--fg-mute)]">
                        {relTime(c.lastContactAt)}
                        {c.nextFollowupAt && <span className="block text-[var(--color-ember)]">후속 {relTime(c.nextFollowupAt)}</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
