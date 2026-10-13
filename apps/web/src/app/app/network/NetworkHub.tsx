"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel, Empty } from "@/components/Page";
import { api } from "@/lib/client";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { IcpEditor } from "./IcpEditor";
import { NetworkMap } from "./NetworkMap";
import { ScoreBars } from "./ScoreBars";

// 지침 §13: 점수를 숫자만 보여주지 않는다 — 구성요소 + evidence 를 함께 본다.
// masked 후보는 이름 대신 집계 라벨만 표시한다(서버가 애초에 이름을 보내지 않는다).

export interface Reco {
  resultId: string;
  resultType: string;
  disclosure: "full" | "masked" | "intro_only";
  displayName: string | null;
  maskedLabel: string | null;
  companyName: string | null;
  jobTitle: string | null;
  industry: string | null;
  region: string | null;
  score: number;
  scoreComponents: Record<string, number>;
  reasons: { text: string; feature: string; source: string; evidenceId: string | null; inferred: boolean }[];
  evidence: { id: string; type: string; summary: string; confidence: number; occurredAt: string | null; inferred: boolean }[];
  paths: { rank: number; hops: number; quality: number; cost: number; disclosure: string; introducerId: string | null; reasons: string[] }[];
  nextActions: string[];
  withheldReasons: string[];
  gates: Record<string, boolean>;
}

interface Intent {
  raw: string;
  industries: string[];
  geographies: string[];
  roles: string[];
  capabilities: string[];
  mustHave: string[];
  niceToHave: string[];
  networkHopsMax: number;
  recencyDays: number | null;
  targetTypes: string[];
  unparsed: string;
  provenance: string;
}

type ChipKey = "industries" | "geographies" | "roles" | "capabilities" | "mustHave" | "niceToHave";

const CHIP_LABEL: Record<ChipKey, string> = {
  industries: "산업",
  geographies: "지역",
  roles: "역할",
  capabilities: "역량",
  mustHave: "필수",
  niceToHave: "선호",
};

const DISCLOSURE_TEXT: Record<string, string> = { full: "연락처까지 공개", intro_only: "신원 공개 · 연락처는 소개 후", masked: "신원 비공개 · 소개 요청 가능" };

const EXAMPLES = [
  "베트남에서 의료기기를 유통할 회사를 내 3촌 안에서 찾아줘",
  "서울 병원 구매 담당자를 2촌 안에서 찾아줘",
  "반드시 영문 계약이 가능한 물류 파트너",
];

