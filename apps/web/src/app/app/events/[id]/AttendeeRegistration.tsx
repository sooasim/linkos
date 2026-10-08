"use client";
// F-142 참가자 등록 (주최자 전용): CSV 파일 업로드 또는 스프레드시트 붙여넣기 → 미리보기 → 등록.
// 같은 목록을 다시 올려도 중복되지 않는다(서버가 이메일/이름+회사 키로 upsert). 등록된 사람이 참가 코드로 입장하면
// 같은 이메일의 행에 연결된다. 사전 등록자는 추천 후보가 아니다(본인 opt-in 전).
import { type AttendeeParseResult, parseAttendeeCsv } from "@linkos/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { api, uid } from "@/lib/client";

type Attendee = { id: string; userId: string | null; status: "joined" | "registered"; role: string; optIn: boolean; fullName: string | null; company: string | null; jobTitle: string | null; email: string | null; preRegistered: boolean };

const REASON: Record<string, string> = { missing_name: "이름 없음", invalid_email: "이메일 형식 오류", duplicate: "중복", too_many_rows: "최대 2,000명 초과" };
const SAMPLE = "이름,이메일,회사,직책\n홍길동,hong@example.com,링코스랩,대표";

export function AttendeeRegistration({ eventId, onChanged }: { eventId: string; onChanged?: () => void }) {
  const [text, setText] = useState("");
  const [source, setSource] = useState<"csv" | "paste">("paste");
  const [preview, setPreview] = useState<AttendeeParseResult | null>(null);
  const [list, setList] = useState<Attendee[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setListError(null);
    api<{ attendees: Attendee[] }>(`/events/${eventId}/attendees`).then((r) => setList(r.attendees)).catch((e) => setListError((e as Error).message));
  }, [eventId]);
  useEffect(() => load(), [load]);

  const update = (t: string, src: "csv" | "paste") => {
    setText(t);
    setSource(src);
    setMsg(null);
    setPreview(t.trim() ? parseAttendeeCsv(t) : null);
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1_000_000) return setMsg({ ok: false, text: "파일이 너무 커요 (최대 1MB)." });
    update(await f.text(), "csv");
    if (file.current) file.current.value = "";
  };

  const submit = async () => {
    if (!preview?.rows.length) return;
    setBusy(true);
    setMsg(null);
    try {
      // the server re-parses the same text with the same parser; the idempotency key makes a double-tap harmless
      const r = await api<{ inserted: number; updated: number; skipped: number }>(`/events/${eventId}/attendees`, { body: { csv: text, source }, idempotencyKey: uid(), offline: false });
      setMsg({ ok: true, text: `새로 ${r.inserted}명 등록 · ${r.updated}명 갱신${r.skipped ? ` · ${r.skipped}줄 건너뜀` : ""}` });
      setText("");
      setPreview(null);
      load();
      onChanged?.();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Attendee) => {
    try {
      await api(`/events/${eventId}/attendees/${a.id}`, { method: "DELETE" });
      load();
      onChanged?.();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const registered = (list ?? []).filter((a) => a.preRegistered || a.status === "registered");
  return (
    <section className="surface mt-8 space-y-4 p-5" aria-labelledby="att-h" data-testid="attendee-registration">
      <div>
        <h2 id="att-h" className="text-[18px] font-semibold">참가자 등록 <span className="text-[13px] font-normal text-[var(--fg-mute)]">· 주최자만 보여요</span></h2>
        <p className="mt-1 text-[13.5px] text-[var(--fg-mute)]">CSV 파일을 올리거나 스프레드시트에서 복사해 붙여넣으세요. 열: 이름 · 이메일 · 회사 · 직책. 같은 목록을 다시 올리면 중복 없이 갱신돼요. 등록된 사람이 참가 코드로 입장하면 자동으로 연결되고, 본인이 동의하기 전에는 추천에 노출되지 않아요.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <input ref={file} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} aria-label="참가자 CSV 파일 선택" data-testid="attendee-csv-file" />
        <button type="button" className="btn btn-ghost" onClick={() => file.current?.click()}>
          <Icon name="download" size={18} className="rotate-180" /> CSV 파일 올리기
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => update(SAMPLE, "paste")}>예시 채우기</button>
      </div>
      <textarea
        className="field min-h-32 font-mono !text-[13px]"
        placeholder={SAMPLE}
        value={text}
        onChange={(e) => update(e.target.value, "paste")}
        aria-label="참가자 목록 붙여넣기 (CSV)"
        data-testid="attendee-paste"
      />
      {preview && (
        <div className="space-y-2" aria-live="polite">
          <p className="text-[14px] font-semibold" data-testid="attendee-preview-count">{preview.rows.length}명 인식{preview.errors.length ? ` · ${preview.errors.length}줄 제외` : ""}</p>
          {preview.rows.length > 0 && (
            <ul className="max-h-48 divide-y divide-[var(--line)] overflow-y-auto rounded-2xl border border-[var(--line)] text-[13.5px]">
              {preview.rows.slice(0, 50).map((r, i) => (
                <li key={i} className="flex flex-wrap gap-x-3 px-3 py-2">
                  <b>{r.fullName}</b>
                  <span className="text-[var(--fg-mute)]">{[r.company, r.jobTitle].filter(Boolean).join(" · ")}</span>
                  {r.email && <span className="text-[var(--fg-mute)]">{r.email}</span>}
                </li>
              ))}
              {preview.rows.length > 50 && <li className="px-3 py-2 text-[var(--fg-mute)]">외 {preview.rows.length - 50}명</li>}
            </ul>
          )}
          {preview.errors.length > 0 && (
            <p className="text-[13px] text-[var(--color-ember)]">
              {preview.errors.slice(0, 5).map((e) => `${e.line}행 ${REASON[e.reason] ?? e.reason}`).join(" · ")}
              {preview.errors.length > 5 ? " …" : ""}
            </p>
          )}
          <button type="button" className="btn btn-signal w-full" disabled={busy || !preview.rows.length} onClick={submit} data-testid="attendee-submit">
            {busy ? "등록 중…" : `${preview.rows.length}명 등록`}
          </button>
        </div>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-[13.5px] ${msg.ok ? "" : "text-[var(--color-ember)]"}`}>{msg.text}</p>}

      <div>
        <h3 className="mb-2 text-[15px] font-semibold">사전 등록 {registered.length}</h3>
        {listError ? (
          <p role="alert" className="text-[13.5px] text-[var(--color-ember)]">
            목록을 불러오지 못했어요 — {listError} <button className="underline" onClick={load}>다시 시도</button>
          </p>
        ) : !list ? (
          <div className="h-16 animate-pulse rounded-2xl bg-[var(--bg-sunk)]" />
        ) : registered.length === 0 ? (
          <p className="text-[13.5px] text-[var(--fg-mute)]">아직 사전 등록한 참가자가 없어요.</p>
        ) : (
          <ul className="max-h-72 divide-y divide-[var(--line)] overflow-y-auto rounded-2xl border border-[var(--line)] text-[14px]" data-testid="attendee-list">
            {registered.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{a.fullName ?? "이름 없음"}</span>
                  <span className="block truncate text-[12.5px] text-[var(--fg-mute)]">{[a.company, a.jobTitle, a.email].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="chip !text-[12px]">{a.status === "joined" ? "입장함" : "등록됨"}</span>
                {a.status === "registered" && (
                  <button type="button" className="btn btn-ghost !min-h-9 !px-2" onClick={() => remove(a)} aria-label={`${a.fullName ?? "참가자"} 등록 삭제`}>
                    <Icon name="trash" size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
