"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/client";

// F-008 B2B SSO: SAML 2.0 IdP configuration + org policy sso_required (enforcement)

const NAMEID_FORMATS = [
  ["urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", "emailAddress (권장)"],
  ["urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", "persistent"],
  ["urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified", "unspecified"],
  ["urn:oasis:names:tc:SAML:2.0:nameid-format:transient", "transient"],
] as const;

interface CertInfo {
  fingerprint256: string;
  subject: string;
  notAfter: string;
  expired: boolean;
}
interface SamlConfig {
  configured: boolean;
  enabled: boolean;
  idpEntityId: string | null;
  ssoUrl: string | null;
  certificates: CertInfo[];
  nameIdFormat: string;
  emailAttribute: string | null;
  nameAttribute: string | null;
  defaultRole: string;
  sp: { entityId: string; acsUrl: string; metadataUrl: string };
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[12.5px] text-[var(--fg-mute)]">{label}</span>
      <code className="min-w-0 flex-1 truncate text-[12.5px]" title={value}>{value}</code>
      <button
        type="button"
        className="btn btn-ghost !min-h-8 shrink-0 text-[12px]"
        aria-label={`${label} 복사`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <Icon name={copied ? "check" : "link"} size={14} />
        {copied ? "복사됨" : "복사"}
      </button>
    </div>
  );
}

