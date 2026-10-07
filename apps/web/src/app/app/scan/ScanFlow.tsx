"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CardScanner, type OcrLineOut } from "@/components/CardScanner";
import { Icon } from "@/components/Icon";
import { CARD_KEYS, type CardKey, type ReviewedCard, ReviewFields, initialFromParsed } from "@/components/ReviewFields";
import { api, uid } from "@/lib/client";

export function ScanFlow() {
  const router = useRouter();
  const [step, setStep] = useState<"scan" | "review">("scan");
  const [back, setBack] = useState(false);
  const [job, setJob] = useState<any>(null);
  const [initial, setInitial] = useState<Record<CardKey, string>>(Object.fromEntries(CARD_KEYS.map((k) => [k, ""])) as Record<CardKey, string>);
  const [conf, setConf] = useState<Partial<Record<CardKey, number>>>({});
  const [reviewed, setReviewed] = useState<ReviewedCard | null>(null);
  const [place, setPlace] = useState("");
  const [tags, setTags] = useState("");
  const [frontLines, setFrontLines] = useState<OcrLineOut[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const process = async (front: OcrLineOut[], backLines?: OcrLineOut[]) => {
    const j = await api("/capture/cards", { body: { side: backLines ? "both" : "front", kind: "card", engine: "tesseract.js", lines: front, backLines } });
    setJob(j);
    const { card, conf } = initialFromParsed(j.fields);
    setInitial(card);
    setConf(conf);
    setStep("review");
  };

  const onFront = async (lines: OcrLineOut[]) => {
    if (back) setFrontLines(lines);
    else await process(lines);
  };

  const save = async () => {
    if (!reviewed) return;
    setBusy(true);
    setError(null);
    try {
      const c = reviewed.card;
      const r = await api<{ contactId: string }>("/contacts", {
        idempotencyKey: uid(),
        body: {
          ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v || null])),
          fullName: c.fullName,
          source: job ? "scan" : "manual",
          provenance: reviewed.provenance,
          businessCardId: job?.id ?? null,
          encounter: place ? { placeLabel: place } : undefined,
          tags: tags.split(/[,\s#]+/).filter(Boolean),
        },
      });
      router.push(`/app/people/${r.contactId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (step === "scan") {
    return (
      <div className="space-y-4 animate-rise">
        <label className="flex items-center gap-3 text-[15px]">
          <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={back} onChange={(e) => setBack(e.target.checked)} />
          양면 명함 (앞·뒤 합치기)
        </label>
        {!frontLines ? (
          <>
            <p className="text-[14px] text-[var(--fg-mute)]">{back ? "앞면을 먼저 촬영하세요." : "명함이 화면을 가득 채우도록 촬영하세요."}</p>
            <CardScanner onLines={onFront} onManual={() => setStep("review")} />
          </>
        ) : (
          <>
            <p className="text-[14px] font-semibold">이제 뒷면을 촬영하세요.</p>
            <CardScanner onLines={(b) => process(frontLines, b)} />
            <button onClick={() => process(frontLines)} className="w-full text-[14px] text-[var(--fg-mute)] underline">뒷면 없이 진행</button>
          </>
        )}
        <p className="text-[12.5px] text-[var(--fg-mute)]">사진 원본은 기기 밖으로 전송되지 않고, 인식된 텍스트와 신뢰도만 저장됩니다.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-rise">
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
        <button onClick={() => { setStep("scan"); setJob(null); setFrontLines(null); }} className="btn btn-ghost btn-lg">다시</button>
      </div>
    </div>
  );
}
