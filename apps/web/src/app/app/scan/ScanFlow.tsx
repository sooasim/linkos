"use client";
// F-010 자동 보정 스캔 → 검토 → 저장. F-019 원본 보관은 체크했을 때만(암호화 저장).
// F-013 한 장에 여러 명함 / F-012 사진첩 일괄 가져오기 → /app/scan/import.
// F-178 오프라인: OCR 결과는 기기에서 구조화(동일 파서)하고, 저장은 암호화 outbox 에 넣어 재연결 시 전송.
import { REVIEW_THRESHOLD, needsReview, parseBusinessCard } from "@linkos/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { CardScanner, type OcrLineOut, type ScanExtra } from "@/components/CardScanner";
import { Icon } from "@/components/Icon";
import { CARD_KEYS, type CardKey, type ReviewedCard, ReviewFields, initialFromParsed } from "@/components/ReviewFields";
import { ClientError, api, isQueuedOffline, uid, upload } from "@/lib/client";

function localJob(lines: OcrLineOut[]) {
  const r = parseBusinessCard(lines);
  return { id: null, local: true, fields: r.fields.map((f) => ({ ...f, needsReview: needsReview(f) })), unassigned: r.unassigned, duplicates: [], reviewThreshold: REVIEW_THRESHOLD };
}

