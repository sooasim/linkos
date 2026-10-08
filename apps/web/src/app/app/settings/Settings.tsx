"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PushSettings } from "@/components/PushSettings";
import { api, relTime } from "@/lib/client";

const EXPORT_FIELDS = [
  ["fullName", "이름"],
  ["company", "회사"],
  ["jobTitle", "직책"],
  ["department", "부서"],
  ["email", "이메일"],
  ["phone", "전화"],
  ["address", "주소"],
  ["website", "웹사이트"],
  ["tags", "태그"],
  ["lastContactAt", "최근 연락"],
  ["source", "출처"],
] as const;
const FORMATS = [
  ["xlsx", "Excel"],
  ["docx", "Word"],
  ["csv", "CSV"],
  ["vcard", "vCard"],
  ["txt", "TXT"],
  ["json", "JSON"],
  ["pdf", "PDF"],
] as const;

function Section({ title, icon, children }: { title: string; icon: Parameters<typeof Icon>[0]["name"]; children: React.ReactNode }) {
  return (
    <section className="surface space-y-4 p-5">
      <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Icon name={icon} size={19} />{title}</h2>
      {children}
    </section>
  );
}

export function Settings() {
  const router = useRouter();
  const [integ, setInteg] = useState<any>(null);
  const [devices, setDevices] = useState<any[]>([]);
  const [me, setMe] = useState<any>(null);
  const [fmt, setFmt] = useState<string>("xlsx");
  const [fields, setFields] = useState<string[]>(["fullName", "company", "jobTitle", "email", "phone"]);
  const [nfc, setNfc] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ url: string; rows: number } | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [drive, setDrive] = useState<{ url: string; name: string } | null>(null);

  const load = () => {
    api("/integrations").then(setInteg).catch(() => undefined);
    api<{ devices: any[] }>("/me/devices").then((r) => setDevices(r.devices));
    api("/me").then(setMe);
  };
  useEffect(() => {
    load();
    try {
      setNfc(localStorage.getItem("lk_nfc_accessory") === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const google = integ?.accounts?.find((a: any) => a.provider === "google");
  const connectGoogle = async (purpose: string) => {
    const r = await api<{ url: string }>("/integrations/google/connect", { body: { purpose } });
    window.location.href = r.url;
  };
  const saveDrive = async () => {
    setDrive(null);
    try {
      setDrive(await api<{ url: string; name: string }>("/integrations/google/drive", { body: { format: fmt, fields } }));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const marketing = me?.consents?.find((c: any) => c.consent_type === "marketing")?.granted ?? false;

  const doExport = async () => {
    const r = await api<{ downloadUrl: string }>("/exports", { body: { format: fmt, fields } });
    window.location.href = r.downloadUrl;
  };
  const exportMine = async () => {
    const r = await api<{ data: unknown }>("/me/privacy/export", { body: {} });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" }));
    a.download = "linkos-my-data.json";
    a.click();
  };
  const deleteAccount = async () => {
    if (!confirm("계정을 삭제할까요? 7일 후 모든 데이터가 영구 삭제되며, 그 전까지 로그인할 수 없습니다.")) return;
    await api("/me/privacy/delete", { body: {} });
    router.replace("/");
  };

  return (
    <div className="space-y-4">
      <Section title="Google 연락처" icon="link">
        {!integ ? null : !integ.googleConfigured ? (
          <p className="text-[14px] text-[var(--fg-mute)]">서버에 Google OAuth(GOOGLE_CLIENT_ID)가 설정되지 않았습니다.</p>
        ) : google?.status === "active" ? (
          <>
            <p className="text-[14px]">연결됨 · 연락처는 변경될 때마다 자동으로 동기화됩니다(덮어쓰기 충돌 시 중단).</p>
            <div className="flex gap-2">
              <button className="btn btn-signal" onClick={async () => { const r = await api<{ queued: number }>("/integrations/google/contacts/sync", { body: {} }); setMsg(`${r.queued}건 동기화 대기열에 추가`); load(); }}>지금 동기화</button>
              <button className="btn btn-ghost" onClick={() => api("/integrations/google", { method: "DELETE" }).then(load)}>연결 해제</button>
            </div>
            {integ.jobs.length > 0 && (
              <ul className="space-y-1 text-[13px] text-[var(--fg-mute)]">
                {integ.jobs.slice(0, 5).map((j: any) => <li key={j.id}>{j.status} · 시도 {j.attempt_count} {j.last_error ? `· ${j.last_error}` : ""} · {relTime(j.scheduled_at)}</li>)}
              </ul>
            )}
          </>
        ) : (
          <button className="btn btn-ink" onClick={async () => { const r = await api<{ url: string }>("/integrations/google/connect", { body: { purpose: "contacts" } }); window.location.href = r.url; }}>Google 계정 연결</button>
        )}
        {msg && <p className="text-[13.5px]" role="status">{msg}</p>}
      </Section>

      <Section title="내보내기" icon="download">
        <div className="flex flex-wrap gap-2">
          {FORMATS.map(([v, l]) => <button key={v} onClick={() => setFmt(v)} className={`chip ${fmt === v ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>{l}</button>)}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {EXPORT_FIELDS.map(([k, l]) => (
            <label key={k} className="flex items-center gap-2 text-[14px]">
              <input type="checkbox" className="size-4" checked={fields.includes(k)} onChange={(e) => setFields(e.target.checked ? [...fields, k] : fields.filter((x) => x !== k))} />
              {l}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-signal" onClick={doExport} disabled={!fields.length} data-testid="export-file">파일로 내보내기</button>
          {integ?.googleConfigured && (integ.sheetsConnected ? (
            <button className="btn btn-ink" disabled={!fields.length || sheetBusy} data-testid="export-sheets" onClick={async () => {
              setSheetBusy(true);
              setSheet(null);
              try {
                const r = await api<{ url: string; rows: number }>("/integrations/google/sheets/export", { body: { fields } });
                setSheet({ url: r.url, rows: r.rows });
              } catch (e) {
                setMsg((e as Error).message);
              } finally {
                setSheetBusy(false);
              }
            }}>{sheetBusy ? "Sheets 만드는 중…" : "Google Sheets로 내보내기"}</button>
          ) : (
            <button className="btn btn-ghost" onClick={async () => { const r = await api<{ url: string }>("/integrations/google/connect", { body: { purpose: "sheets" } }); window.location.href = r.url; }}>Google Sheets 권한 연결</button>
          ))}
        </div>
        {integ?.googleConfigured && (integ.google?.drive ? (
          <button className="btn btn-ghost" disabled={!fields.length} data-testid="export-drive" onClick={saveDrive}>Google Drive에 저장</button>
        ) : (
          <button className="btn btn-ghost" onClick={() => connectGoogle("drive")}>Google Drive 권한 연결</button>
        ))}
        {drive && <p className="text-[14px]" role="status">Drive의 LINKOS 폴더에 {drive.name} 저장 · <a className="font-semibold underline" href={drive.url} target="_blank" rel="noopener noreferrer">열기</a></p>}
        {sheet && <p className="text-[14px]" role="status">{sheet.rows}명을 새 스프레드시트에 저장했어요 · <a className="font-semibold underline" href={sheet.url} target="_blank" rel="noopener noreferrer">열기</a></p>}
        <p className="text-[12.5px] text-[var(--fg-mute)]">Google Sheets는 LINKOS가 만든 파일에만 접근하는 최소 권한(drive.file)을 사용하며, 값은 수식으로 실행되지 않게 저장됩니다.</p>
      </Section>

      <Section title="메일 · 캘린더 권한" icon="mail">
        {!integ ? null : !integ.googleConfigured ? (
          <p className="text-[14px] text-[var(--fg-mute)]">Google OAuth가 설정되지 않아 메일은 LINKOS 메일(SMTP) 또는 메일 앱으로, 일정은 .ics 파일로 보냅니다.</p>
        ) : (
          <ul className="space-y-2 text-[14px]">
            {([
              ["gmail", "Gmail 발송 · 초안", integ.google?.gmailSend && integ.google?.gmailDrafts],
              ["calendar", "Google Calendar 일정 · 빈 시간", integ.google?.calendar],
              ["drive", "Google Drive 파일 저장 (LINKOS가 만든 파일만)", integ.google?.drive],
            ] as const).map(([purpose, label, on]) => (
              <li key={purpose} className="flex items-center justify-between gap-3">
                <span>{label}</span>
                {on ? <span className="chip">연결됨</span> : <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => connectGoogle(purpose)}>권한 연결</button>}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12.5px] text-[var(--fg-mute)]">메일은 항상 직접 확인·승인한 뒤에만 발송되고, 일정은 승인한 것만 캘린더에 등록됩니다. Outlook·CRM은 아래 연동 화면에서 연결하세요.</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/app/messages" className="btn btn-ghost !min-h-10 text-[14px]"><Icon name="mail" size={16} />메시지·템플릿</Link>
          <Link href="/app/calendar" className="btn btn-ghost !min-h-10 text-[14px]"><Icon name="calendar" size={16} />일정·예약 링크</Link>
          <Link href="/app/integrations" className="btn btn-ghost !min-h-10 text-[14px]"><Icon name="link" size={16} />CRM·웹훅</Link>
        </div>
      </Section>

      <Section title="알림" icon="bolt">
        <PushSettings />
      </Section>

      <Section title="교환 채널" icon="nfc">
        <label className="flex items-center gap-3 text-[14.5px]">
          <input type="checkbox" className="size-5" checked={nfc} onChange={(e) => { setNfc(e.target.checked); try { localStorage.setItem("lk_nfc_accessory", e.target.checked ? "1" : "0"); } catch { /* ignore */ } }} />
          NFC 카드·스티커를 가지고 있어요 (교환 사다리에 NFC 단계 추가)
        </label>
        <p className="text-[13px] text-[var(--fg-mute)]">브라우저끼리 폰을 맞대 직접 전송하는 기능은 제공하지 않습니다. 웹에서는 공유 시트 → NFC 태그 → 단축코드 → QR 순서로 연결합니다.</p>
      </Section>

      <Section title="개인정보 · 동의" icon="lock">
        <label className="flex items-center gap-3 text-[14.5px]">
          <input type="checkbox" className="size-5" checked={marketing} onChange={async (e) => { await api("/me/consents", { method: "PATCH", body: { type: "marketing", granted: e.target.checked } }); load(); }} />
          마케팅 정보 수신 (선택)
        </label>
        <ul className="text-[13px] text-[var(--fg-mute)]">
          {(me?.consents ?? []).map((c: any) => <li key={c.consent_type}>{c.consent_type} · {c.granted ? "동의" : "거부"} · 정책 {c.policy_version}</li>)}
        </ul>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost" onClick={exportMine}>내 데이터 받기 (JSON)</button>
          <button className="btn btn-ghost !border-[var(--color-ember)] text-[var(--color-ember)]" onClick={deleteAccount}>계정 삭제</button>
        </div>
      </Section>

      <Section title="로그인된 기기" icon="settings">
        <ul className="space-y-2">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center justify-between text-[14px]">
              <span>{d.device_label} · {relTime(d.last_used_at)}</span>
              <button className="text-[13px] text-[var(--color-ember)]" onClick={() => api(`/me/devices/${d.id}`, { method: "DELETE" }).then(load)}>로그아웃</button>
            </li>
          ))}
        </ul>
        <button className="btn btn-ink" onClick={async () => { await api("/auth/logout", { body: {} }); router.replace("/"); router.refresh(); }}>
          <Icon name="logout" size={17} /> 이 기기에서 로그아웃
        </button>
      </Section>
    </div>
  );
}
