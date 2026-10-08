"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { api, relTime } from "@/lib/client";
import type { OrgInfo } from "../activeOrg";
import { DangerZone } from "./DangerZone";
import { SamlSettings } from "./SamlSettings";

function Section({ title, icon, children, note }: { title: string; icon: Parameters<typeof Icon>[0]["name"]; children: React.ReactNode; note?: string }) {
  return (
    <section className="surface space-y-3 p-5">
      <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Icon name={icon} size={19} />{title}</h2>
      {note && <p className="text-[13px] text-[var(--fg-mute)]">{note}</p>}
      {children}
    </section>
  );
}

const ROLES = ["owner", "admin", "manager", "member", "viewer"] as const;

// F-138 브랜딩 · F-004 도메인 · F-139 정책 · F-136 보존 · F-008 SSO/SCIM · F-140 API 키 · 감사 로그 · F-129 조직 삭제(Owner)
export function OrgSettings({ org }: { org: OrgInfo }) {
  const id = org.id;
  const [msg, setMsg] = useState<string | null>(null);
  const [brand, setBrand] = useState({ logoUrl: org.branding.logoUrl ?? "", primaryColor: org.branding.primaryColor ?? "#C8F03C", showOnMemberCards: !!org.branding.showOnMemberCards, displayName: org.branding.displayName ?? "" });
  const [domains, setDomains] = useState<string[]>(org.domains ?? []);
  const [domain, setDomain] = useState("");
  const [joinMode, setJoinMode] = useState(org.domainJoinMode ?? "off");
  const [pol, setPol] = useState<any>(org.policies ?? {});
  const [ret, setRet] = useState<any>(org.retention ?? {});
  const [preview, setPreview] = useState<any>(null);
  const [sso, setSso] = useState<any>(null);
  const [ssoForm, setSsoForm] = useState({ issuer: "", clientId: "", clientSecret: "", enabled: false, defaultRole: "member" });
  const [scimToken, setScimToken] = useState<string | null>(null);
  const [keys, setKeys] = useState<any[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyForm, setKeyForm] = useState({ name: "", scopes: ["contacts:read"] as string[] });
  const [logs, setLogs] = useState<any[]>([]);

  const loadSide = () => {
    api(`/orgs/${id}/retention`).then(setPreview).catch(() => undefined);
    api(`/orgs/${id}/sso`).then((s: any) => {
      setSso(s);
      if (s.configured) setSsoForm((f) => ({ ...f, issuer: s.issuer, clientId: s.clientId, enabled: s.enabled, defaultRole: s.defaultRole }));
    }).catch(() => undefined);
    api<{ keys: any[] }>(`/orgs/${id}/api-keys`).then((r) => setKeys(r.keys)).catch(() => undefined);
    api<{ logs: any[] }>(`/orgs/${id}/audit`).then((r) => setLogs(r.logs)).catch(() => undefined);
  };
  useEffect(loadSide, [id]);
  const run = async (fn: () => Promise<unknown>, ok = "저장했어요.") => {
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      loadSide();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      {msg && <p role="status" className="surface sticky top-2 z-10 p-3 text-[14px]">{msg}</p>}

      <Section title="브랜딩" icon="layers" note="켜면 멤버의 Living Card 상단에 조직 로고/색이 표시됩니다(멤버가 개별로 끌 수 있음).">
        <div className="grid gap-2 sm:grid-cols-2">
          <input className="field" placeholder="표시 이름 (기본: 조직 이름)" value={brand.displayName} onChange={(e) => setBrand({ ...brand, displayName: e.target.value })} aria-label="브랜드 표시 이름" />
          <label className="text-[13px]">
            <span className="label">로고 (PNG/SVG/WebP, 40KB 이하 — 카드에 인라인 저장)</span>
            <input
              type="file"
              accept="image/png,image/svg+xml,image/webp,image/jpeg"
              className="text-[13px]"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 40_000) return setMsg("로고는 40KB 이하만 가능합니다.");
                const r = new FileReader();
                r.onload = () => setBrand((b) => ({ ...b, logoUrl: String(r.result) }));
                r.readAsDataURL(f);
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-[14px]">
            <input type="color" value={brand.primaryColor} onChange={(e) => setBrand({ ...brand, primaryColor: e.target.value })} aria-label="브랜드 색" /> {brand.primaryColor}
          </label>
          <label className="flex items-center gap-2 text-[14px]">
            <input type="checkbox" checked={brand.showOnMemberCards} onChange={(e) => setBrand({ ...brand, showOnMemberCards: e.target.checked })} /> 멤버 카드에 표시
          </label>
        </div>
        <button className="btn btn-ink" onClick={() => run(() => api(`/orgs/${id}`, { method: "PATCH", body: { branding: { ...brand, logoUrl: brand.logoUrl || null, displayName: brand.displayName || null } } }))}>브랜딩 저장</button>
      </Section>

      <Section title="회사 도메인 · 자동 가입" icon="globe" note="본인 로그인 이메일(인증됨)과 같은 회사 도메인만 등록됩니다. 공용 메일 도메인은 불가.">
        <div className="flex flex-wrap gap-2">
          {domains.map((d) => (
            <span key={d} className="chip">
              {d}
              <button aria-label={`${d} 삭제`} onClick={() => run(async () => { await api(`/orgs/${id}/domains?domain=${encodeURIComponent(d)}`, { method: "DELETE" }); setDomains(domains.filter((x) => x !== d)); })}><Icon name="x" size={12} /></button>
            </span>
          ))}
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api<{ domain: string }>(`/orgs/${id}/domains`, { body: { domain } }); setDomains([...new Set([...domains, r.domain])]); setDomain(""); }, "도메인을 인증했어요."); }}>
          <input className="field flex-1" placeholder="company.com" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="도메인" />
          <button className="btn btn-ink">추가</button>
        </form>
        <label className="label" htmlFor="joinmode">같은 도메인 사용자의 가입</label>
        <select id="joinmode" className="field" value={joinMode} onChange={(e) => { setJoinMode(e.target.value); run(() => api(`/orgs/${id}`, { method: "PATCH", body: { domainJoinMode: e.target.value } })); }}>
          <option value="off">초대 링크로만</option>
          <option value="auto">자동 합류 (Member)</option>
          <option value="approval">가입 요청 → 관리자 승인</option>
        </select>
      </Section>

      <Section title="정책 강제" icon="lock">
        <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" checked={!!pol.requireAllPartyRecordingConsent} onChange={(e) => setPol({ ...pol, requireAllPartyRecordingConsent: e.target.checked })} />녹음 시 모든 참석자 동의(all-party) 필수</label>
        <fieldset className="text-[14px]">
          <legend className="label">내보내기 금지 역할</legend>
          <div className="flex flex-wrap gap-3">
            {ROLES.filter((r) => r !== "owner").map((r) => (
              <label key={r} className="flex items-center gap-1"><input type="checkbox" checked={(pol.blockExportRoles ?? []).includes(r)} onChange={(e) => setPol({ ...pol, blockExportRoles: e.target.checked ? [...(pol.blockExportRoles ?? []), r] : (pol.blockExportRoles ?? []).filter((x: string) => x !== r) })} />{r}</label>
            ))}
          </div>
        </fieldset>
        <label className="label" htmlFor="minvis">멤버 카드의 이메일/전화 최소 공개범위</label>
        <select id="minvis" className="field" value={pol.minFieldVisibility ?? ""} onChange={(e) => setPol({ ...pol, minFieldVisibility: e.target.value || null })}>
          <option value="">제한 없음</option>
          <option value="business">Business 이상 (공개 금지)</option>
          <option value="trusted">Trusted 이상</option>
        </select>
        <label className="label" htmlFor="graphexp">Who Knows Whom 개인 인맥 노출</label>
        <select id="graphexp" className="field" value={pol.graphPersonalExposure ?? "company_level"} onChange={(e) => setPol({ ...pol, graphPersonalExposure: e.target.value })}>
          <option value="company_level">회사 단위 집계만 (이름 비공개)</option>
          <option value="shared_only">팀에 공유된 연락처만</option>
        </select>
        <button className="btn btn-ink" onClick={() => run(() => api(`/orgs/${id}/policies`, { method: "PUT", body: pol }))}>정책 저장</button>
      </Section>

      <Section title="데이터 보존" icon="trash" note="워커가 주기적으로 적용하고, 삭제 건수는 감사 로그에 남습니다. 공유된 개인 연락처는 삭제되지 않고 공유만 해제됩니다.">
        <div className="grid gap-2 sm:grid-cols-3">
          {[
            ["inactiveContactDays", "휴면 팀 연락처(일)"],
            ["teamNoteDays", "팀 메모(일)"],
            ["auditLogDays", "감사 로그(일, ≥365)"],
          ].map(([k = "", l]) => (
            <label key={k} className="text-[13px]">
              <span className="label">{l}</span>
              <input className="field" type="number" min={30} value={ret[k] ?? ""} onChange={(e) => setRet({ ...ret, [k]: e.target.value ? Number(e.target.value) : null })} />
            </label>
          ))}
        </div>
        {preview && (
          <p className="text-[13px] text-[var(--fg-mute)]">
            현재 정책 적용 시: 회사 리드 {preview.wouldDelete.companyLeads}건·팀 메모 {preview.wouldDelete.teamNotes}건·감사 로그 {preview.wouldDelete.auditLogs}건 삭제, 개인 연락처 {preview.wouldUnshare.personalContacts}건 공유 해제
          </p>
        )}
        <button className="btn btn-ink" onClick={() => run(() => api(`/orgs/${id}/retention`, { method: "PUT", body: ret }))}>보존 정책 저장</button>
      </Section>

      <Section title="SSO (OIDC) · SCIM" icon="lock" note="인증된 회사 도메인 이메일만 SSO로 로그인할 수 있어요. SAML 2.0은 아래에서 설정합니다(둘 다 켜면 OIDC가 우선).">
        {sso && (
          <dl className="grid gap-1 text-[12.5px] text-[var(--fg-mute)]">
            <div>Redirect URI: <code>{sso.redirectUri}</code></div>
            <div>로그인 URL: <code>{sso.loginUrl}</code></div>
            <div>SCIM Base URL: <code>{sso.scimBaseUrl}</code></div>
          </dl>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <input className="field" placeholder="Issuer (https://idp.company.com)" value={ssoForm.issuer} onChange={(e) => setSsoForm({ ...ssoForm, issuer: e.target.value })} aria-label="Issuer" />
          <input className="field" placeholder="Client ID" value={ssoForm.clientId} onChange={(e) => setSsoForm({ ...ssoForm, clientId: e.target.value })} aria-label="Client ID" />
          <input className="field" type="password" placeholder={sso?.hasClientSecret ? "Client secret (저장됨 — 바꿀 때만 입력)" : "Client secret"} value={ssoForm.clientSecret} onChange={(e) => setSsoForm({ ...ssoForm, clientSecret: e.target.value })} aria-label="Client secret" />
          <select className="field" value={ssoForm.defaultRole} onChange={(e) => setSsoForm({ ...ssoForm, defaultRole: e.target.value })} aria-label="SSO 기본 역할">
            <option value="member">기본 역할: Member</option>
            <option value="viewer">기본 역할: Viewer</option>
            <option value="manager">기본 역할: Manager</option>
          </select>
          <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" checked={ssoForm.enabled} onChange={(e) => setSsoForm({ ...ssoForm, enabled: e.target.checked })} />SSO 사용</label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ink" onClick={() => run(() => api(`/orgs/${id}/sso`, { method: "PUT", body: { ...ssoForm, clientSecret: ssoForm.clientSecret || null } }))}>SSO 저장</button>
          {(sso?.configured || sso?.saml?.configured) && <button className="btn btn-ghost" onClick={() => run(async () => setScimToken((await api<{ token: string }>(`/orgs/${id}/sso/scim-token`, { body: {} })).token), "새 SCIM 토큰을 발급했어요(이전 토큰은 무효).")}>SCIM 토큰 {sso.scimEnabled ? "재발급" : "발급"}</button>}
        </div>
        {scimToken && <p className="break-all rounded-2xl border border-dashed border-[var(--line)] p-3 text-[12.5px]"><b>지금 한 번만 표시:</b> <code>{scimToken}</code></p>}
      </Section>

      <SamlSettings
        orgId={id}
        domains={domains}
        ssoRequired={Boolean(sso?.ssoRequired)}
        ssoAvailable={Boolean((sso?.configured && sso?.enabled) || sso?.saml?.enabled)}
        run={run}
      />

      <Section title="API 키" icon="code" note="서버-서버 통합용. 키는 해시로만 저장되고 발급 시 한 번만 보여집니다. GET /api/v1/ext/contacts · /api/v1/ext/leads (Authorization: Bearer)">
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => setNewKey((await api<{ key: string }>(`/orgs/${id}/api-keys`, { body: keyForm })).key), "API 키를 발급했어요."); }}>
          <input className="field flex-1" placeholder="키 이름 (예: CRM 동기화)" value={keyForm.name} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} required aria-label="키 이름" />
          {["contacts:read", "leads:read", "leads:write"].map((s) => (
            <label key={s} className="flex items-center gap-1 text-[13px]"><input type="checkbox" checked={keyForm.scopes.includes(s)} onChange={(e) => setKeyForm({ ...keyForm, scopes: e.target.checked ? [...keyForm.scopes, s] : keyForm.scopes.filter((x) => x !== s) })} />{s}</label>
          ))}
          <button className="btn btn-ink" disabled={!keyForm.scopes.length}>발급</button>
        </form>
        {newKey && <p className="break-all rounded-2xl border border-dashed border-[var(--line)] p-3 text-[12.5px]"><b>지금 한 번만 표시:</b> <code>{newKey}</code></p>}
        <ul className="divide-y divide-[var(--line)] text-[13.5px]">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between py-2">
              <span>{k.name} · <code>lk_{k.prefix}_…</code> · {k.scopes.join(", ")} · <span className="text-[var(--fg-mute)]">{k.status}{k.last_used_at ? ` · 최근 사용 ${relTime(k.last_used_at)}` : ""}</span></span>
              {k.status === "active" && <button className="btn btn-ghost !min-h-8 text-[12px]" onClick={() => run(() => api(`/orgs/${id}/api-keys/${k.id}`, { method: "DELETE" }), "폐기했어요.")}>폐기</button>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="감사 로그" icon="eye">
        <ul className="max-h-80 divide-y divide-[var(--line)] overflow-y-auto text-[13px]">
          {logs.map((l) => (
            <li key={l.id} className="flex justify-between gap-3 py-1.5">
              <span><code>{l.action}</code> {l.actor ? `· ${l.actor}` : "· system"}</span>
              <span className="shrink-0 text-[var(--fg-mute)]">{relTime(l.created_at)}</span>
            </li>
          ))}
        </ul>
      </Section>

      {org.permissions.includes("org.delete") && <DangerZone orgId={id} orgName={org.name} />}
    </div>
  );
}
