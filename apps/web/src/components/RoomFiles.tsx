"use client";
// F-156 공유 파일: 소개서·제안서(PDF/이미지, 검사 후 암호화 저장) 와 링크를 Connection Room 에 모아 둔다.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { api, relTime, upload } from "@/lib/client";

type F = { id: string; kind: "file" | "link"; title: string; url: string | null; createdAt: string; scanStatus?: string; byteSize?: number };

export function RoomFiles({ roomId, onChange }: { roomId: string; onChange?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<F[]>([]);
  const [link, setLink] = useState({ title: "", url: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ files: F[] }>(`/rooms/${roomId}/files`).then((r) => setFiles(r.files)), [roomId]);
  useEffect(() => {
    void load();
  }, [load]);
  const done = async () => {
    await load();
    onChange?.();
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await upload<{ scanStatus: string }>(`/rooms/${roomId}/files?title=${encodeURIComponent(f.name)}`, f, { filename: f.name });
      if (r.scanStatus === "quarantined") setMsg("보안 검사에서 위험 요소가 발견되어 파일을 격리했어요.");
      await done();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <section className="surface mt-4 space-y-3 p-4" aria-label="공유 파일">
      <div className="flex items-center justify-between">
        <h2 className="text-[16px] font-semibold">공유 파일 · 링크</h2>
        <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} aria-label="공유할 파일 선택" />
        <button type="button" className="btn btn-ghost !min-h-10" disabled={busy} onClick={() => input.current?.click()}>
          <Icon name="plus" size={16} /> {busy ? "검사 중…" : "파일"}
        </button>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!link.title.trim() || !link.url.trim()) return;
          try {
            await api(`/rooms/${roomId}/links`, { body: link, offline: false });
            setLink({ title: "", url: "" });
            await done();
          } catch (err) {
            setMsg((err as Error).message);
          }
        }}
      >
        <input className="field min-w-0 flex-1" placeholder="링크 제목" value={link.title} onChange={(e) => setLink({ ...link, title: e.target.value })} aria-label="링크 제목" />
        <input className="field min-w-0 flex-[2]" placeholder="https://" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} aria-label="링크 주소" inputMode="url" />
        <button className="btn btn-ink shrink-0">추가</button>
      </form>
      {msg && <p role="status" className="text-[13.5px]">{msg}</p>}
      {files.length > 0 && (
        <ul className="divide-y divide-[var(--line)]">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 py-2.5 text-[14px]">
              <Icon name={f.kind === "link" ? "link" : f.scanStatus === "quarantined" ? "lock" : "download"} size={16} />
              {f.url ? (
                <a href={f.url} className="min-w-0 flex-1 truncate underline-offset-4 hover:underline" target={f.kind === "link" ? "_blank" : undefined} rel="noopener noreferrer">
                  {f.title}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[var(--fg-mute)]">{f.title} · 격리됨</span>
              )}
              <span className="text-[12px] text-[var(--fg-mute)]">{relTime(f.createdAt)}</span>
              <button type="button" className="btn btn-ghost !min-h-9 !px-2" aria-label={`${f.title} 삭제`} onClick={() => api(`/rooms/${roomId}/files/${f.id}`, { method: "DELETE" }).then(done)}>
                <Icon name="trash" size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
