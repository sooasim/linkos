"use client";
// F-012 사진첩 일괄 가져오기(최대 200장, 백그라운드 큐·진행률·건별 검토·중복 탐지),
// F-013 한 장에 여러 명함 분리, F-178 오프라인에서 찍어 둔 사진 처리.
// Photos wait in the encrypted on-device inbox; the queue resumes after a reload and runs while this screen is open.
import { CANDIDATE_THRESHOLD, REVIEW_THRESHOLD, needsReview, parseBusinessCard, scoreDuplicate } from "@linkos/domain";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Empty } from "@/components/Page";
import { type ReviewedCard, ReviewFields, initialFromParsed } from "@/components/ReviewFields";
import { ClientError, api, isQueuedOffline, uid, upload } from "@/lib/client";
import type { InboxCard, InboxItem } from "@/lib/offline";

export const MAX_BATCH = 200;

type Flat = { item: InboxItem; card: InboxCard; key: string; n: number };

export function BatchImport() {
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [split, setSplit] = useState(false);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const stop = useRef(false);

  const refresh = useCallback(async () => {
    const { listInbox } = await import("@/lib/offline");
    setItems(await listInbox());
  }, []);

  useEffect(() => {
    let off = () => undefined as void;
    void import("@/lib/offline").then(({ onOfflineChange }) => {
      off = onOfflineChange(() => void refresh());
    });
    void refresh();
    setOnline(navigator.onLine);
    const on = () => setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      off();
      stop.current = true;
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
      void import("@/lib/ocr").then((m) => m.terminateOcr());
    };
  }, [refresh]);

  const processOne = async (item: InboxItem) => {
    const off = await import("@/lib/offline");
    const pipe = await import("@/lib/imagePipeline");
    const { ocrCanvas } = await import("@/lib/ocr");
    await off.updateInbox(item.id, { status: "processing", error: null });
    const blob = await off.inboxBlob(item.id);
    if (!blob) {
      await off.updateInbox(item.id, { status: "error", error: "사진 데이터를 찾을 수 없어요." });
      return;
    }
    const base = await pipe.loadCanvas(blob);
    const canvases = item.split ? pipe.splitCards(base).canvases : [pipe.autoCorrect(base).canvas];
    const cards: InboxCard[] = [];
    for (const [idx, c] of canvases.entries()) {
      const lines = await ocrCanvas(pipe.enhanceForOcr(c), item.langs);
      if (!lines.length) continue;
      let job: any;
      try {
        job = await api("/capture/cards", { body: { side: "front", kind: item.kind, engine: "tesseract.js", lines }, offline: false });
      } catch (e) {
        if (!(e instanceof ClientError) || e.status !== 0) throw e;
        const r = parseBusinessCard(lines);
        job = { id: null, fields: r.fields.map((f) => ({ ...f, needsReview: needsReview(f) })), duplicates: [], draft: {} };
      }
      if (item.keepOriginal && job.id) await upload(`/capture/cards/${job.id}/images/front`, await pipe.canvasToJpeg(c), { method: "PUT" }).catch(() => undefined);
      cards.push({ idx, status: "review", thumb: pipe.thumbnail(c), lines, captureId: job.id ?? null, fields: job.fields, duplicates: job.duplicates ?? [], draft: job.draft ?? {} });
    }
    // the photo itself is no longer needed on the device once it has been read
    await off.updateInbox(item.id, { status: "done", cards, error: cards.length ? null : "글자를 찾지 못했어요." }, { dropBlob: true });
  };

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    stop.current = false;
    try {
      const { listInbox, updateInbox } = await import("@/lib/offline");
      for (;;) {
        if (stop.current) break;
        const next = (await listInbox()).find((i) => i.status === "queued" || i.status === "processing");
        if (!next) break;
        setCurrent(next.name);
        try {
          await processOne(next);
        } catch (e) {
          const offline = e instanceof ClientError && e.status === 0;
          await updateInbox(next.id, offline || !navigator.onLine ? { status: "queued" } : { status: "error", error: (e as Error).message.slice(0, 200) });
          if (!navigator.onLine) {
            setNotice("오프라인이라 인식을 잠시 멈췄어요. 연결되면 이어서 처리합니다.");
            break;
          }
        }
      }
    } finally {
      setCurrent(null);
      setRunning(false);
    }
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  // auto-resume the queue (also after reconnecting)
  useEffect(() => {
    if (online && !running && items.some((i) => i.status === "queued" || i.status === "processing")) void run();
  }, [items, online, running, run]);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files].filter((f) => f.type.startsWith("image/"));
    const room = MAX_BATCH - items.filter((i) => i.status !== "done").length;
    const take = list.slice(0, Math.max(0, room));
    if (take.length < list.length) setNotice(`한 번에 최대 ${MAX_BATCH}장까지 가져올 수 있어요. ${list.length - take.length}장은 제외했어요.`);
    const { addToInbox } = await import("@/lib/offline");
    await addToInbox(take, { source: "batch", split, keepOriginal, names: take.map((f) => f.name) });
    if (input.current) input.current.value = "";
    await refresh();
  };

  const flat: Flat[] = items.flatMap((item) => item.cards.map((card, n) => ({ item, card, n, key: `${item.id}:${card.idx}` })));
  const draftOf = (c: InboxCard) => {
    const { card } = initialFromParsed(c.fields);
    return { fullName: card.fullName, company: card.company, email: card.email, phone: card.phone };
  };
  // in-batch duplicates (same person photographed twice / two cards of one person)
  const batchDup = (f: Flat) => {
    const me = draftOf(f.card);
    if (!me.fullName) return null;
    const idx = flat.indexOf(f);
    for (let i = 0; i < idx; i++) {
      const o = draftOf(flat[i]!.card);
      if (o.fullName && scoreDuplicate(me, o).score >= CANDIDATE_THRESHOLD) return i + 1;
    }
    return null;
  };

  const total = items.length;
  const processed = items.filter((i) => i.status === "done" || i.status === "error").length;
  const toReview = flat.filter((f) => f.card.status === "review").length;

  const setCard = async (f: Flat, patch: Partial<InboxCard>) => {
    const { updateInbox } = await import("@/lib/offline");
    await updateInbox(f.item.id, (cur) => ({ ...cur, cards: cur.cards.map((c) => (c.idx === f.card.idx ? { ...c, ...patch } : c)) }));
  };

  const save = async (f: Flat, reviewed: ReviewedCard) => {
    const c = reviewed.card;
    const contact = { ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v || null])), fullName: c.fullName, source: "scan", provenance: reviewed.provenance, businessCardId: f.card.captureId };
    try {
      const r = f.card.captureId
        ? await api<{ contactId: string }>("/contacts", { idempotencyKey: uid(), body: contact })
        : await api<{ contactId: string }>("/capture/commit", { idempotencyKey: uid(), body: { capture: { side: "front", kind: f.item.kind, engine: "tesseract.js", lines: f.card.lines }, contact } });
      await setCard(f, { status: "saved", contactId: r.contactId });
      setOpen(null);
    } catch (e) {
      if (isQueuedOffline(e)) {
        await setCard(f, { status: "queued_save" });
        setOpen(null);
        return;
      }
      setNotice((e as Error).message);
    }
  };

  const clearDone = async () => {
    const { removeInbox } = await import("@/lib/offline");
    await removeInbox(items.filter((i) => i.status === "done" && i.cards.every((c) => c.status !== "review")).map((i) => i.id));
  };

  return (
    <div className="space-y-5">
      <section className="surface space-y-3 p-5">
        <input ref={input} type="file" accept="image/*" multiple className="sr-only" onChange={(e) => onFiles(e.target.files)} aria-label="명함 사진 여러 장 선택" data-testid="batch-input" />
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-[14.5px]">
          <label className="flex items-center gap-2"><input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={split} onChange={(e) => setSplit(e.target.checked)} />한 사진에 여러 명함</label>
          <label className="flex items-center gap-2"><input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)} />원본 보관 (암호화)</label>
        </div>
        <button type="button" className="btn btn-signal btn-lg w-full" onClick={() => input.current?.click()}>
          <Icon name="plus" size={18} /> 사진 선택 (최대 {MAX_BATCH}장)
        </button>
        <p className="text-[12.5px] text-[var(--fg-mute)]">사진은 이 기기에서 자동 보정·인식되고, 인식이 끝나면 기기에서도 지워집니다. 원본 보관을 켠 경우에만 보정된 명함 이미지를 암호화해 저장해요.</p>
      </section>

      {notice && <p role="status" className="rounded-2xl bg-[var(--bg-elev)] px-4 py-3 text-[14px]">{notice}</p>}

      {total > 0 && (
        <section aria-label="진행 상황" className="space-y-2">
          <div className="flex items-center justify-between text-[14px]">
            <span className="font-semibold">{processed}/{total}장 처리 · 검토 대기 {toReview}건</span>
            {!online && <span className="chip !text-[12px]">오프라인 · 대기 중</span>}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--line)]" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={processed} aria-label="일괄 가져오기 진행률">
            <div className="h-full bg-[var(--color-signal)] transition-[width] motion-reduce:transition-none" style={{ width: `${total ? (processed / total) * 100 : 0}%` }} />
          </div>
          {current && <p className="text-[13px] text-[var(--fg-mute)]" role="status">인식 중: {current}</p>}
        </section>
      )}

      {total === 0 ? (
        <Empty title="가져올 사진이 없어요" body="예전에 찍어 둔 명함 사진을 한 번에 골라 주세요. 오프라인에서 찍은 사진도 여기에 모입니다." />
      ) : (
        <ul className="space-y-2">
          {items.filter((i) => i.status !== "done").map((i) => (
            <li key={i.id} className="surface flex items-center gap-3 p-3 text-[14px]">
              <Icon name={i.status === "error" ? "x" : "scan"} size={18} />
              <span className="min-w-0 flex-1 truncate">{i.name}</span>
              <span className="text-[var(--fg-mute)]">{i.status === "queued" ? "대기" : i.status === "processing" ? "인식 중" : i.error}</span>
            </li>
          ))}
          {flat.map((f) => {
            const d = draftOf(f.card);
            const dupN = batchDup(f);
            const isOpen = open === f.key;
            return (
              <li key={f.key} className="surface overflow-hidden">
                <button type="button" className="flex w-full items-center gap-3 p-3 text-left" onClick={() => setOpen(isOpen ? null : f.key)} aria-expanded={isOpen}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.card.thumb} alt="" className="h-12 w-20 shrink-0 rounded-lg object-cover" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{d.fullName || "이름 없음"}</span>
                    <span className="block truncate text-[13px] text-[var(--fg-mute)]">{d.company || "—"}{f.card.fields.some((x) => x.confidence < REVIEW_THRESHOLD) ? " · 확인 필요" : ""}</span>
                  </span>
                  {f.card.duplicates.length > 0 && <span className="chip !text-[11.5px]"><Icon name="merge" size={12} /> 기존 연락처</span>}
                  {dupN && <span className="chip !text-[11.5px]">배치 #{dupN}과 중복?</span>}
                  <span className="text-[12.5px] text-[var(--fg-mute)]">{{ review: "검토", saved: "저장됨", skipped: "건너뜀", queued_save: "전송 대기" }[f.card.status]}</span>
                </button>
                {isOpen && f.card.status === "review" && <ReviewPanel flat={f} onSave={(r) => save(f, r)} onSkip={() => setCard(f, { status: "skipped" }).then(() => setOpen(null))} />}
                {isOpen && f.card.status === "saved" && f.card.contactId && (
                  <p className="px-4 pb-4 text-[14px]"><Link className="underline" href={`/app/people/${f.card.contactId}`}>연락처 보기</Link></p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {processed > 0 && (
        <button type="button" className="btn btn-ghost w-full" onClick={clearDone}>
          검토가 끝난 항목 정리
        </button>
      )}
    </div>
  );
}

function ReviewPanel({ flat, onSave, onSkip }: { flat: Flat; onSave: (r: ReviewedCard) => Promise<void>; onSkip: () => void }) {
  const { card, conf } = initialFromParsed(flat.card.fields);
  const [reviewed, setReviewed] = useState<ReviewedCard | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3 border-t border-[var(--line)] p-4">
      {flat.card.duplicates.map((d) => (
        <Link key={d.contactId} href={`/app/people/${d.contactId}`} className="block text-[13.5px] underline">
          이미 있을 수 있어요: {d.fullName} · {d.company ?? "—"} ({Math.round(d.score * 100)}%)
        </Link>
      ))}
      <ReviewFields key={JSON.stringify(card)} initial={card} confidence={conf} threshold={REVIEW_THRESHOLD} onChange={setReviewed} />
      <div className="flex gap-2">
        <button type="button" className="btn btn-signal flex-1" disabled={busy || !reviewed?.card.fullName} onClick={async () => { setBusy(true); await onSave(reviewed!); setBusy(false); }}>
          {busy ? "저장 중…" : "인맥에 저장"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onSkip}>건너뛰기</button>
      </div>
    </div>
  );
}