export function ScanFlow() {
  const router = useRouter();
  const multiInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"scan" | "review">("scan");
  const [back, setBack] = useState(false);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [job, setJob] = useState<any>(null);
  const [initial, setInitial] = useState<Record<CardKey, string>>(Object.fromEntries(CARD_KEYS.map((k) => [k, ""])) as Record<CardKey, string>);
  const [conf, setConf] = useState<Partial<Record<CardKey, number>>>({});
  const [reviewed, setReviewed] = useState<ReviewedCard | null>(null);
  const [place, setPlace] = useState("");
  const [tags, setTags] = useState("");
  const [frontLines, setFrontLines] = useState<OcrLineOut[] | null>(null);
  const [lines, setLines] = useState<{ front: OcrLineOut[]; back?: OcrLineOut[] } | null>(null);
  const [images, setImages] = useState<{ front?: Blob; back?: Blob }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reset = () => {
    setStep("scan");
    setJob(null);
    setFrontLines(null);
    setLines(null);
    setImages({});
    setReviewed(null);
  };

  const process = async (front: OcrLineOut[], backLines?: OcrLineOut[]) => {
    setLines({ front, back: backLines });
    let j: any;
    try {
      j = await api("/capture/cards", { body: { side: backLines ? "both" : "front", kind: "card", engine: "tesseract.js", lines: front, backLines }, offline: false });
    } catch (e) {
      // offline (or server unreachable): structure on device with the same deterministic parser
      if (!(e instanceof ClientError) || e.status !== 0) throw e;
      j = localJob([...front, ...(backLines ?? [])]);
    }
    setJob(j);
    const { card, conf } = initialFromParsed(j.fields);
    setInitial(card);
    setConf(conf);
    setStep("review");
  };

  const onFront = async (l: OcrLineOut[], _p: string, extra?: ScanExtra) => {
    if (extra) setImages((cur) => ({ ...cur, front: extra.jpeg }));
    if (back) setFrontLines(l);
    else await process(l);
  };

  const keepPhotoOffline = async (file: File) => {
    const { addToInbox } = await import("@/lib/offline");
    await addToInbox([file], { source: "offline", keepOriginal });
    setNotice("오프라인이라 사진을 이 기기에 암호화해 보관했어요. 연결되면 ‘사진첩 가져오기’에서 자동으로 인식해 검토할 수 있어요.");
  };

  const onMulti = async (files: FileList | null) => {
    if (!files?.length) return;
    const { addToInbox } = await import("@/lib/offline");
    await addToInbox([...files].slice(0, 20), { source: "batch", split: true, keepOriginal, names: [...files].map((f) => f.name) });
    router.push("/app/scan/import");
  };

  const save = async () => {
    if (!reviewed) return;
    setBusy(true);
    setError(null);
    const c = reviewed.card;
    const contact = {
      ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v || null])),
      fullName: c.fullName,
      source: job ? "scan" : "manual",
      provenance: reviewed.provenance,
      businessCardId: job?.id ?? null,
      encounter: place ? { placeLabel: place } : undefined,
      tags: tags.split(/[,\s#]+/).filter(Boolean),
    };
    try {
      let contactId: string;
      if (job?.local && lines) {
        // offline-created capture: OCR lines + reviewed contact committed atomically (replayable)
        const r = await api<{ contactId: string; captureId: string }>("/capture/commit", {
          idempotencyKey: uid(),
          body: { capture: { side: lines.back ? "both" : "front", kind: "card", engine: "tesseract.js", lines: lines.front, backLines: lines.back }, contact },
        });
        contactId = r.contactId;
        if (keepOriginal && images.front) await upload(`/capture/cards/${r.captureId}/images/front`, images.front, { method: "PUT" }).catch(() => undefined);
      } else {
        const r = await api<{ contactId: string }>("/contacts", { idempotencyKey: uid(), body: contact });
        contactId = r.contactId;
        if (keepOriginal && job?.id) {
          for (const side of ["front", "back"] as const) {
            const blob = images[side];
            if (blob) await upload(`/capture/cards/${job.id}/images/${side}`, blob, { method: "PUT" }).catch(() => undefined);
          }
        }
      }
      router.push(`/app/people/${contactId}`);
    } catch (e) {
      if (isQueuedOffline(e)) {
        setNotice("오프라인이라 이 기기에 암호화해 보관했어요. 연결되면 자동으로 저장됩니다.");
        reset();
        setBusy(false);
        return;
      }
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (step === "scan") {
    return (
      <div className="space-y-4 animate-rise">
        {notice && <p role="status" className="rounded-2xl bg-[var(--color-signal)]/25 px-4 py-3 text-[14px]">{notice}</p>}
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <label className="flex items-center gap-3 text-[15px]">
            <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={back} onChange={(e) => setBack(e.target.checked)} />
            양면 명함 (앞·뒤 합치기)
          </label>
          <label className="flex items-center gap-3 text-[15px]">
            <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)} data-testid="keep-original" />
            원본 사진 보관 (암호화)
          </label>
        </div>
        {!frontLines ? (
          <>
            <p className="text-[14px] text-[var(--fg-mute)]">{back ? "앞면을 먼저 촬영하세요." : "명함 전체가 보이게 촬영하세요. 테두리와 기울기는 자동으로 맞춥니다."}</p>
            <CardScanner onLines={onFront} onManual={() => setStep("review")} onOfflinePhoto={keepPhotoOffline} />
          </>
        ) : (
          <>
            <p className="text-[14px] font-semibold">이제 뒷면을 촬영하세요.</p>
            <CardScanner
              onLines={(b, _p, extra) => {
                if (extra) setImages((cur) => ({ ...cur, back: extra.jpeg }));
                void process(frontLines, b);
              }}
            />
            <button onClick={() => process(frontLines)} className="w-full text-[14px] text-[var(--fg-mute)] underline">뒷면 없이 진행</button>
          </>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <input ref={multiInput} type="file" accept="image/*" multiple className="sr-only" onChange={(e) => onMulti(e.target.files)} aria-label="여러 명함이 담긴 사진 선택" />
          <button type="button" className="btn btn-ghost" onClick={() => multiInput.current?.click()}>
            <Icon name="scan" size={18} /> 한 장에 여러 명함
          </button>
          <Link href="/app/scan/import" className="btn btn-ghost">
            <Icon name="download" size={18} /> 사진첩에서 일괄 가져오기
          </Link>
        </div>
        <p className="text-[12.5px] text-[var(--fg-mute)]">
          {keepOriginal ? "원본 사진은 암호화해 보관하고 보관 기간이 지나면 자동 삭제됩니다. 언제든 삭제할 수 있어요." : "사진 원본은 기기 밖으로 전송되지 않고, 인식된 텍스트와 신뢰도만 저장됩니다."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-rise">
      {job?.local && <p role="status" className="rounded-2xl bg-[var(--bg-elev)] px-4 py-3 text-[13.5px]">오프라인 · 이 기기에서 구조화했어요. 저장하면 연결될 때 서버로 전송됩니다.</p>}
      {job?.duplicates?.length > 0 && (
        <div className="rounded-[22px] border border-[var(--color-ember)]/40 p-4">
          <p className="flex items-center gap-2 font-semibold"><Icon name="merge" size={18} />이미 있는 연락처일 수 있어요</p>
          {job.duplicates.map((d: any) => (
            <Link key={d.contactId} href={`/app/people/${d.contactId}`} className="mt-2 block text-[14px] underline">
              {d.fullName} · {d.company ?? "—"} ({d.autoMergeable ? "이메일/전화 일치" : "이름·회사 유사"} {Math.round(d.score * 100)}%)
            </Link>
          ))}
          <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]">저장 후 상세 화면에서 필드별로 비교·병합할 수 있어요.</p>
        </div>
      )}
      <ReviewFields key={JSON.stringify(initial)} initial={initial} confidence={conf} threshold={job?.reviewThreshold ?? 0.75} onChange={setReviewed} />
      {job?.unassigned?.length > 0 && (
        <details className="surface p-4 text-[14px]">
          <summary className="cursor-pointer font-semibold">분류되지 않은 텍스트 {job.unassigned.length}줄</summary>
          <ul className="mt-2 space-y-1 text-[var(--fg-mute)]">{job.unassigned.map((u: any) => <li key={u.line}>{u.text}</li>)}</ul>
        </details>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="label">만난 곳</span>
          <input className="field" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="예: 스타트업 밋업" />
        </label>
        <label>
          <span className="label">태그</span>
          <input className="field" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="투자, 파트너" />
        </label>
      </div>
      {error && <p role="alert" className="text-[14px] text-[var(--color-ember)]">{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={busy || !reviewed?.card.fullName} className="btn btn-signal btn-lg flex-1" data-testid="save-contact">{busy ? "저장 중…" : "인맥에 저장"}</button>
        <button onClick={reset} className="btn btn-ghost btn-lg">다시</button>
      </div>
    </div>
  );
}
