"use client";
// F-081 회의 녹음: 동의가 기록된 뒤에만 마이크를 연다. MediaRecorder 를 파트(~50초)마다 다시 시작해
// 각 파트가 독립적으로 재생·전사 가능한 파일이 되게 하고, 녹음 중에 순서대로 업로드한다(중복 업로드는 서버가 무시).
// UX-015 마커: 녹음 중 "마커"를 누르면 녹음 시작 기준 시각(+선택 라벨)이 저장되어 전사 타임라인에 표시된다.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { api, upload } from "@/lib/client";

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function MeetingRecorder({ meetingId, consentGranted, onFinished, onMarker }: { meetingId: string; consentGranted: boolean; onFinished: () => void; onMarker?: () => void }) {
  const [state, setState] = useState<"idle" | "starting" | "recording" | "stopping">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [parts, setParts] = useState({ uploaded: 0, total: 0, failed: 0 });
  const [msg, setMsg] = useState<string | null>(null);
  const [markLabel, setMarkLabel] = useState("");
  const [marks, setMarks] = useState<{ id: string; offsetMs: number; label: string | null }[]>([]);
  const [markBusy, setMarkBusy] = useState(false);
  const r = useRef<{ stream: MediaStream | null; rec: MediaRecorder | null; recId: string | null; seq: number; startedAt: number; partStart: number; stopping: boolean; uploads: Promise<void>[]; timer: number | null; partTimer: number | null; mime: string; partMs: number }>({
    stream: null, rec: null, recId: null, seq: 0, startedAt: 0, partStart: 0, stopping: false, uploads: [], timer: null, partTimer: null, mime: "", partMs: 50_000,
  });

  useEffect(() => () => {
    const s = r.current;
    s.stopping = true;
    s.rec?.state === "recording" && s.rec.stop();
    s.stream?.getTracks().forEach((t) => t.stop());
    if (s.timer) window.clearInterval(s.timer);
    if (s.partTimer) window.clearTimeout(s.partTimer);
  }, []);

  const uploadPart = async (blob: Blob, seq: number, offsetMs: number, durationMs: number) => {
    setParts((p) => ({ ...p, total: p.total + 1 }));
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await upload(`/meetings/${meetingId}/recordings/${r.current.recId}/parts/${seq}?offsetMs=${offsetMs}&durationMs=${durationMs}`, blob, { method: "PUT" });
        setParts((p) => ({ ...p, uploaded: p.uploaded + 1 }));
        return;
      } catch (e) {
        const status = (e as { status?: number }).status ?? 0;
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
          setMsg((e as Error).message);
          break;
        }
        await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
      }
    }
    setParts((p) => ({ ...p, failed: p.failed + 1 }));
  };

  const startPart = () => {
    const s = r.current;
    if (!s.stream || s.stopping) return;
    const rec = new MediaRecorder(s.stream, s.mime ? { mimeType: s.mime, audioBitsPerSecond: 32_000 } : undefined);
    const chunks: Blob[] = [];
    const seq = s.seq++;
    const offsetMs = Date.now() - s.startedAt;
    s.partStart = Date.now();
    rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
    rec.onstop = () => {
      const durationMs = Date.now() - s.partStart;
      const blob = new Blob(chunks, { type: rec.mimeType || s.mime || "audio/webm" });
      if (blob.size) s.uploads.push(uploadPart(blob, seq, offsetMs, durationMs));
      if (!s.stopping) startPart();
    };
    rec.start();
    s.rec = rec;
    s.partTimer = window.setTimeout(() => rec.state === "recording" && rec.stop(), s.partMs);
  };

  const start = async () => {
    setMsg(null);
    if (!consentGranted) return setMsg("녹음 동의를 먼저 기록하세요.");
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return setMsg("이 브라우저는 녹음을 지원하지 않아요.");
    setState("starting");
    try {
      const s = r.current;
      s.mime = pickMime();
      const created = await api<{ id: string; partSeconds: number; transcription: string | null }>(`/meetings/${meetingId}/recordings`, { body: { mimeType: (s.mime || "audio/webm").split(";")[0] } });
      s.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      s.recId = created.id;
      s.partMs = (created.partSeconds || 50) * 1000;
      s.seq = 0;
      s.uploads = [];
      s.stopping = false;
      s.startedAt = Date.now();
      setParts({ uploaded: 0, total: 0, failed: 0 });
      setMarks([]);
      setElapsed(0);
      s.timer = window.setInterval(() => setElapsed((Date.now() - s.startedAt) / 1000), 500);
      startPart();
      setState("recording");
      if (!created.transcription) setMsg("녹음은 암호화해 저장되지만, 전사(STT)가 설정되지 않아 텍스트 변환은 되지 않아요.");
    } catch (e) {
      setState("idle");
      setMsg((e as Error).name === "NotAllowedError" ? "마이크 권한이 거부되었어요." : (e as Error).message);
    }
  };

  const addMarker = async () => {
    const s = r.current;
    if (!s.recId || markBusy) return;
    const offsetMs = Math.max(0, Date.now() - s.startedAt);
    setMarkBusy(true);
    try {
      const m = await api<{ id: string; offsetMs: number; label: string | null }>(`/meetings/${meetingId}/markers`, { body: { recordingId: s.recId, offsetMs, label: markLabel.trim() || null }, offline: false });
      setMarks((cur) => [...cur, m]);
      setMarkLabel("");
      onMarker?.();
    } catch (e) {
      setMsg(`마커를 저장하지 못했어요 — ${(e as Error).message}`);
    } finally {
      setMarkBusy(false);
    }
  };

  const stop = async () => {
    const s = r.current;
    setState("stopping");
    s.stopping = true;
    if (s.partTimer) window.clearTimeout(s.partTimer);
    const done = new Promise<void>((res) => {
      if (!s.rec || s.rec.state !== "recording") return res();
      const prev = s.rec.onstop;
      s.rec.onstop = (ev) => {
        prev?.call(s.rec!, ev);
        res();
      };
      s.rec.stop();
    });
    await done;
    s.stream?.getTracks().forEach((t) => t.stop());
    if (s.timer) window.clearInterval(s.timer);
    await Promise.all(s.uploads);
    try {
      await api(`/meetings/${meetingId}/recordings/${s.recId}/finalize`, { body: { durationSeconds: Math.round((Date.now() - s.startedAt) / 1000) }, offline: false });
    } catch (e) {
      setMsg((e as Error).message);
    }
    setState("idle");
    onFinished();
  };

  return (
    <div className="space-y-3">
      {state === "recording" || state === "stopping" ? (
        <div className="flex items-center gap-3 rounded-2xl bg-[var(--color-ink)] px-4 py-3 text-white" role="status" aria-live="polite">
          <span aria-hidden className="size-3 animate-pulse rounded-full bg-[var(--color-ember)] motion-reduce:animate-none" />
          <span className="num font-semibold">{mmss(elapsed)}</span>
          <span className="text-[13px] opacity-80">업로드 {parts.uploaded}/{parts.total}{parts.failed ? ` · 실패 ${parts.failed}` : ""}</span>
          <button type="button" className="btn btn-signal ml-auto !min-h-10" onClick={stop} disabled={state === "stopping"} data-testid="record-stop">
            {state === "stopping" ? "마무리 중…" : "녹음 종료"}
          </button>
        </div>
      ) : null}
      {state === "recording" && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void addMarker(); }} aria-label="녹음 마커">
          <input className="field !min-h-10 min-w-0 flex-1 !py-1" placeholder="마커 라벨 (선택) · 예: 가격 이야기" maxLength={80} value={markLabel} onChange={(e) => setMarkLabel(e.target.value)} aria-label="마커 라벨 (선택)" />
          <button type="submit" className="btn btn-ink !min-h-10" disabled={markBusy} data-testid="record-marker" aria-label="마커 남기기 (지금 시점)">
            <Icon name="flag" size={16} /> 마커
          </button>
        </form>
      )}
      {marks.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="남긴 마커" data-testid="record-markers">
          {marks.map((m) => (
            <li key={m.id} className="chip !text-[12px]">
              <Icon name="flag" size={12} /> <span className="num">{mmss(m.offsetMs / 1000)}</span>{m.label ? ` · ${m.label}` : ""}
            </li>
          ))}
        </ul>
      )}
      {state === "recording" || state === "stopping" ? null : (
        <button type="button" className="btn btn-ink" onClick={start} disabled={!consentGranted || state === "starting"} data-testid="record-start">
          <Icon name="mic" size={16} /> {state === "starting" ? "준비 중…" : "녹음 시작"}
        </button>
      )}
      {msg && <p role="status" className="text-[13.5px]">{msg}</p>}
    </div>
  );
}
