"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Empty } from "@/components/Page";
import { api } from "@/lib/client";

// N-107. 별칭은 검색 의도 파싱에 바로 반영된다 — 등록하면 그 표현이 조건 chip 으로 잡힌다.
// canonical 값은 분류 사전 안에서만 고를 수 있다(사전 밖 값을 통과시키면 추천 feature 가 조용히 어긋난다).

type Kind = "industry" | "region" | "role" | "capability";

interface Alias {
  id: string;
  kind: Kind;
  alias: string;
  canonicalName: string;
  scope: "personal" | "organization";
}
interface Options {
  industry: string[];
  region: string[];
  role: string[];
}

const KIND_LABEL: Record<Kind, string> = { industry: "산업", region: "지역", role: "역할", capability: "역량" };
const ERROR_TEXT: Record<string, string> = {
  alias_unknown_canonical: "분류 사전에 없는 값입니다. 목록에서 골라 주세요.",
  alias_already_in_dictionary: "이미 사전에 있는 표현이라 별칭으로 등록할 필요가 없습니다.",
  alias_alias_too_short: "별칭은 2자 이상이어야 합니다.",
  no_active_org: "조직에 공유하려면 활성 조직이 필요합니다.",
};

export function AliasEditor({ initialAlias }: { initialAlias: string }) {
  const [data, setData] = useState<{ aliases: Alias[]; options: Options } | null>(null);
  const [f, setF] = useState<{ kind: Kind; alias: string; canonicalName: string; shareWithOrg: boolean }>({
    kind: "industry",
    alias: initialAlias,
    canonicalName: "",
    shareWithOrg: false,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await api<{ aliases: Alias[]; options: Options }>("/network-intel/aliases"));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <div className="h-48 animate-pulse rounded-3xl border border-[var(--line)]" />;

  const choices = f.kind === "capability" ? [] : data.options[f.kind];

  return (
    <div className="space-y-5">
      <form
        className="space-y-3 rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)] p-4 sm:p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await api("/network-intel/aliases", { body: f });
            setF({ ...f, alias: "", canonicalName: "" });
            await load();
          } catch (e2) {
            const code = e2 && typeof e2 === "object" && "code" in e2 ? String((e2 as { code: unknown }).code) : "";
            setErr(ERROR_TEXT[code] ?? (e2 instanceof Error ? e2.message : "등록하지 못했습니다."));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <h2 className="text-[16px] font-semibold">별칭 추가</h2>
          <p className="mt-1 text-[13px] text-[var(--fg-mute)]">
            사내에서 쓰는 줄임말이나 다른 언어 표현을 분류값에 연결하면, 그 말로 검색해도 조건이 잡힙니다. 예: “메디텍” → 의료기기.
          </p>
        </div>

        <fieldset>
          <legend className="label">종류</legend>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={f.kind === k}
                onClick={() => setF({ ...f, kind: k, canonicalName: "" })}
                className={`chip ${f.kind === k ? "!border-[var(--accent)] !bg-[var(--accent-soft)] !text-[var(--accent-text)]" : ""}`}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </fieldset>

        <div>
          <label className="label" htmlFor="alias">
            우리가 쓰는 표현
          </label>
          <input id="alias" className="field" value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value })} placeholder="예: 메디텍" minLength={2} required />
        </div>

        <div>
          <label className="label" htmlFor="canon">
            연결할 분류값
          </label>
          {f.kind === "capability" ? (
            <input id="canon" className="field" value={f.canonicalName} onChange={(e) => setF({ ...f, canonicalName: e.target.value })} placeholder="예: 의료기기 유통" required />
          ) : (
            <select id="canon" className="field" value={f.canonicalName} onChange={(e) => setF({ ...f, canonicalName: e.target.value })} required>
              <option value="">선택하세요</option>
              {choices.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          )}
        </div>

        <label className="flex items-center gap-2 text-[13.5px]">
          <input type="checkbox" className="size-4" checked={f.shareWithOrg} onChange={(e) => setF({ ...f, shareWithOrg: e.target.checked })} />
          같은 조직 구성원 모두에게 적용
        </label>

        {err && (
          <p role="alert" className="rounded-2xl border border-[var(--color-ember)] bg-[color-mix(in_srgb,var(--color-ember)_8%,transparent)] px-3 py-2 text-[13px]">
            {err}
          </p>
        )}

        <button className="btn btn-signal" disabled={busy || f.alias.trim().length < 2 || !f.canonicalName.trim()}>
          {busy ? "등록 중…" : "별칭 등록"}
        </button>
      </form>

      <section>
        <p className="label">등록된 별칭 {data.aliases.length}개</p>
        {data.aliases.length === 0 ? (
          <Empty title="아직 별칭이 없습니다" body="검색에서 해석되지 않은 표현이 나오면 여기에 등록해 두세요." />
        ) : (
          <ul className="divide-y divide-[var(--line)] overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)]">
            {data.aliases.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14.5px]">
                    <span className="mr-2 rounded-full bg-[var(--bg-sunk)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--fg-mute)]">{KIND_LABEL[a.kind]}</span>
                    “{a.alias}” <Icon name="arrow" size={13} className="mx-1 inline text-[var(--fg-mute)]" aria-label="는 다음으로 해석됩니다" /> {a.canonicalName}
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-[var(--fg-mute)]">{a.scope === "organization" ? "조직 전체 적용" : "내 계정에만 적용"}</p>
                </div>
                <button
                  className="shrink-0 text-[12.5px] underline text-[var(--fg-mute)]"
                  onClick={async () => {
                    await api(`/network-intel/aliases/${a.id}`, { method: "DELETE" });
                    await load();
                  }}
                  aria-label={`${a.alias} 별칭 삭제`}
                >
                  삭제
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
