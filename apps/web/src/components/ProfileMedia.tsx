"use client";
// F-024 딥 프로필 — 포트폴리오 이미지·PDF 첨부. 파일은 업로드 시 검사(F-172) 후 암호화 저장되고,
// 공개 범위(public < business < trusted < partner)에 맞는 사람에게만 짧게 유효한 서명 링크로 보인다.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { api, upload } from "@/lib/client";

type Media = { id: string; kind: "image" | "pdf"; title: string | null; visibility: string; url: string | null; scanStatus: string; filename: string | null; byteSize: number };

const VIS = [
  { v: "public", label: "전체 공개" },
  { v: "business", label: "명함 교환한 사람" },
  { v: "trusted", label: "승인한 사람" },
  { v: "partner", label: "파트너" },
] as const;

export function ProfileMediaManager({ profileId }: { profileId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [media, setMedia] = useState<Media[] | null>(null);
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<string>("business");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api<{ media: Media[] }>(`/profiles/${profileId}/media`).then((r) => setMedia(r.media)), [profileId]);
  useEffect(() => {
    void load();
  }, [load]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await upload<{ scanStatus: string }>(`/profiles/${profileId}/media?title=${encodeURIComponent(title || f.name)}&visibility=${visibility}`, f, { filename: f.name });
      setMsg(r.scanStatus === "quarantined" ? "보안 검사에서 위험 요소가 발견되어 격리했어요. 다른 사람에게는 보이지 않습니다." : "올렸어요.");
      setTitle("");
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="space-y-4">
      <section className="surface space-y-3 p-5">
        <label className="block">
          <span className="label">제목</span>
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 2026 회사소개서" maxLength={120} />
        </label>
        <label className="block">
          <span className="label">공개 범위</span>
          <select className="field" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            {VIS.map((v) => <option key={v.v} value={v.v}>{v.label}</option>)}
          </select>
        </label>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} aria-label="이미지 또는 PDF 선택" />
        <button type="button" className="btn btn-signal btn-lg w-full" disabled={busy} onClick={() => input.current?.click()}>
          <Icon name="plus" size={18} /> {busy ? "검사·업로드 중…" : "이미지 · PDF 올리기"}
        </button>
        <p className="text-[12.5px] text-[var(--fg-mute)]">최대 20MB · 이미지는 위치정보(EXIF)를 지우고 다시 인코딩해 저장합니다.</p>
        {msg && <p role="status" className="text-[14px]">{msg}</p>}
      </section>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {(media ?? []).map((m) => (
          <li key={m.id} className="surface overflow-hidden">
            <MediaThumb m={m} />
            <div className="flex items-center gap-2 p-2.5 text-[13px]">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{m.title ?? m.filename}</span>
                <span className="block text-[var(--fg-mute)]">{VIS.find((v) => v.v === m.visibility)?.label}{m.scanStatus === "quarantined" ? " · 격리됨" : ""}</span>
              </span>
              <button type="button" aria-label={`${m.title ?? "파일"} 삭제`} className="btn btn-ghost !min-h-9 !px-2" onClick={() => api(`/profiles/${profileId}/media/${m.id}`, { method: "DELETE" }).then(load)}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MediaThumb({ m }: { m: Media }) {
  if (!m.url) return <div className="grid aspect-[4/3] place-items-center bg-[var(--bg-elev)] text-[12px] text-[var(--fg-mute)]"><Icon name="lock" size={20} /></div>;
  if (m.kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={m.url} alt={m.title ?? ""} loading="lazy" className="aspect-[4/3] w-full object-cover" />;
  }
  return (
    <a href={m.url} className="grid aspect-[4/3] place-items-center bg-[var(--bg-elev)] text-[13px] font-semibold" rel="noopener">
      <span className="flex items-center gap-1.5"><Icon name="download" size={16} /> PDF</span>
    </a>
  );
}

/** Read-only gallery on the public card (server applies the viewer's audience). */
export function ProfileMediaGallery({ profileId }: { profileId: string }) {
  const [media, setMedia] = useState<Media[] | null>(null);
  useEffect(() => {
    api<{ media: Media[] }>(`/profiles/${profileId}/media`).then((r) => setMedia(r.media)).catch(() => setMedia([]));
  }, [profileId]);
  if (!media?.length) return null;
  return (
    <section className="mt-6" aria-label="포트폴리오">
      <p className="eyebrow mb-2">Portfolio</p>
      <ul className="grid grid-cols-2 gap-3">
        {media.map((m) => (
          <li key={m.id} className="surface overflow-hidden">
            <MediaThumb m={m} />
            <p className="truncate p-2.5 text-[13px] font-semibold">{m.title ?? m.filename}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
