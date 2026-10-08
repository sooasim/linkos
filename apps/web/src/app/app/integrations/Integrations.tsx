"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Empty } from "@/components/Page";
import { api, relTime, uid } from "@/lib/client";

const NAMES: Record<string, string> = { microsoft: "Outlook / Microsoft 365", salesforce: "Salesforce", hubspot: "HubSpot", dynamics: "Dynamics 365", google: "Google" };
const LOCAL: [string, string][] = [["firstName", "이름(First)"], ["lastName", "성(Last)"], ["fullName", "전체 이름"], ["company", "회사"], ["jobTitle", "직책"], ["department", "부서"], ["email", "이메일"], ["phone", "전화"], ["address", "주소"], ["website", "웹사이트"], ["linkosId", "LINKOS ID"]];
const STATUS: Record<string, string> = { queued: "대기", retry: "재시도 예정", done: "완료", dead: "실패", conflict: "충돌", skipped: "건너뜀" };

function Section({ title, icon, children }: { title: string; icon: "link" | "layers" | "chart" | "bolt" | "building"; children: React.ReactNode }) {
  return (
    <section className="surface space-y-4 p-5">
      <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Icon name={icon} size={19} />{title}</h2>
      {children}
    </section>
  );
}

export function Integrations() {
  const [providers, setProviders] = useState<any[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [journalKey, setJournalKey] = useState(0);
  const load = useCallback(() => api<{ providers: any[] }>("/integrations/providers").then((r) => setProviders(r.providers)), []);
  useEffect(() => {
    load();
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("connected")) setFlash(`${NAMES[sp.get("connected")!] ?? sp.get("connected")} 연결 완료`);
    if (sp.get("error")) setFlash("연결이 취소되었거나 실패했습니다.");
  }, [load]);

  return (
    <div className="space-y-4">
      {flash && <p className="surface p-3 text-[14px]" role="status">{flash}</p>}
      <Section title="CRM · Microsoft" icon="link">
        <p className="text-[13px] text-[var(--fg-mute)]">LINKOS는 내가 고른 연락처만 내보내며, 외부에서 바뀐 레코드는 덮어쓰지 않고 ‘충돌’로 알려 드립니다. 토큰은 암호화해 저장합니다.</p>
        <ul className="space-y-3">
          {providers.map((p) => <ProviderCard key={p.provider} p={p} onChange={() => { load(); setJournalKey((k) => k + 1); }} />)}
        </ul>
      </Section>
      {providers.some((p) => p.provider === "hubspot" && p.status === "active") && (
        <HubspotObjects provider={providers.find((p) => p.provider === "hubspot")} onChange={() => setJournalKey((k) => k + 1)} />
      )}
      <Journal key={journalKey} />
      <Webhooks />
    </div>
  );
}