function Badge({ tone, children }: { tone: "ok" | "warn" | "mute"; children: React.ReactNode }) {
  const cls =
    tone === "ok"
      ? "bg-[var(--color-mint)] text-[var(--color-ink)]"
      : tone === "warn"
        ? "bg-[var(--color-butter)] text-[var(--color-ink)]"
        : "bg-[var(--bg-sunk)] text-[var(--fg-mute)]";
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${cls}`}>{children}</span>;
}

function ResultCard({ r, onEvidence }: { r: Reco; onEvidence: (r: Reco) => void }) {
  const [open, setOpen] = useState(false);
  const masked = r.disclosure === "masked";
  const best = r.paths[0];
  return (
    <li data-reveal className="rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[16.5px] font-semibold">
            {masked ? (
              <>
                <Icon name="lock" size={16} aria-hidden />
                <span className="text-[var(--fg-mute)]">{r.maskedLabel}</span>
              </>
            ) : (
              <>
                <span className="truncate">{r.displayName}</span>
                {r.jobTitle && <span className="text-[13px] font-normal text-[var(--fg-mute)]">{r.jobTitle}</span>}
              </>
            )}
          </p>
          <p className="mt-1 text-[13px] text-[var(--fg-mute)]">
            {[masked ? null : r.companyName, r.industry, r.region].filter(Boolean).join(" · ") || "추가 정보 없음"}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[22px] font-semibold leading-none">{Math.round(r.score)}</p>
          <p className="mt-1 text-[11px] text-[var(--fg-mute)]">적합도 100점 기준</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Badge tone={masked ? "warn" : "ok"}>{DISCLOSURE_TEXT[r.disclosure] ?? r.disclosure}</Badge>
        {best ? <Badge tone="ok">{best.hops === 1 ? "직접 아는 사이" : `${best.hops}촌 경로`}{r.paths.length > 1 ? ` · 대안 ${r.paths.length - 1}개` : ""}</Badge> : <Badge tone="mute">소개 경로 없음</Badge>}
        <AiLabel>AI 추론</AiLabel>
      </div>

      {r.reasons.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {r.reasons.slice(0, 3).map((reason, i) => (
            <li key={`${reason.feature}-${i}`} className="flex items-start gap-2 text-[13.5px]">
              <Icon name="check" size={15} className="mt-0.5 shrink-0 text-[var(--accent-text)]" aria-hidden />
              <span>
                {reason.text}
                {reason.inferred && <span className="ml-1.5 text-[11.5px] text-[var(--fg-mute)]">(추정)</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {r.withheldReasons.length > 0 && (
        <p className="mt-3 rounded-2xl bg-[var(--bg-sunk)] px-3 py-2 text-[12.5px] text-[var(--fg-mute)]">{r.withheldReasons.join(" · ")}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {r.gates.can_request_intro && !r.gates.can_reveal_contact && (
          <Link className="btn btn-ink !min-h-10" href={`/app/network/paths/${r.resultId}`}>
            <Icon name="share" size={16} aria-hidden />
            소개 경로 보기
          </Link>
        )}
        {r.gates.can_reveal_identity && (
          <Link className="btn btn-ghost !min-h-10" href={`/app/people/${r.resultId}`}>
            프로필
          </Link>
        )}
        <button className="btn btn-ghost !min-h-10" onClick={() => onEvidence(r)} aria-label="근거 보기">
          <Icon name="eye" size={16} aria-hidden />
          근거 {r.evidence.length}건
        </button>
        <button className="btn btn-ghost !min-h-10" onClick={() => setOpen(!open)} aria-expanded={open}>
          점수 구성
        </button>
      </div>

      {open && <ScoreBars components={r.scoreComponents} />}
    </li>
  );
}

function SearchTab({ initialQuery }: { initialQuery: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [results, setResults] = useState<Reco[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<Reco | null>(null);
  const [saved, setSaved] = useState(false);

  const run = useCallback(async (q: string, edits?: Partial<Intent>) => {
    if (q.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ parsedIntent: Intent; results: Reco[]; total: number }>("/network-intel/search", {
        body: { query: q, ...(edits ? { intentEdits: edits } : {}) },
      });
      setIntent(res.parsedIntent);
      setResults(res.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : "검색에 실패했습니다.");
      setResults([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (initialQuery) void run(initialQuery);
  }, [initialQuery, run]);

  // 조건 chip 을 지우면 그 조건 없이 다시 검색한다(지침 §13: 파싱된 intent 는 읽기전용이 아니다).
  // 수정은 **누적**해야 한다 — 한 축만 보내면 서버가 나머지를 원문에서 다시 파싱해
  // 먼저 지운 조건이 되살아난다.
  const editable = (i: Intent): Partial<Intent> => ({
    industries: i.industries,
    geographies: i.geographies,
    roles: i.roles,
    capabilities: i.capabilities,
    mustHave: i.mustHave,
    niceToHave: i.niceToHave,
    networkHopsMax: i.networkHopsMax,
    recencyDays: i.recencyDays,
    targetTypes: i.targetTypes,
  });
  const removeChip = (key: ChipKey, value: string) => {
    if (!intent) return;
    const next = { ...intent, [key]: intent[key].filter((v) => v !== value) };
    setIntent(next);
    void run(query, editable(next));
  };
  const setHops = (hops: number) => {
    if (!intent) return;
    const next = { ...intent, networkHopsMax: hops };
    setIntent(next);
    void run(query, editable(next));
  };

  return (
    <div>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          void run(query);
        }}
      >
        <input
          className="field"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="예: 베트남에서 의료기기를 유통할 회사를 3촌 안에서"
          aria-label="자연어 네트워크 검색"
        />
        <button className="btn btn-signal sm:w-auto" disabled={busy || query.trim().length < 2}>
          <Icon name="search" size={18} aria-hidden />
          {busy ? "검색 중…" : "검색"}
        </button>
      </form>

      {!results && !busy && (
        <div className="mt-4">
          <p className="label">이렇게 물어보세요</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className="chip"
                onClick={() => {
                  setQuery(ex);
                  void run(ex);
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {intent && (
        <section className="mt-5 rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)] p-4" aria-label="파싱된 검색 조건">
          <p className="label">해석한 조건 — 지우면 그 조건 없이 다시 찾습니다</p>
          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(CHIP_LABEL) as ChipKey[]).flatMap((key) =>
              intent[key].map((v) => (
                <button key={`${key}:${v}`} type="button" className="chip" onClick={() => removeChip(key, v)} aria-label={`${CHIP_LABEL[key]} 조건 ${v} 제거`}>
                  <span className="text-[var(--fg-mute)]">{CHIP_LABEL[key]}</span>
                  {v}
                  <Icon name="x" size={13} aria-hidden />
                </button>
              )),
            )}
            <span className="chip">
              <span className="text-[var(--fg-mute)]">촌수</span>
              {[1, 2, 3].map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHops(h)}
                  aria-pressed={intent.networkHopsMax === h}
                  className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${intent.networkHopsMax === h ? "bg-[var(--accent-soft)] text-[var(--accent-text)]" : "text-[var(--fg-mute)]"}`}
                >
                  {h}
                </button>
              ))}
            </span>
            {intent.recencyDays && <span className="chip">최근 {intent.recencyDays}일</span>}
          </div>
          {intent.unparsed && (
            <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]">
              해석하지 못한 표현: “{intent.unparsed}”{" "}
              <Link className="underline" href={`/app/network/taxonomy?alias=${encodeURIComponent(intent.unparsed)}`}>
                분류 별칭으로 등록
              </Link>
            </p>
          )}
          {results && results.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost mt-3 !min-h-10"
              disabled={saved}
              onClick={async () => {
                await api("/network-intel/saved-searches", { body: { query, intent } });
                setSaved(true);
              }}
            >
              {saved ? "저장됨" : "이 검색 저장"}
            </button>
          )}
        </section>
      )}

      {busy && <div className="mt-5 space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-3xl border border-[var(--line)]" />)}</div>}

      {error && (
        <p role="alert" className="mt-5 rounded-2xl border border-[var(--color-ember)] bg-[color-mix(in_srgb,var(--color-ember)_8%,transparent)] px-4 py-3 text-[13.5px]">
          {error}
        </p>
      )}

      {results && !busy && results.length === 0 && !error && (
        <div className="mt-5">
          <Empty
            title="조건을 만족하는 후보를 찾지 못했습니다"
            body="촌수를 넓히거나 필수 조건을 줄여 보세요. 명함을 더 스캔하면 네트워크가 넓어집니다."
            action={
              <Link className="btn btn-ink" href="/app/scan">
                명함 스캔
              </Link>
            }
          />
        </div>
      )}

      {results && results.length > 0 && (
        <ul className="stagger mt-5 space-y-3">
          {results.map((r) => (
            <ResultCard key={r.resultId} r={r} onEvidence={setDrawer} />
          ))}
        </ul>
      )}

      {drawer && <EvidenceDrawer reco={drawer} onClose={() => setDrawer(null)} />}
    </div>
  );
}

