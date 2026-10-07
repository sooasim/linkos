"use client";
// F-014 배지 스캔 / F-144 배지 OCR → 행사 리드. 배지 레이아웃(이름 크게 → 회사 → 직함)을 기기에서 바로 구조화하고,
// 저장은 /events/{id}/leads (Idempotency-Key). F-150 오프라인 모드: 네트워크가 없으면 암호화 outbox 에 보관 후 재전송.
import { REVIEW_THRESHOLD, parseBadge } from "@linkos/domain";
import { useState } from "react";
import { CardScanner, type OcrLineOut } from "./CardScanner";
import { Icon } from "./Icon";
import { CARD_KEYS, type CardKey, type ReviewedCard, ReviewFields, initialFromParsed } from "./ReviewFields";
import { api, isQueuedOffline, uid } from "@/lib/client";

const empty = () => Object.fromEntries(CARD_KEYS.map((k) => [k, ""])) as Record<CardKey, string>;

export function BadgeLeadScanner({ eventId, onSaved }: { eventId: string; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<OcrLineOut[] | null>(null);
  const [badgeType, setBadgeType] = useState<string | null>(null);
  const [initial, setInitial] = useState(empty());
  const [conf, setConf] = useState<Partial<Record<CardKey, number>>>({});
  const [reviewed, setReviewed] = useState<ReviewedCard | null>(null);
  const [stage, setStage] = useState<"scan" | "review">("scan");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onLines = (l: OcrLineOut[]) => {
    const r = parseBadge(l);
    const { card, conf } = initialFromParsed(r.fields);
    setLines(l);
    setBadgeType(r.badgeType);
    setInitial(card);
    setConf(conf);
    setStage("review");
  };

  const reset = () => {
    setLines(null);
    setBadgeType(null);
    setInitial(empty());
    setStage("scan");
  };

  const save = async () => {
    if (!reviewed) return;
    setBusy(true);
    setMsg(null);
    const c = reviewed.card;
    const body = {
      capture: lines ? { side: "front", kind: "badge", engine: "tesseract.js", lines } : null,
      contact: {
        ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v || null])),
        fullName: c.fullName,
        source: "event",
        provenance: reviewed.provenance,
        encounter: badgeType ? { note: `배지: ${badgeType}` } : undefined,
      },
    };
    try {
      await api(`/events/${eventId}/leads`, { idempotencyKey: uid(), body });
      setMsg(`${c.fullName}님을 이 행사 리드로 저장했어요.`);
      reset();
      onSaved?.();
    } catch (e) {
      if (isQueuedOffline(e)) {
        setMsg(`오프라인 · ${c.fullName}님을 기기에 암호화해 보관했어요. 연결되면 리드로 전송됩니다.`);
        reset();
      } else setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-signal btn-lg w-full" onClick={() => setOpen(true)} data-testid="badge-scan-open">
        <Icon name="scan" size={18} /> 배지 스캔해서 리드 추가
      </button>
    );
  }
  return (
    <section className="surface space-y-4 p-5" aria-label="배지 스캔">
      <div className="flex items-center justify-between">
        <h2 className="text-[17px] font-semibold">배지 스캔</h2>
        <button type="button" className="btn btn-ghost !min-h-10" onClick={() => setOpen(false)} aria-label="배지 스캔 닫기"><Icon name="x" size={16} /></button>
      </div>
      {msg && <p role="status" className="rounded-2xl bg-[var(--bg-elev)] px-4 py-3 text-[14px]">{msg}</p>}
      {stage === "scan" ? (
        <CardScanner kind="badge" onLines={onLines} onManual={() => setStage("review")} compact />
      ) : (
        <div className="space-y-3">
          {badgeType && <span className="chip !text-[12px]">배지 유형 · {badgeType}</span>}
          <ReviewFields key={JSON.stringify(initial)} initial={initial} confidence={conf} threshold={REVIEW_THRESHOLD} onChange={setReviewed} />
          <div className="flex gap-2">
            <button type="button" className="btn btn-signal btn-lg flex-1" disabled={busy || !reviewed?.card.fullName} onClick={save} data-testid="badge-save">{busy ? "저장 중…" : "리드로 저장"}</button>
            <button type="button" className="btn btn-ghost btn-lg" onClick={reset}>다시</button>
          </div>
        </div>
      )}
    </section>
  );
}