function ProviderCard({ p, onChange }: { p: any; onChange: () => void }) {
  const [orgUrl, setOrgUrl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [mapping, setMapping] = useState<string | null>(null);
  const connected = p.status === "active";
  const connect = async () => {
    try {
      const r = await api<{ url: string }>(`/integrations/${p.provider}/connect`, { body: p.provider === "dynamics" ? { orgUrl } : {} });
      window.location.href = r.url;
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const pushAll = async (object: string) => {
    try {
      const r = await api<{ queued: number; total: number }>(`/integrations/${p.provider}/push`, { body: { object } });
      setMsg(`${r.total}명 중 ${r.queued}건을 동기화 대기열에 넣었어요.`);
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <li className="rounded-[18px] border border-[var(--line)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">{NAMES[p.provider]} {connected && <span className="chip ml-1">연결됨</span>}{p.status === "reauth_required" && <span className="chip ml-1 !text-[var(--color-ember)]">재연결 필요</span>}</p>
        {connected && <button className="text-[13px] text-[var(--color-ember)]" onClick={() => api(`/integrations/${p.provider}`, { method: "DELETE" }).then(onChange)}>연결 해제</button>}
      </div>
      {p.account?.email && <p className="mt-1 text-[13px] text-[var(--fg-mute)]">{p.account.email}</p>}
      {!p.configured ? (
        <p className="mt-2 text-[13px] text-[var(--fg-mute)]">서버에 {p.provider.toUpperCase()}_CLIENT_ID 가 설정되지 않았습니다.</p>
      ) : !connected ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {p.provider === "dynamics" && <input className="field !w-72" placeholder="https://contoso.crm5.dynamics.com" value={orgUrl} onChange={(e) => setOrgUrl(e.target.value)} aria-label="Dynamics 조직 URL" />}
          <button className="btn btn-ink !min-h-10 text-[14px]" disabled={p.provider === "dynamics" && !orgUrl} onClick={connect}>연결</button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {p.objects.map((o: string) => <button key={o} className="btn btn-signal !min-h-9 text-[13px]" onClick={() => pushAll(o)}>{o === "lead" ? "리드로 내보내기" : "연락처 내보내기"}</button>)}
          {p.objects.map((o: string) => <button key={`m-${o}`} className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => setMapping(mapping === o ? null : o)}>필드 매핑{p.objects.length > 1 ? ` (${o === "lead" ? "리드" : "연락처"})` : ""}</button>)}
        </div>
      )}
      {mapping && <MappingEditor provider={p.provider} object={mapping} />}
      {msg && <p className="mt-2 text-[13px]" role="status">{msg}</p>}
    </li>
  );
}

function MappingEditor({ provider, object }: { provider: string; object: string }) {
  const [m, setM] = useState<any>(null);
  const [rows, setRows] = useState<{ local: string; remote: string }[]>([]);
  const [extId, setExtId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    api(`/integrations/${provider}/mappings?object=${object}`).then((r: any) => {
      setM(r);
      setRows(r.entries);
      setExtId(r.externalIdField ?? "");
    });
  }, [provider, object]);
  const save = async () => {
    setErr(null);
    setOk(false);
    try {
      const r: any = await api(`/integrations/${provider}/mappings`, { method: "PUT", body: { object, entries: rows.filter((x) => x.remote), externalIdField: extId || null } });
      setM(r);
      setOk(true);
    } catch (e) {
      const d = (e as { details?: string[] }).details;
      setErr(Array.isArray(d) ? d.join(", ") : (e as Error).message);
    }
  };
  if (!m) return <div className="surface mt-3 h-20 animate-pulse" />;
  return (
    <div className="mt-3 space-y-2 rounded-[14px] bg-[var(--bg-soft,transparent)] p-1" aria-label="필드 매핑">
      <p className="text-[12.5px] text-[var(--fg-mute)]">{m.isDefault ? "기본 매핑 사용 중" : "사용자 매핑"} · 비어 있는 LINKOS 값은 보내지 않아 CRM 값을 지우지 않습니다.</p>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <select className="field !min-h-9 text-[13px]" value={r.local} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, local: e.target.value } : x)))} aria-label="LINKOS 필드">
            {LOCAL.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <Icon name="arrow" size={14} className="shrink-0 opacity-50" />
          <input className="field !min-h-9 text-[13px]" value={r.remote} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, remote: e.target.value } : x)))} aria-label="외부 필드" />
          <button aria-label="행 삭제" className="shrink-0 text-[var(--fg-mute)]" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => setRows([...rows, { local: "email", remote: "" }])}><Icon name="plus" size={14} />필드 추가</button>
        <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => setRows(m.defaults)}>기본값으로</button>
      </div>
      {(provider === "salesforce" || provider === "dynamics") && (
        <label className="block text-[13px]">외부 ID 필드 (선택, 예: LINKOS_Id__c — 이 필드로 upsert)
          <input className="field !min-h-9 text-[13px]" value={extId} onChange={(e) => setExtId(e.target.value)} />
        </label>
      )}
      <button className="btn btn-signal !min-h-9 text-[13px]" onClick={save}>매핑 저장</button>
      {err && <p className="text-[13px] text-[var(--color-ember)]" role="alert">{err}</p>}
      {ok && <p className="text-[13px]" role="status">저장했어요.</p>}
    </div>
  );
}

