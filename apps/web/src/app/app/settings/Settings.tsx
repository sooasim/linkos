"use client";
// UX-022 Google 연락처(권한 범위·재연결·작업 재시도) · UX-023/F-125 내보내기(기간·보고서) · F-137/F-166 내 활동 기록 · F-110 알림
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PushSettings } from "@/components/PushSettings";
import { api, relTime } from "@/lib/client";
import { ActivityLog } from "./ActivityLog";

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
const REPORT_FORMATS = ["csv", "xlsx", "json"];
const REPORTS = [
  ["contacts", "연락처"],
  ["meetings", "미팅 보고서"],
  ["relationships", "관계 보고서"],
] as const;
type Report = (typeof REPORTS)[number][0];
const PERIODS = [
  ["all", "전체"],
  ["30", "최근 30일"],
  ["90", "최근 90일"],
  ["365", "최근 1년"],
  ["custom", "직접 지정"],
] as const;
type Period = (typeof PERIODS)[number][0];
const SCOPE_LABEL: Record<string, string> = {
  "https://www.googleapis.com/auth/contacts": "연락처 읽기·쓰기",
  "https://www.googleapis.com/auth/drive.file": "Drive · Sheets (LINKOS가 만든 파일만)",
  "https://www.googleapis.com/auth/gmail.send": "Gmail 발송",
  "https://www.googleapis.com/auth/gmail.compose": "Gmail 초안",
  "https://www.googleapis.com/auth/calendar.events": "Calendar 일정",
  "https://www.googleapis.com/auth/calendar.freebusy": "Calendar 빈 시간",
};
const BASIC_SCOPES = new Set(["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"]);
const JOB_STATUS: Record<string, string> = { queued: "대기", retry: "재시도 예정", done: "완료", dead: "실패", conflict: "충돌", skipped: "건너뜀" };