interface Partner {
  partnerId: string;
  score: number;
  inboundPotential: number;
  outboundPotential: number;
  reciprocal: boolean;
  reasons: string[];
  hops: number;
  disclosure: string;
  displayName: string | null;
  maskedLabel: string | null;
  companyName: string | null;
}

function PartnersTab() {
  const [data, setData] = useState<{ partners: Partner[]; needsIcp: boolean } | null>(null);
  const [editIcp, setEditIcp] = useState(false);
  const load = useCallback(() => {
    setData(null);
    api<{ partners: Partner[]; needsIcp: boolean }>("/network-intel/referral-partners")
      .then(setData)
      .catch(() => setData({ partners: [], needsIcp: true }));
  }, []);
  useEffect(load, [load]);
  if (editIcp)
    return (
      <IcpEditor
        onSaved={() => {
          setEditIcp(false);
          load();
        }}
      />
    );
  if (!data) return <div className="h-40 animate-pulse rounded-3xl border border-[var(--line)]" />;
  if (data.needsIcp) return <IcpEditor onSaved={load} />;
  if (!data.partners.length) {
    return (
      <Empty
        title="아직 추천할 파트너가 없습니다"
        body="연락처의 산업·역량 정보가 쌓이면 교차 소개 가능성을 계산할 수 있습니다. 고객상을 조정해 볼 수도 있습니다."
        action={
          <button className="btn btn-ink" onClick={() => setEditIcp(true)}>
            고객상 수정
          </button>
        }
      />
    );
  }
  return (
    <ul className="stagger space-y-3">
      {data.partners.map((p) => (
        <li key={p.partnerId} data-reveal className="rounded-3xl border border-[var(--line)] bg-[var(--bg-elev)] p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[16.5px] font-semibold">{p.displayName ?? p.maskedLabel}</p>
              <p className="mt-1 text-[13px] text-[var(--fg-mute)]">{[p.companyName, `${p.hops}촌`].filter(Boolean).join(" · ")}</p>
            </div>
            <div className="text-right">
              <p className="text-[22px] font-semibold leading-none">{Math.round(p.score)}</p>
              <p className="mt-1 text-[11px] text-[var(--fg-mute)]">교차 소개 가능성</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge tone={p.reciprocal ? "ok" : "warn"}>{p.reciprocal ? "서로 줄 것이 있음" : "한쪽에 치우침"}</Badge>
            <Badge tone="mute">받을 가능성 {Math.round(p.inboundPotential * 100)}%</Badge>
            <Badge tone="mute">줄 가능성 {Math.round(p.outboundPotential * 100)}%</Badge>
            <AiLabel>AI 추론</AiLabel>
          </div>
          <ul className="mt-3 space-y-1.5">
            {p.reasons.map((reason, i) => (
              <li key={i} className="flex items-start gap-2 text-[13.5px]">
                <Icon name="check" size={15} className="mt-0.5 shrink-0 text-[var(--accent-text)]" aria-hidden />
                {reason}
              </li>
            ))}
          </ul>
          <Link className="btn btn-ghost mt-4 !min-h-10" href={`/app/network/paths/${p.partnerId}`}>
            소개 경로 보기
          </Link>
        </li>
      ))}
    </ul>
  );
}

const TABS = [
  { key: "search", label: "AI 검색", icon: "search" as const },
  { key: "map", label: "네트워크 맵", icon: "layers" as const },
  { key: "partners", label: "소개 파트너", icon: "people" as const },
];

export function NetworkHub({ initialQuery, initialTab }: { initialQuery: string; initialTab: "search" | "map" | "partners" }) {
  const [tab, setTab] = useState(initialTab);
  return (
    <div>
      <div role="tablist" aria-label="네트워크 보기" className="flex gap-2 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`chip !px-3.5 !py-2 ${tab === t.key ? "!border-[var(--accent)] !bg-[var(--accent-soft)] !text-[var(--accent-text)]" : ""}`}
            onClick={() => setTab(t.key as typeof tab)}
          >
            <Icon name={t.icon} size={15} aria-hidden />
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {tab === "search" && <SearchTab initialQuery={initialQuery} />}
        {tab === "map" && <NetworkMap />}
        {tab === "partners" && <PartnersTab />}
      </div>
    </div>
  );
}
