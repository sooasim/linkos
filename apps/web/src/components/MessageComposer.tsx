"use client";
// F-104 AI 초안 · F-111 템플릿 · F-112 번역 · F-115 Gmail 초안 · F-106 승인 후 발송. 기본값은 초안 — 발송은 확인 체크 + 명시적 승인 버튼으로만.
import { shortMessage } from "@linkos/domain";
import { useEffect, useState } from "react";
import { AiLabel } from "@/components/Page";
import { Icon } from "@/components/Icon";
import { ClientError, api, uid } from "@/lib/client";

export interface MessageDto {
  id: string;
  contactId: string | null;
  channel: "email" | "sms";
  toAddress: string | null;
  toName: string | null;
  subject: string | null;
  body: string;
  language: string;
  provenance: string;
  status: string;
  provider: string | null;
  gmailDraftId: string | null;
  error: string | null;
  sentAt: string | null;
}

const LANGS: [string, string][] = [["en", "영어"], ["ja", "일본어"], ["zh", "중국어"], ["vi", "베트남어"], ["es", "스페인어"], ["ko", "한국어"]];
const PROV_LABEL: Record<string, string> = { ai_inferred: "AI 초안 · 확인 후 사용", rules: "템플릿 초안", template: "템플릿", user_edited: "AI 초안 · 수정됨" };

