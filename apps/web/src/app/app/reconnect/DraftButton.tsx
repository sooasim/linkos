"use client";
// X-006 one-tap re-connect draft (saved to 메시지함 as a draft — never sent automatically)
import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/client";

export function DraftButton({ contactId, existingMessageId }: { contactId: string; existingMessageId: string | null }) {
  const [draft, setDraft] = useState<{ id: string; subject: string | null; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setDraft(await api(`/reconnect/digest/${contactId}/draft`, { method: "POST", offline: false }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (draft || existingMessageId) {
    return (
      <div className="mt-3 rounded-2xl bg-[var(--bg-sunk)] p-3" data-testid="reconnect-draft">
        <p className="text-[12.5px] font-semibold text-[var(--accent-text)]">초안 저장됨 · 아직 보내지 않았어요</p>
        {draft && <p className="mt-1 whitespace-pre-wrap text-[13.5px]">{draft.body}</p>}
        <Link href="/app/messages" className="btn btn-ghost mt-2 !min-h-10 text-[14px]">메시지함에서 검토·보내기</Link>
      </div>
    );
  }
  return (
    <>
      <button className="btn btn-ink mt-3 w-full sm:w-auto" disabled={busy} onClick={create} data-testid="reconnect-draft-btn">
        <Icon name="message" size={17} /> {busy ? "만드는 중…" : "안부 초안 만들기"}
      </button>
      {error && <p role="alert" className="mt-2 text-[13px] text-[var(--color-ember)]">{error}</p>}
    </>
  );
}
