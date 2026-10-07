"use client";
// F-044 NFC 액세서리: 내 NFC 카드/스티커/링 등록·기록·비활성화.
// Web NFC(NDEFReader)는 Android Chrome 에서 "태그에 URL 기록"만 지원한다 — 폰↔폰 전송이 아니다.
// iOS Safari 등 미지원 브라우저에서는 URL 을 복사해 NFC 기록 앱으로 태그에 쓰도록 안내한다.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { api, relTime } from "@/lib/client";

interface Tag {
  id: string;
  label: string;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

type NdefWriter = { write: (msg: { records: { recordType: string; data: string }[] }) => Promise<void> };

function webNfcAvailable(): boolean {
  return typeof window !== "undefined" && "NDEFReader" in window;
}

export function NfcTags() {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);
  const [writeState, setWriteState] = useState<"idle" | "waiting" | "done" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<{ tags: Tag[] }>("/nfc-tags").then((r) => setTags(r.tags)).catch(() => setTags([])), []);
  useEffect(() => {
    void load();
  }, [load]);

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ id: string; url: string }>("/nfc-tags", { body: { label: label.trim() || "내 NFC 카드" } });
      setFresh(r);
      setLabel("");
      setWriteState("idle");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const writeTag = async () => {
    if (!fresh) return;
    setWriteState("waiting");
    try {
      const Reader = (window as unknown as { NDEFReader: new () => NdefWriter }).NDEFReader;
      await new Reader().write({ records: [{ recordType: "url", data: fresh.url }] });
      setWriteState("done");
    } catch {
      setWriteState("failed");
    }
  };

  const revoke = async (id: string) => {
    await api(`/nfc-tags/${id}`, { method: "DELETE" }).catch(() => undefined);
    if (fresh?.id === id) setFresh(null);
    await load();
  };

  const active = (tags ?? []).filter((t) => !t.revoked_at);
  return (
    <div className="text-left" data-testid="nfc-tags">
      <p className="text-[13px] text-[var(--fg-mute)]">
        카드·스티커에는 내 고정 주소가 기록되고, 상대가 폰에 댈 때마다 1회용 교환 링크가 새로 만들어져요. 잃어버리면 여기서 비활성화하세요.
      </p>
      {active.length > 0 && (
        <ul className="mt-3 space-y-2">
          {active.map((t) => (
            <li key={t.id} className="flex items-center gap-3 rounded-2xl border border-[var(--line)] px-3 py-2 text-[14px]">
              <Icon name="nfc" size={18} />
              <span className="flex-1">
                <span className="block font-semibold">{t.label}</span>
                <span className="block text-[12px] text-[var(--fg-mute)]">{t.use_count}회 사용{t.last_used_at ? ` · 마지막 ${relTime(t.last_used_at)}` : ""}</span>
              </span>
              <button onClick={() => revoke(t.id)} className="btn btn-ghost !min-h-9 !px-3 text-[13px]" aria-label={`${t.label} 비활성화`}>
                비활성화
              </button>
            </li>
          ))}
        </ul>
      )}
      {fresh ? (
        <div className="mt-3 rounded-2xl border border-dashed border-[var(--line-strong)] p-3">
          <p className="text-[13px] font-semibold">태그에 기록할 주소 (지금 한 번만 표시)</p>
          <p className="num mt-1 break-all text-[13px]" data-testid="nfc-tag-url">{fresh.url}</p>
          {webNfcAvailable() ? (
            <button onClick={writeTag} disabled={writeState === "waiting"} className="btn btn-signal mt-3 w-full" data-testid="nfc-write">
              <Icon name="nfc" size={18} /> {writeState === "waiting" ? "태그를 폰 뒷면에 대세요…" : writeState === "done" ? "기록 완료 — 다시 기록" : "NFC 태그에 기록"}
            </button>
          ) : (
            <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]">이 브라우저는 NFC 기록을 지원하지 않아요(Android Chrome 지원). 주소를 복사해 NFC 기록 앱에서 URL 레코드로 쓰세요.</p>
          )}
          {writeState === "failed" && <p role="alert" className="mt-2 text-[13px] text-[var(--color-ember)]">기록하지 못했어요. 쓰기 가능한 NDEF 태그인지 확인하세요.</p>}
          <button onClick={() => navigator.clipboard?.writeText(fresh.url).catch(() => undefined)} className="mt-2 text-[13px] underline-offset-4 hover:underline">주소 복사</button>
        </div>
      ) : (
        <form onSubmit={register} className="mt-3 flex gap-2">
          <input className="field flex-1" placeholder="예: 지갑 카드, 노트북 스티커" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} aria-label="NFC 태그 이름" />
          <button className="btn btn-ink">등록</button>
        </form>
      )}
      {error && <p role="alert" className="mt-2 text-[13px] text-[var(--color-ember)]">{error}</p>}
    </div>
  );
}