/** since/until for the export API; custom dates are sent as YYYY-MM-DD (the server includes the whole `until` day). */
function periodRange(period: Period, from: string, to: string, now = Date.now()): { since?: string; until?: string } {
  if (period === "all") return {};
  if (period === "custom") return { ...(from ? { since: from } : {}), ...(to ? { until: to } : {}) };
  return { since: new Date(now - Number(period) * 864e5).toISOString() };
}

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
  const [report, setReport] = useState<Report>("contacts");
  const [period, setPeriod] = useState<Period>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exportMsg, setExportMsg] = useState<string | null>(null);

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
  const googleNeedsReauth = google?.status === "reauth_required";
  const grantedScopes: string[] = (google?.scopes ?? []).filter((sc: string) => !BASIC_SCOPES.has(sc));
  const googleJobs: any[] = (integ?.jobs ?? []).filter((j: any) => !j.provider || j.provider === "google");
  const retryJob = async (id: string) => {
    setMsg(null);
    try {
      const r = await api<{ status: string }>(`/integrations/jobs/${id}/retry`, { body: {} });
      setMsg(`다시 시도했어요 · ${JOB_STATUS[r.status] ?? r.status}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
    load();
  };
  const isReport = report !== "contacts";
  const customInvalid = period === "custom" && ((!from && !to) || (!!from && !!to && from > to));
  const exportBody = () => ({ format: fmt, fields, report, ...periodRange(period, from, to) });
  const connectGoogle = async (purpose: string) => {
    const r = await api<{ url: string }>("/integrations/google/connect", { body: { purpose } });
    window.location.href = r.url;
  };
  const saveDrive = async () => {
    setDrive(null);
    try {
      setDrive(await api<{ url: string; name: string }>("/integrations/google/drive", { body: exportBody() }));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const marketing = me?.consents?.find((c: any) => c.consent_type === "marketing")?.granted ?? false;

  const doExport = async () => {
    setExportMsg(null);
    try {
      const r = await api<{ downloadUrl: string }>("/exports", { body: exportBody() });
      window.location.href = r.downloadUrl;
    } catch (e) {
      setExportMsg((e as Error).message);
    }
  };
  const pickReport = (r: Report) => {
    setReport(r);
    if (r !== "contacts" && !REPORT_FORMATS.includes(fmt)) setFmt("csv");
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
        ) : google?.status === "active" || googleNeedsReauth ? (
          <>
            {googleNeedsReauth ? (
              <div className="space-y-2 rounded-[16px] border border-[var(--color-ember)] p-3" role="alert" data-testid="google-reauth">
                <p className="flex items-center gap-2 text-[14px] font-semibold"><span className="chip !text-[var(--color-ember)]">재연결 필요</span>Google 권한이 만료되었거나 해제되었어요.</p>
                <p className="text-[13px] text-[var(--fg-mute)]">다시 연결하면 실패한 동기화 작업을 이어서 다시 시도할 수 있어요. 그동안 Google 쪽 데이터는 변경되지 않습니다.</p>
                <button className="btn btn-ink !min-h-10" onClick={() => connectGoogle("contacts")}>Google 다시 연결</button>
              </div>
            ) : (
              <p className="text-[14px]">연결됨 · 연락처는 변경될 때마다 자동으로 동기화됩니다(덮어쓰기 충돌 시 중단).</p>
            )}
            {grantedScopes.length > 0 && (
              <div data-testid="google-scopes">
                <p className="label">허용한 권한</p>
                <ul className="flex flex-wrap gap-1.5">
                  {grantedScopes.map((sc) => <li key={sc} className="chip text-[12.5px]">{SCOPE_LABEL[sc] ?? sc}</li>)}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {!googleNeedsReauth && <button className="btn btn-signal" onClick={async () => { try { const r = await api<{ queued: number }>("/integrations/google/contacts/sync", { body: {} }); setMsg(`${r.queued}건 동기화 대기열에 추가`); } catch (e) { setMsg((e as Error).message); } load(); }}>지금 동기화</button>}
              <button className="btn btn-ghost" onClick={() => confirm("Google 연결을 해제할까요? 이미 동기화된 연락처는 양쪽에 그대로 남습니다.") && api("/integrations/google", { method: "DELETE" }).then(load)}>연결 해제</button>
            </div>
            {googleJobs.length > 0 && (
              <ul className="space-y-1.5 text-[13px]" aria-label="최근 동기화 작업">
                {googleJobs.slice(0, 5).map((j: any) => (
                  <li key={j.id} className="flex flex-wrap items-center gap-2 text-[var(--fg-mute)]">
                    <span className={`chip ${j.status === "dead" || j.status === "conflict" ? "!text-[var(--color-ember)]" : ""}`}>{JOB_STATUS[j.status] ?? j.status}</span>
                    <span>시도 {j.attempt_count}{j.last_error ? ` · ${j.last_error}` : ""} · {relTime(j.scheduled_at)}</span>
                    {j.status === "dead" && !googleNeedsReauth && <button className="btn btn-ghost !min-h-8 text-[12.5px]" onClick={() => retryJob(j.id)}>다시 시도</button>}
                    {j.status === "conflict" && <Link href="/app/sync" className="font-semibold text-[var(--accent-text)] underline">충돌 해결</Link>}
                  </li>
                ))}
              </ul>
            )}
            <Link href="/app/sync" className="inline-flex text-[13px] font-semibold text-[var(--accent-text)] underline">동기화 대기열 전체 보기</Link>
          </>
        ) : (
          <button className="btn btn-ink" onClick={async () => { const r = await api<{ url: string }>("/integrations/google/connect", { body: { purpose: "contacts" } }); window.location.href = r.url; }}>Google 계정 연결</button>
        )}
        {msg && <p className="text-[13.5px]" role="status">{msg}</p>}
      </Section>

      <Section title="내보내기" icon="download">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="내보낼 내용">
          {REPORTS.map(([v, l]) => <button key={v} role="radio" aria-checked={report === v} onClick={() => pickReport(v)} className={`chip ${report === v ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`} data-testid={`export-report-${v}`}>{l}</button>)}
        </div>
        {isReport && (
          <p className="text-[13px] text-[var(--fg-mute)]">
            {report === "meetings" ? "미팅마다 제목 · 날짜 · 상대 · 회사 · 목적 · 다음 미팅을 담습니다." : "연락처마다 관계 강도 · 만남 횟수 · 마지막 만남 · 최근 연락 · 다음 후속을 담습니다."} 기록된 사실만 포함하며 AI가 만든 문장은 넣지 않아요.
          </p>
        )}
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="파일 형식">
          {FORMATS.filter(([v]) => !isReport || REPORT_FORMATS.includes(v)).map(([v, l]) => <button key={v} role="radio" aria-checked={fmt === v} onClick={() => setFmt(v)} className={`chip ${fmt === v ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>{l}</button>)}
        </div>
        <fieldset className="space-y-2">
          <legend className="label">기간</legend>
          <div className="flex flex-wrap gap-2">
            {PERIODS.map(([v, l]) => (
              <label key={v} className={`chip cursor-pointer ${period === v ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
                <input type="radio" name="export-period" className="sr-only" value={v} checked={period === v} onChange={() => setPeriod(v)} />
                {l}
              </label>
            ))}
          </div>
          {period === "custom" && (
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              <label className="flex items-center gap-2">시작 <input type="date" className="field !w-auto !py-1.5" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="시작일" /></label>
              <span aria-hidden>~</span>
              <label className="flex items-center gap-2">종료 <input type="date" className="field !w-auto !py-1.5" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="종료일" /></label>
            </div>
          )}
          <p className="text-[12.5px] text-[var(--fg-mute)]">{report === "meetings" ? "미팅 날짜 기준" : "기간 안에 추가했거나 만난 연락처"}{customInvalid ? " · 시작일·종료일을 확인해 주세요." : ""}</p>
        </fieldset>
        {!isReport && (
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {EXPORT_FIELDS.map(([k, l]) => (
              <label key={k} className="flex items-center gap-2 text-[14px]">
                <input type="checkbox" className="size-4" checked={fields.includes(k)} onChange={(e) => setFields(e.target.checked ? [...fields, k] : fields.filter((x) => x !== k))} />
                {l}
              </label>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-signal" onClick={doExport} disabled={(!isReport && !fields.length) || customInvalid} data-testid="export-file">파일로 내보내기</button>
          {integ?.googleConfigured && !isReport && (integ.sheetsConnected ? (
            <button className="btn btn-ink" disabled={!fields.length || sheetBusy} data-testid="export-sheets" onClick={async () => {
              setSheetBusy(true);
              setSheet(null);
              try {
                const r = await api<{ url: string; rows: number }>("/integrations/google/sheets/export", { body: { fields, ...periodRange(period, from, to) } });
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
          <button className="btn btn-ghost" disabled={(!isReport && !fields.length) || customInvalid} data-testid="export-drive" onClick={saveDrive}>Google Drive에 저장</button>
        ) : (
          <button className="btn btn-ghost" onClick={() => connectGoogle("drive")}>Google Drive 권한 연결</button>
        ))}
        {drive && <p className="text-[14px]" role="status">Drive의 LINKOS 폴더에 {drive.name} 저장 · <a className="font-semibold underline" href={drive.url} target="_blank" rel="noopener noreferrer">열기</a></p>}
        {exportMsg && <p className="text-[13.5px] text-[var(--color-ember)]" role="alert">{exportMsg}</p>}
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

      <Section title="내 활동 기록" icon="eye">
        <ActivityLog />
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