export function SamlSettings({ orgId, domains, ssoRequired, ssoAvailable, run }: {
  orgId: string;
  domains: string[];
  ssoRequired: boolean;
  ssoAvailable: boolean;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
}) {
  const [cfg, setCfg] = useState<SamlConfig | null>(null);
  const [form, setForm] = useState({ metadataXml: "", idpEntityId: "", ssoUrl: "", certificates: "", nameIdFormat: NAMEID_FORMATS[0][0] as string, emailAttribute: "", nameAttribute: "", enabled: false, defaultRole: "member" });
  const load = () =>
    api<SamlConfig>(`/orgs/${orgId}/sso/saml`)
      .then((c) => {
        setCfg(c);
        if (c.configured)
          setForm((f) => ({ ...f, metadataXml: "", certificates: "", idpEntityId: c.idpEntityId ?? "", ssoUrl: c.ssoUrl ?? "", nameIdFormat: c.nameIdFormat, emailAttribute: c.emailAttribute ?? "", nameAttribute: c.nameAttribute ?? "", enabled: c.enabled, defaultRole: c.defaultRole }));
      })
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, [orgId]);

  const save = () =>
    run(async () => {
      await api(`/orgs/${orgId}/sso/saml`, {
        method: "PUT",
        body: {
          ...form,
          metadataXml: form.metadataXml.trim() || null,
          // a pasted metadata XML supplies entityID / SSO URL / certs unless the fields are filled explicitly
          idpEntityId: form.metadataXml.trim() && form.idpEntityId === (cfg?.idpEntityId ?? "") ? null : form.idpEntityId || null,
          ssoUrl: form.metadataXml.trim() && form.ssoUrl === (cfg?.ssoUrl ?? "") ? null : form.ssoUrl || null,
          certificates: form.certificates.trim() || null,
          emailAttribute: form.emailAttribute || null,
          nameAttribute: form.nameAttribute || null,
        },
      });
      await load();
    }, "SAML 설정을 저장했어요.");

  const toggleEnforcement = (next: boolean) => {
    if (next && !window.confirm("SSO 강제를 켜면 회사 도메인 사용자의 이메일 코드·Google·패스키 세션이 즉시 로그아웃됩니다. 계속할까요?")) return;
    void run(
      () => api(`/orgs/${orgId}/sso/enforcement`, { method: "PUT", body: { ssoRequired: next } }),
      next ? "SSO 강제를 켰어요. 회사 도메인 사용자의 비-SSO 세션을 로그아웃했습니다." : "SSO 강제를 껐어요.",
    );
  };

  return (
    <>
      <section className="surface space-y-3 p-5" aria-labelledby="saml-title">
        <h2 id="saml-title" className="flex items-center gap-2 text-[17px] font-semibold"><Icon name="lock" size={19} />SSO (SAML 2.0)</h2>
        <p className="text-[13px] text-[var(--fg-mute)]">
          Okta · Entra ID · Google Workspace 등 IdP에 아래 SP 정보를 등록하고, IdP 메타데이터 XML을 붙여넣거나 값을 직접 입력하세요. 서명된 응답만 받으며, 인증된 회사 도메인 이메일만 로그인할 수 있어요.
        </p>
        {cfg && (
          <div className="space-y-1 rounded-2xl border border-[var(--line)] p-3">
            <CopyRow label="Entity ID" value={cfg.sp.entityId} />
            <CopyRow label="ACS URL" value={cfg.sp.acsUrl} />
            <CopyRow label="메타데이터" value={cfg.sp.metadataUrl} />
          </div>
        )}
        <label className="block text-[13px]">
          <span className="label">IdP 메타데이터 XML (선택 — 붙여넣으면 아래 값을 채웁니다)</span>
          <textarea className="field min-h-24 font-mono text-[12px]" value={form.metadataXml} onChange={(e) => setForm({ ...form, metadataXml: e.target.value })} placeholder={'<md:EntityDescriptor entityID="https://idp.company.com/…">'} />
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className="field" placeholder="IdP Entity ID" value={form.idpEntityId} onChange={(e) => setForm({ ...form, idpEntityId: e.target.value })} aria-label="IdP Entity ID" />
          <input className="field" placeholder="IdP SSO URL (HTTP-Redirect, https://)" value={form.ssoUrl} onChange={(e) => setForm({ ...form, ssoUrl: e.target.value })} aria-label="IdP SSO URL" />
          <select className="field" value={form.nameIdFormat} onChange={(e) => setForm({ ...form, nameIdFormat: e.target.value })} aria-label="NameID 형식">
            {NAMEID_FORMATS.map(([v, l]) => <option key={v} value={v}>NameID: {l}</option>)}
          </select>
          <select className="field" value={form.defaultRole} onChange={(e) => setForm({ ...form, defaultRole: e.target.value })} aria-label="SAML 기본 역할">
            <option value="member">기본 역할: Member</option>
            <option value="viewer">기본 역할: Viewer</option>
            <option value="manager">기본 역할: Manager</option>
          </select>
          <input className="field" placeholder="이메일 속성 (비우면 email/mail/NameID)" value={form.emailAttribute} onChange={(e) => setForm({ ...form, emailAttribute: e.target.value })} aria-label="이메일 속성 이름" />
          <input className="field" placeholder="이름 속성 (비우면 displayName/name)" value={form.nameAttribute} onChange={(e) => setForm({ ...form, nameAttribute: e.target.value })} aria-label="이름 속성 이름" />
        </div>
        <label className="block text-[13px]">
          <span className="label">IdP 서명 인증서 (PEM — 교체 기간에는 기존·새 인증서를 함께 붙여넣기, 비우면 현재 인증서 유지)</span>
          <textarea className="field min-h-24 font-mono text-[12px]" value={form.certificates} onChange={(e) => setForm({ ...form, certificates: e.target.value })} placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"} />
        </label>
        {cfg?.certificates.length ? (
          <ul className="space-y-1 text-[12.5px]">
            {cfg.certificates.map((c) => (
              <li key={c.fingerprint256} className="flex flex-wrap items-center gap-2">
                <span className="chip">{c.expired ? "만료됨" : "유효"}</span>
                <code title={c.fingerprint256}>SHA-256 {c.fingerprint256.slice(0, 23)}…</code>
                <span className="text-[var(--fg-mute)]">~ {new Date(c.notAfter).toLocaleDateString("ko-KR")}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />SAML SSO 사용</label>
        <button className="btn btn-ink" onClick={save}>SAML 저장</button>
      </section>

      <section className="surface space-y-3 p-5" aria-labelledby="sso-enforce-title">
        <h2 id="sso-enforce-title" className="flex items-center gap-2 text-[17px] font-semibold"><Icon name="lock" size={19} />SSO 강제</h2>
        <p className="rounded-2xl border border-[var(--color-ember)]/40 bg-[var(--color-ember)]/10 p-3 text-[13px]">
          켜면 인증된 도메인{domains.length ? ` (${domains.join(", ")})` : ""} 이메일은 이메일 코드 · Google · 패스키로 로그인할 수 없고 회사 SSO만 사용합니다. 해당 사용자의 기존 비-SSO 세션은 즉시 로그아웃됩니다.
          IdP 장애에 대비해 <b>Owner는 이메일 코드 로그인(break-glass)</b>을 계속 사용할 수 있어요.
        </p>
        {!ssoAvailable && <p className="text-[13px] text-[var(--fg-mute)]">먼저 OIDC 또는 SAML 연결을 저장하고 “사용”을 켜세요.</p>}
        <label className="flex items-center gap-2 text-[14px]">
          <input type="checkbox" checked={ssoRequired} disabled={!ssoAvailable && !ssoRequired} onChange={(e) => toggleEnforcement(e.target.checked)} />
          회사 도메인 사용자는 SSO로만 로그인
        </label>
      </section>
    </>
  );
}