function Journal() {
  const [data, setData] = useState<any>(null);
  const [filter, setFilter] = useState<string>("");
  const load = useCallback(() => api(`/integrations/journal${filter ? `?status=${filter}` : ""}`).then(setData), [filter]);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (path: string, body: unknown = {}) => {
    await api(path, { body }).catch((e) => alert((e as Error).message));
    load();
  };
  return (
    <Section title="Sync Journal" icon="layers">
      <div className="flex flex-wrap gap-2">
        {["", "conflict", "dead", "retry", "done"].map((s) => (
          <button key={s} className={`chip ${filter === s ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} onClick={() => setFilter(s)}>{s ? STATUS[s] : "전체"}{s && data?.counts ? ` ${data.counts.filter((c: any) => c.status === s).reduce((a: number, c: any) => a + c.n, 0)}` : ""}</button>
        ))}
      </div>
      {!data ? <div className="h-16 animate-pulse" /> : data.entries.length === 0 ? <Empty title="동기화 기록이 없어요" /> : (
        <ul className="divide-y divide-[var(--line)] text-[13.5px]">
          {data.entries.map((e: any) => (
            <li key={e.id} className="space-y-1 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="chip">{NAMES[e.provider] ?? e.provider}</span>
                <span className={`chip ${e.status === "conflict" || e.status === "dead" ? "!text-[var(--color-ember)]" : ""}`}>{STATUS[e.status] ?? e.status}</span>
                <span className="font-medium">{e.deal ? `딜 · ${e.deal.name ?? ""}` : e.jobType === "crm.company.upsert" ? `회사 · ${e.contact?.fullName ?? ""}` : (e.contact?.fullName ?? (e.meetingId ? "미팅 노트" : e.jobType))}</span>
                <span className="text-[var(--fg-mute)]">{e.jobType} · 시도 {e.attempts} · {relTime(e.finishedAt ?? e.scheduledAt)}</span>
              </div>
              {e.external && <p className="text-[12.5px] text-[var(--fg-mute)]">외부 ID {e.external.id}{e.external.etag ? ` · etag ${String(e.external.etag).slice(0, 24)}` : ""}{e.external.url ? <> · <a className="underline" href={e.external.url} target="_blank" rel="noopener noreferrer">열기</a></> : null}</p>}
              {e.error && <p className="text-[12.5px] text-[var(--color-ember)]">{e.error}</p>}
              {e.resolution && <p className="text-[12.5px] text-[var(--fg-mute)]">처리: {e.resolution === "kept_remote" ? "외부 값 유지" : "LINKOS 값으로 덮어쓰기 승인"}</p>}
              <div className="flex gap-2">
                {e.canRetry && <button className="btn btn-ghost !min-h-8 text-[12.5px]" onClick={() => act(`/integrations/jobs/${e.id}/retry`)}>다시 시도</button>}
                {e.canResolve && (
                  <>
                    <button className="btn btn-ghost !min-h-8 text-[12.5px]" onClick={() => act(`/integrations/jobs/${e.id}/resolve`, { strategy: "skip" })}>외부 값 유지</button>
                    <button className="btn btn-ink !min-h-8 text-[12.5px]" onClick={() => confirm("외부 시스템의 최신 값을 LINKOS 값으로 덮어씁니다. 계속할까요?") && act(`/integrations/jobs/${e.id}/resolve`, { strategy: "overwrite" })}>LINKOS 값으로 덮어쓰기</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Webhooks() {
  const [data, setData] = useState<{ events: string[]; endpoints: any[] } | null>(null);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["contact.updated", "exchange.completed"]);
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const load = () => api<{ events: string[]; endpoints: any[] }>("/webhooks").then(setData);
  useEffect(() => {
    load();
  }, []);
  const create = async () => {
    setErr(null);
    try {
      const r = await api<any>("/webhooks", { body: { url, events }, idempotencyKey: uid() });
      setSecret({ id: r.id, secret: r.secret });
      setUrl("");
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const refreshDeliveries = async (id: string) => setDeliveries((await api<{ deliveries: any[] }>(`/webhooks/${id}/deliveries`)).deliveries);
  const showDeliveries = async (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    await refreshDeliveries(id);
  };
  const test = async (id: string) => {
    const r = await api<any>(`/webhooks/${id}/test`, { body: {} }).catch((e) => ({ status: "error", last_error: (e as Error).message }));
    setTestResult({ ...testResult, [id]: r.status === "delivered" ? `성공 (HTTP ${r.response_status})` : `실패: ${r.last_error ?? r.response_status}` });
    if (open === id) await refreshDeliveries(id);
  };
  const rotate = async (id: string) => {
    if (!confirm("새 서명 비밀키를 만들까요? 수신 측 설정도 바꿔야 합니다.")) return;
    const r = await api<any>(`/webhooks/${id}/rotate`, { body: {} });
    setSecret({ id, secret: r.secret });
  };
  return (
    <Section title="Webhook · Zapier · Make" icon="bolt">
      <p className="text-[13px] text-[var(--fg-mute)]">Zapier ‘Catch Hook’, Make ‘Custom webhook’ URL을 등록하면 선택한 이벤트를 JSON으로 보냅니다. 요청에는 <code>LINKOS-Signature: t=…,v1=HMAC-SHA256(secret, t.body)</code> 헤더가 붙고, 실패 시 지수 백오프로 재시도합니다. 이벤트에는 ID만 담기며 연락처 원문은 포함되지 않습니다.</p>
      {secret && (
        <div className="rounded-[14px] border-2 border-[var(--fg)] p-3 text-[13.5px]" role="status">
          <p className="font-semibold">서명 비밀키 — 지금 한 번만 표시됩니다</p>
          <code className="mt-1 block break-all">{secret.secret}</code>
          <button className="mt-2 text-[13px] underline" onClick={() => setSecret(null)}>저장했어요</button>
        </div>
      )}
      {data?.endpoints.length ? (
        <ul className="space-y-2">
          {data.endpoints.map((ep) => (
            <li key={ep.id} className="rounded-[16px] border border-[var(--line)] p-3 text-[13.5px]">
              <p className="break-all font-medium">{ep.url}</p>
              <p className="text-[12.5px] text-[var(--fg-mute)]">{ep.events.join(", ")} · 7일: 성공 {ep.last7d.delivered ?? 0} / 실패 {(ep.last7d.dead ?? 0) + (ep.last7d.retry ?? 0)}{!ep.active ? ` · 꺼짐${ep.disabledReason ? ` (${ep.disabledReason})` : ""}` : ""}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button className="btn btn-ghost !min-h-8 text-[12.5px]" onClick={() => test(ep.id)}>테스트 전송</button>
                <button className="btn btn-ghost !min-h-8 text-[12.5px]" onClick={() => showDeliveries(ep.id)}>전송 기록</button>
                <button className="btn btn-ghost !min-h-8 text-[12.5px]" onClick={() => api(`/webhooks/${ep.id}`, { method: "PATCH", body: { active: !ep.active } }).then(load)}>{ep.active ? "끄기" : "켜기"}</button>
                <button className="btn btn-ghost !min-h-8 text-[12.5px]" onClick={() => rotate(ep.id)}>비밀키 교체</button>
                <button className="text-[12.5px] text-[var(--color-ember)]" onClick={() => confirm("웹훅을 삭제할까요?") && api(`/webhooks/${ep.id}`, { method: "DELETE" }).then(load)}>삭제</button>
              </div>
              {testResult[ep.id] && <p className="mt-1 text-[12.5px]" role="status">{testResult[ep.id]}</p>}
              {open === ep.id && (
                <ul className="mt-2 space-y-1 text-[12.5px]">
                  {deliveries.length === 0 && <li className="text-[var(--fg-mute)]">기록 없음</li>}
                  {deliveries.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-2">
                      <span className="chip">{d.status}</span>
                      <span>{d.event_type}</span>
                      <span className="text-[var(--fg-mute)]">HTTP {d.response_status ?? "-"} · 시도 {d.attempt_count} · {relTime(d.created_at)}{d.last_error ? ` · ${d.last_error}` : ""}</span>
                      {(d.status === "dead" || d.status === "delivered") && <button className="underline" onClick={() => api(`/webhook-deliveries/${d.id}/redeliver`, { body: {} }).then(() => refreshDeliveries(ep.id))}>다시 보내기</button>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="space-y-2">
        <input className="field" placeholder="https://hooks.zapier.com/hooks/catch/…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="웹훅 URL" />
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {(data?.events ?? []).filter((e) => e !== "privacy.deletion.requested").map((e) => (
            <label key={e} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" className="size-4" checked={events.includes(e)} onChange={(x) => setEvents(x.target.checked ? [...events, e] : events.filter((y) => y !== e))} />
              {e}
            </label>
          ))}
        </div>
        <button className="btn btn-signal" disabled={!url || !events.length} onClick={create}>웹훅 추가</button>
        {err && <p className="text-[13px] text-[var(--color-ember)]" role="alert">{err}</p>}
      </div>
    </Section>
  );
}

// ---------- F-121 HubSpot 회사·딜 (F-127 매핑 + 파이프라인/단계 매핑) ----------
const COMPANY_LOCAL: Record<string, string> = { companyName: "회사명", domain: "도메인", website: "웹사이트" };
const DEAL_LOCAL: Record<string, string> = { dealName: "딜 이름", amount: "금액", closeDate: "마감 예정일", description: "설명" };

function HubspotObjects({ provider, onChange }: { provider: any; onChange: () => void }) {
  const [s, setS] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<"company" | "deal" | null>(null);
  const ok = provider?.capabilities?.companies && provider?.capabilities?.deals;
  useEffect(() => {
    if (ok) api("/integrations/hubspot/deal-settings").then(setS).catch(() => undefined);
  }, [ok]);
  const reconnect = async () => {
    try {
      window.location.href = (await api<{ url: string }>("/integrations/hubspot/connect", { body: {} })).url;
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const syncCompanies = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ queued: number; total: number; companies: number; statuses: Record<string, number> }>("/integrations/hubspot/companies/sync", { body: {}, offline: false });
      const conflicts = r.statuses.conflict ?? 0;
      setMsg(`회사가 있는 연락처 ${r.total}명 중 ${r.queued}건 처리 · 연결된 HubSpot 회사 ${r.companies}개${conflicts ? ` · 충돌 ${conflicts}건은 Sync Journal에서 결정하세요` : ""}`);
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="HubSpot 회사·딜" icon="building">
      <p className="text-[13px] text-[var(--fg-mute)]">회사는 도메인으로 중복을 막고(무료 메일 도메인은 제외) 연락처와 연결합니다. HubSpot에 이미 있는 회사는 덮어쓰지 않고 연결만 합니다. 딜은 미팅 화면에서 초안으로 만들고, 승인한 내용만 HubSpot에 보냅니다.</p>
      {!ok ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip !text-[var(--color-ember)]">권한 필요</span>
          <span className="text-[13px]">회사·딜 권한이 없는 연결입니다.</span>
          <button className="btn btn-ink !min-h-9 text-[13px]" onClick={reconnect}>다시 연결</button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-signal !min-h-9 text-[13px]" onClick={syncCompanies} disabled={busy} data-testid="hubspot-company-sync">{busy ? "동기화 중…" : "회사 동기화"}</button>
            <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => setEdit(edit === "company" ? null : "company")}>회사 필드 매핑</button>
            <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => setEdit(edit === "deal" ? null : "deal")}>딜 필드·파이프라인 매핑</button>
          </div>
          {s && !edit && (
            <p className="text-[12.5px] text-[var(--fg-mute)]">
              파이프라인 <code>{s.deal.pipeline.pipeline}</code> · {s.stages.map((st: any) => `${st.label}→${s.deal.pipeline.stages[st.id]}`).join(" · ")}
            </p>
          )}
          {s && edit && <ObjectMappingEditor key={edit} object={edit} settings={s} onSaved={setS} />}
        </>
      )}
      {msg && <p className="text-[13px]" role="status">{msg}</p>}
    </Section>
  );
}

function ObjectMappingEditor({ object, settings, onSaved }: { object: "company" | "deal"; settings: any; onSaved: (s: any) => void }) {
  const cfg = settings[object];
  const labels = object === "company" ? COMPANY_LOCAL : DEAL_LOCAL;
  const [rows, setRows] = useState<{ local: string; remote: string }[]>(cfg.entries);
  const [pipeline, setPipeline] = useState<string>(object === "deal" ? cfg.pipeline.pipeline : "");
  const [stages, setStages] = useState<Record<string, string>>(object === "deal" ? cfg.pipeline.stages : {});
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const save = async () => {
    setErr(null);
    setOk(false);
    try {
      const r = await api("/integrations/hubspot/deal-settings", { method: "PUT", offline: false, body: { object, entries: rows.filter((x) => x.remote), ...(object === "deal" ? { pipeline: { pipeline, stages } } : {}) } });
      onSaved(r);
      setOk(true);
    } catch (e) {
      const d = (e as { details?: string[] }).details;
      setErr(Array.isArray(d) ? d.join(", ") : (e as Error).message);
    }
  };
  return (
    <div className="space-y-2" aria-label={object === "company" ? "회사 필드 매핑" : "딜 필드 매핑"}>
      <p className="text-[12.5px] text-[var(--fg-mute)]">{cfg.isDefault ? "기본 매핑 사용 중" : "사용자 매핑"} · 비어 있는 값은 보내지 않습니다.{object === "deal" ? " pipeline·dealstage 는 아래 단계 매핑으로 정해집니다." : ""}</p>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <select className="field !min-h-9 text-[13px]" value={r.local} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, local: e.target.value } : x)))} aria-label="LINKOS 필드">
            {cfg.localFields.map((k: string) => <option key={k} value={k}>{labels[k] ?? k}</option>)}
          </select>
          <Icon name="arrow" size={14} className="shrink-0 opacity-50" />
          <input className="field !min-h-9 text-[13px]" value={r.remote} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, remote: e.target.value } : x)))} aria-label="HubSpot 속성" />
          <button aria-label="행 삭제" className="shrink-0 text-[var(--fg-mute)]" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => setRows([...rows, { local: cfg.localFields[0], remote: "" }])}><Icon name="plus" size={14} />필드 추가</button>
        <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => { setRows(cfg.defaults); if (object === "deal") { setPipeline(cfg.defaultPipeline.pipeline); setStages(cfg.defaultPipeline.stages); } }}>기본값으로</button>
      </div>
      {object === "deal" && (
        <div className="space-y-2 rounded-[14px] border border-[var(--line)] p-3">
          <label className="block text-[13px]">HubSpot 파이프라인 ID
            <input className="field !min-h-9 text-[13px]" value={pipeline} onChange={(e) => setPipeline(e.target.value)} />
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {settings.stages.map((st: any) => (
              <label key={st.id} className="block text-[13px]">LINKOS ‘{st.label}’ → HubSpot 단계 ID
                <input className="field !min-h-9 text-[13px]" value={stages[st.id] ?? ""} onChange={(e) => setStages({ ...stages, [st.id]: e.target.value })} />
              </label>
            ))}
          </div>
        </div>
      )}
      <button className="btn btn-signal !min-h-9 text-[13px]" onClick={save}>매핑 저장</button>
      {err && <p className="text-[13px] text-[var(--color-ember)]" role="alert">{err}</p>}
      {ok && <p className="text-[13px]" role="status">저장했어요.</p>}
    </div>
  );
}