export function MessageComposer({ contactId, email, phone, initial, onChange }: { contactId?: string | null; email?: string | null; phone?: string | null; initial?: MessageDto | null; onChange?: () => void }) {
  const [msg, setMsg] = useState<MessageDto | null>(initial ?? null);
  const [to, setTo] = useState(initial?.toAddress ?? email ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [templates, setTemplates] = useState<{ id: string; name: string; channel: string }[]>([]);
  const [options, setOptions] = useState<{ gmail: boolean; gmailDrafts: boolean; outlook: boolean; smtp: boolean } | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [translation, setTranslation] = useState<{ subject?: string; body?: string; notice: string; translated: boolean; target: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [approved, setApproved] = useState(false);
  const [via, setVia] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    api<{ templates: any[] }>("/templates").then((r) => setTemplates(r.templates)).catch(() => undefined);
    api("/messages/options").then(setOptions).catch(() => undefined);
  }, []);

  const dirty = !msg || msg.subject !== subject || msg.body !== body || msg.toAddress !== (to || null);
  const sent = msg?.status === "sent";
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setFlash(null);
    try {
      await fn();
    } catch (e) {
      setFlash(e instanceof ClientError ? e.message : "요청을 처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };
  const adopt = (m: MessageDto) => {
    setMsg(m);
    setTo(m.toAddress ?? "");
    setSubject(m.subject ?? "");
    setBody(m.body);
    onChange?.();
  };
  const save = async (): Promise<MessageDto> => {
    if (msg && !dirty) return msg;
    const m = msg
      ? await api<MessageDto>(`/messages/${msg.id}`, { method: "PATCH", body: { toAddress: to || null, subject, body } })
      : await api<MessageDto>("/messages", { body: { contactId: contactId ?? null, toAddress: to || null, subject, body, channel: "email" }, idempotencyKey: uid() });
    adopt(m);
    return m;
  };

  const aiDraft = (kind: "thank_you" | "check_in" | "send_material") => run(async () => {
    adopt(await api<MessageDto>("/messages/ai-draft", { body: { contactId, kind }, idempotencyKey: uid() }));
    setMissing([]);
  });
  const applyTemplate = (id: string) => run(async () => {
    const r = await api<{ subject: string | null; body: string; missing: string[] }>(`/templates/${id}/render`, { body: { contactId: contactId ?? null } });
    setSubject(r.subject ?? subject);
    setBody(r.body);
    setMissing(r.missing);
  });
  const translate = (target: string) => run(async () => {
    const m = await save();
    const r = await api<{ items: Record<string, string>; notice: string; translated: boolean }>("/translate", { body: { target, messageId: m.id } });
    setTranslation({ subject: r.items.subject, body: r.items.body, notice: r.notice, translated: r.translated, target });
  });
  const gmailDraft = () => run(async () => {
    const m = await save();
    adopt(await api<MessageDto>(`/messages/${m.id}/gmail-draft`, { body: {} }));
    setFlash("Gmail 임시보관함에 저장했어요. 보내기 전까지 아무것도 발송되지 않습니다.");
  });
  const send = () => run(async () => {
    const m = await save();
    const r = await api<MessageDto>(`/messages/${m.id}/send`, { body: { approved: true, via }, idempotencyKey: `send-${m.id}` });
    adopt(r);
    setConfirming(false);
    setApproved(false);
    setFlash(`${r.toAddress}에게 보냈어요 (${r.provider}).`);
  });

  const channels = options ? (["gmail", "outlook", "smtp"] as const).filter((k) => options[k]) : [];
  const canSend = channels.length > 0;

  return (
    <div className="surface space-y-3 p-4" data-testid="composer">
      {contactId && !sent && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-ghost !min-h-9 text-[13px]" disabled={busy} onClick={() => aiDraft("thank_you")}><Icon name="spark" size={15} />감사 인사</button>
          <button className="btn btn-ghost !min-h-9 text-[13px]" disabled={busy} onClick={() => aiDraft("check_in")}>안부</button>
          <button className="btn btn-ghost !min-h-9 text-[13px]" disabled={busy} onClick={() => aiDraft("send_material")}>자료 전달</button>
          {templates.length > 0 && (
            <select className="field !min-h-9 !w-auto text-[13px]" defaultValue="" aria-label="템플릿" onChange={(e) => e.target.value && applyTemplate(e.target.value)}>
              <option value="">템플릿…</option>
              {templates.filter((t) => t.channel === "email").map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
        </div>
      )}
      {msg && PROV_LABEL[msg.provenance] && <AiLabel>{PROV_LABEL[msg.provenance]}</AiLabel>}
      {missing.length > 0 && <p className="text-[13px] text-[var(--color-ember)]" role="status">값이 없어 비워 둔 변수: {missing.join(", ")} — 직접 채워 주세요.</p>}
      <input className="field" value={to} onChange={(e) => setTo(e.target.value)} placeholder="받는 사람 이메일" aria-label="받는 사람" disabled={sent} type="email" />
      <input className="field" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="제목" aria-label="제목" disabled={sent} />
      <textarea className="field min-h-36" value={body} onChange={(e) => setBody(e.target.value)} placeholder="본문" aria-label="본문" disabled={sent} />

      {translation && (
        <div className="space-y-2 rounded-[16px] border border-[var(--line)] p-3" data-testid="translation">
          {translation.translated ? <AiLabel>AI 번역 · 확인 필요</AiLabel> : <span className="chip">번역 불가</span>}
          <p className="text-[13px] text-[var(--fg-mute)]">{translation.notice}</p>
          {translation.translated && (
            <>
              {translation.subject && <p className="font-semibold">{translation.subject}</p>}
              <p className="whitespace-pre-wrap text-[14px]">{translation.body}</p>
              <button className="btn btn-ink !min-h-9 text-[13px]" onClick={() => { if (translation.subject) setSubject(translation.subject); if (translation.body) setBody(translation.body); setTranslation(null); }}>이 번역으로 바꾸기</button>
            </>
          )}
        </div>
      )}

      {sent ? (
        <p className="flex items-center gap-2 text-[14px]" role="status"><Icon name="check" size={16} />보냄 · {msg?.provider}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost !min-h-10 text-[14px]" disabled={busy || !body.trim()} onClick={() => run(async () => { await save(); setFlash("초안을 저장했어요."); })}>초안 저장</button>
          <select className="field !min-h-10 !w-auto text-[13px]" defaultValue="" aria-label="번역" disabled={busy || !body.trim()} onChange={(e) => { if (e.target.value) translate(e.target.value); e.target.value = ""; }}>
            <option value="">번역…</option>
            {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {options?.gmailDrafts && <button className="btn btn-ghost !min-h-10 text-[14px]" disabled={busy || !body.trim() || !to} onClick={gmailDraft}>Gmail 초안</button>}
          {canSend ? (
            <button className="btn btn-signal !min-h-10 text-[14px]" disabled={busy || !body.trim() || !to || !subject.trim()} onClick={() => setConfirming(true)}><Icon name="mail" size={16} />보내기…</button>
          ) : (
            to && <a className="btn btn-signal !min-h-10 text-[14px]" href={`mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}>메일 앱에서 열기</a>
          )}
          {phone && <a className="btn btn-ghost !min-h-10 text-[14px]" href={`sms:${phone}?body=${encodeURIComponent(shortMessage(body, 90))}`}>짧은 문자</a>}
        </div>
      )}

      {confirming && !sent && (
        <div className="space-y-3 rounded-[16px] border-2 border-[var(--fg)] p-4" role="dialog" aria-label="발송 승인">
          <p className="font-semibold">이 메일을 보낼까요?</p>
          <p className="text-[14px]">받는 사람 <b>{to}</b> · 제목 “{subject}”</p>
          <label className="label" htmlFor="via">보내는 경로</label>
          <select id="via" className="field" value={via} onChange={(e) => setVia(e.target.value)}>
            <option value="auto">자동 (연결된 계정 우선)</option>
            {channels.map((c) => <option key={c} value={c}>{c === "gmail" ? "Gmail" : c === "outlook" ? "Outlook" : "LINKOS 메일 (회신은 내 이메일로)"}</option>)}
          </select>
          <label className="flex items-center gap-3 text-[14px]"><input type="checkbox" className="size-5" checked={approved} onChange={(e) => setApproved(e.target.checked)} />내용과 받는 사람을 확인했고 발송을 승인합니다</label>
          <div className="flex gap-2">
            <button className="btn btn-signal" disabled={!approved || busy} onClick={send}>{busy ? "보내는 중…" : "승인하고 보내기"}</button>
            <button className="btn btn-ghost" onClick={() => { setConfirming(false); setApproved(false); }}>취소</button>
          </div>
        </div>
      )}
      {msg?.status === "failed" && msg.error && <p className="text-[13px] text-[var(--color-ember)]">지난 발송 실패: {msg.error}</p>}
      {flash && <p className="text-[13.5px]" role="status">{flash}</p>}
    </div>
  );
}
