"use client";

/**
 * P-090 상품 카드 CRUD · P-091 가격 표시 정책 · P-092 품절·만료 비공개 · P-093 외부 링크 · P-141 요금제 한도.
 *
 * ## 판단은 전부 서버에 있다
 *
 * 가격 완결성(`price_incomplete`), 요금제 한도(`plan_limit`), 링크 형식(`invalid_url`),
 * 상태 전환은 모듈이 정하고 이 화면은 **그 코드와 문구를 그대로 보여준다**(P-187).
 * 특히 `plan_limit` 안내에는 요금제와 카드 개수만 적는다 — 결제와 검증을 한 화면에서 말하지 않는다(N-2).
 *
 * ## 런타임 상수를 `@proplus/api` 에서 가져오지 않는 이유
 *
 * 이 파일은 클라이언트 번들이다. `catalog.PRICE_POLICIES` 를 **값으로** import 하면 서버 모듈(pg 포함)이
 * 번들에 끌려 들어온다. 그래서 타입만 가져오고(`import type`), 목록은 여기 적되 라벨을 `Record<…>` 로 두어
 * 도메인에 값이 추가되면 **타입 에러로 알려 주게** 한다.
 */

import type { catalog } from "@proplus/api";
import { useState } from "react";
import { ClientError, api, uid } from "@/lib/client";

type Offer = catalog.Offer;
type OfferStatus = catalog.OfferStatus;
type PricePolicy = catalog.PricePolicy;

const POLICY_ORDER: readonly PricePolicy[] = ["shown", "inquiry", "hidden"];

const POLICY_COPY: Record<PricePolicy, { label: string; hint: string }> = {
  shown: { label: "금액 표시", hint: "금액과 통화(ISO 4217, 예: KRW)가 모두 필요합니다." },
  inquiry: { label: "문의 후 안내", hint: "공개 화면에 금액이 나오지 않고 상담으로 연결됩니다." },
  hidden: { label: "비공개", hint: "가격 정보를 공개하지 않습니다." },
};

const STATUS_COPY: Record<OfferStatus, { label: string; publicNote: string }> = {
  draft: { label: "초안", publicNote: "공개되지 않습니다" },
  active: { label: "공개 중", publicNote: "공개 화면에 표시됩니다" },
  sold_out: { label: "품절", publicNote: "공개 화면에서 내려갑니다" },
  archived: { label: "보관", publicNote: "공개되지 않습니다" },
};

const STATUS_ORDER: readonly OfferStatus[] = ["draft", "active", "sold_out", "archived"];

interface Notice {
  tone: "ok" | "error";
  message: string;
  code?: string;
  /** `plan_limit` 의 세부(요금제 코드·한도·현재 개수). 서버가 준 값만 적는다. */
  detail?: string;
}

interface Draft {
  title: string;
  description: string;
  priceDisplayPolicy: PricePolicy;
  priceAmount: string;
  priceCurrency: string;
  externalUrl: string;
  availableUntil: string;
}

function emptyDraft(): Draft {
  return {
    title: "",
    description: "",
    priceDisplayPolicy: "inquiry",
    priceAmount: "",
    priceCurrency: "",
    externalUrl: "",
    availableUntil: "",
  };
}

function draftOf(offer: Offer): Draft {
  return {
    title: offer.title,
    description: offer.description ?? "",
    priceDisplayPolicy: offer.priceDisplayPolicy,
    priceAmount: offer.priceAmount === null ? "" : String(offer.priceAmount),
    priceCurrency: offer.priceCurrency ?? "",
    externalUrl: offer.externalUrl ?? "",
    availableUntil: offer.availableUntil ? offer.availableUntil.slice(0, 10) : "",
  };
}

/** 폼 값 → 요청 본문. 빈 문자열은 `null` 로 보낸다("지우기"와 "안 건드림"을 구분한다). */
function toBody(d: Draft) {
  return {
    title: d.title.trim(),
    description: d.description.trim() || null,
    priceDisplayPolicy: d.priceDisplayPolicy,
    priceAmount: d.priceAmount.trim() === "" ? null : Number(d.priceAmount),
    priceCurrency: d.priceCurrency.trim() || null,
    externalUrl: d.externalUrl.trim() || null,
    availableUntil: d.availableUntil.trim() || null,
  };
}

function failureNotice(err: unknown, fallback: string): Notice {
  const e = err instanceof ClientError ? err : null;
  const d = (e?.details ?? null) as { planCode?: string; limit?: number; current?: number } | null;
  return {
    tone: "error",
    message: e?.message ?? fallback,
    code: e?.code,
    // 요금제 한도는 "지금 몇 개 중 몇 개"를 알려 줘야 사용자가 다음 행동을 고를 수 있다.
    ...(e?.code === "plan_limit" && d
      ? { detail: `요금제 ${d.planCode ?? "-"} · 한도 ${d.limit ?? "-"}개 · 현재 ${d.current ?? "-"}개` }
      : {}),
  };
}

export function OfferManager({ offers }: { offers: readonly Offer[] }) {
  const [rows, setRows] = useState<Offer[]>([...offers]);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function create(draft: Draft) {
    setBusy("create");
    setNotice(null);
    try {
      const res = await api<{ offer: Offer }>("/me/offers", { method: "POST", idempotencyKey: uid(), body: toBody(draft) });
      setRows((prev) => [res.offer, ...prev]);
      setCreating(false);
      // 생성은 항상 초안이다(모듈이 강제한다). 저장만으로 공개되지 않는다는 사실을 말해 준다.
      setNotice({ tone: "ok", message: "상품 카드를 초안으로 저장했습니다. “공개 중”으로 바꾸면 공개됩니다." });
    } catch (err) {
      setNotice(failureNotice(err, "저장하지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }

  async function update(id: string, draft: Draft) {
    setBusy(id);
    setNotice(null);
    try {
      const res = await api<{ offer: Offer | null }>(`/me/offers/${id}`, { method: "PATCH", body: toBody(draft) });
      const saved = res.offer;
      if (saved) setRows((prev) => prev.map((o) => (o.id === id ? saved : o)));
      setEditingId(null);
      setNotice({ tone: "ok", message: "내용을 수정했습니다." });
    } catch (err) {
      setNotice(failureNotice(err, "수정하지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }

  async function changeStatus(id: string, status: OfferStatus) {
    setBusy(id);
    setNotice(null);
    try {
      const res = await api<{ offer: Offer | null }>(`/me/offers/${id}`, { method: "PATCH", body: { status } });
      const saved = res.offer;
      if (saved) setRows((prev) => prev.map((o) => (o.id === id ? saved : o)));
      setNotice({ tone: "ok", message: `상태를 “${STATUS_COPY[status].label}”로 바꿨습니다.` });
    } catch (err) {
      setNotice(failureNotice(err, "상태를 바꾸지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setNotice(null);
    try {
      await api(`/me/offers/${id}`, { method: "DELETE" });
      setRows((prev) => prev.filter((o) => o.id !== id));
      setConfirmDeleteId(null);
      setNotice({ tone: "ok", message: "상품 카드를 삭제했습니다." });
    } catch (err) {
      setNotice(failureNotice(err, "삭제하지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-[var(--fg-mute)]">
          {rows.length}개 · 초안·품절·보관 카드는 공개 화면에 나오지 않습니다.
        </p>
        <button
          type="button"
          className="btn btn-primary !min-h-10 text-[14px]"
          onClick={() => {
            setCreating((v) => !v);
            setEditingId(null);
          }}
          aria-expanded={creating}
        >
          {creating ? "작성 취소" : "상품 카드 추가"}
        </button>
      </div>

      {notice ? (
        <p
          className={`mt-4 text-[13.5px] font-semibold ${
            notice.tone === "ok" ? "text-[var(--verified)]" : "text-[var(--caution)]"
          }`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
          {notice.detail ? <span className="block font-normal text-[var(--fg-mute)]">{notice.detail}</span> : null}
          {notice.code ? <span className="block font-normal text-[var(--fg-mute)]">오류 코드: {notice.code}</span> : null}
        </p>
      ) : null}

      {creating ? (
        <div className="card mt-5 p-6">
          <h2 className="text-[17px] font-semibold">새 상품 카드</h2>
          <OfferFields
            initial={emptyDraft()}
            busy={busy === "create"}
            submitLabel="초안으로 저장"
            onSubmit={create}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="panel mt-6 p-6">
          <p className="text-[15px] font-semibold">아직 상품 카드가 없습니다.</p>
          <p className="mt-2 max-w-[56ch] text-[14px] leading-relaxed text-[var(--fg-mute)]">
            제공하는 서비스를 카드로 만들면 공개 프로필에서 상담으로 이어집니다. 결제는 플랫폼이 받지 않고, 필요하면 외부
            링크로 연결합니다.
          </p>
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {rows.map((offer) => (
            <li key={offer.id} className="card p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-[17px] font-semibold">{offer.title}</h2>
                  <p className="mt-1 text-[13px] text-[var(--fg-mute)]">
                    {/* 상태는 라벨 + 공개 여부 문장을 **함께** 적는다. 상태 이름만으로는 공개되는지 알 수 없다 (P-092). */}
                    {STATUS_COPY[offer.status].label} · {STATUS_COPY[offer.status].publicNote}
                    {offer.ownerType === "organization" ? " · 조직 소유" : ""}
                  </p>
                </div>
                <p className="text-[14px] font-semibold">
                  {offer.priceDisplayPolicy === "shown" && offer.priceAmount !== null
                    ? `${offer.priceAmount.toLocaleString("ko-KR")} ${offer.priceCurrency ?? ""}`.trim()
                    : POLICY_COPY[offer.priceDisplayPolicy].label}
                </p>
              </div>

              {offer.description ? (
                <p className="mt-3 whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--fg-mute)]">
                  {offer.description}
                </p>
              ) : null}

              <dl className="disclosure-dl mt-4">
                <dt>판매 기간</dt>
                <dd>
                  {offer.availableUntil
                    ? `${offer.availableUntil.slice(0, 10).replaceAll("-", ".")}까지 — 기간이 지나면 공개 화면에서 내려갑니다`
                    : "기한 없음"}
                </dd>

                <dt>외부 링크</dt>
                <dd>{offer.externalUrl ?? "없음"}</dd>
              </dl>

              {/* ── 상태 전환 ─────────────────────────────── */}
              <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label={`${offer.title} 상태 바꾸기`}>
                {STATUS_ORDER.filter((s) => s !== offer.status).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="btn btn-ghost !min-h-10 text-[13px]"
                    onClick={() => changeStatus(offer.id, s)}
                    disabled={busy !== null}
                    // 버튼 글자는 상태 이름만 두고(조사 없이), 무엇을 바꾸는지는 aria-label 이 문장으로 말한다.
                    aria-label={`${offer.title} 상태를 ${STATUS_COPY[s].label}(으)로 바꾸기`}
                  >
                    {STATUS_COPY[s].label}
                  </button>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-ghost !min-h-10 text-[13px]"
                  onClick={() => {
                    setEditingId((v) => (v === offer.id ? null : offer.id));
                    setCreating(false);
                  }}
                  aria-expanded={editingId === offer.id}
                  disabled={busy !== null}
                >
                  {editingId === offer.id ? "수정 닫기" : "내용 수정"}
                </button>

                {confirmDeleteId === offer.id ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost !min-h-10 text-[13px] text-[var(--caution)]"
                      onClick={() => remove(offer.id)}
                      disabled={busy !== null}
                    >
                      삭제 확정
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost !min-h-10 text-[13px]"
                      onClick={() => setConfirmDeleteId(null)}
                      disabled={busy !== null}
                    >
                      그만두기
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost !min-h-10 text-[13px]"
                    onClick={() => setConfirmDeleteId(offer.id)}
                    disabled={busy !== null}
                  >
                    삭제
                  </button>
                )}
              </div>

              {editingId === offer.id ? (
                <OfferFields
                  initial={draftOf(offer)}
                  busy={busy === offer.id}
                  submitLabel="수정 저장"
                  onSubmit={(d) => update(offer.id, d)}
                  onCancel={() => setEditingId(null)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 생성과 수정이 같은 입력 묶음을 쓴다 — 두 벌로 두면 한쪽에만 필드가 추가된다. */
function OfferFields({
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  busy: boolean;
  submitLabel: string;
  onSubmit: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const needsPrice = draft.priceDisplayPolicy === "shown";
  const id = initial.title === "" ? "new" : "edit";

  return (
    <form
      className="mt-5 flex flex-col gap-5"
      aria-busy={busy}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSubmit(draft);
      }}
    >
      <div>
        <label className="label" htmlFor={`offer-title-${id}`}>
          상품명
        </label>
        <input
          id={`offer-title-${id}`}
          className="field"
          required
          minLength={2}
          maxLength={120}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </div>

      <div>
        <label className="label" htmlFor={`offer-desc-${id}`}>
          설명 (선택)
        </label>
        <textarea
          id={`offer-desc-${id}`}
          className="field"
          rows={4}
          maxLength={2000}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </div>

      <fieldset>
        <legend className="label">가격 표시 방법</legend>
        <div className="flex flex-col gap-2">
          {POLICY_ORDER.map((p) => (
            <label key={p} className="flex items-start gap-3 text-[14.5px]">
              <input
                type="radio"
                name={`price-policy-${id}`}
                value={p}
                checked={draft.priceDisplayPolicy === p}
                onChange={() => setDraft({ ...draft, priceDisplayPolicy: p })}
                className="mt-1"
              />
              <span>
                <span className="font-semibold">{POLICY_COPY[p].label}</span>
                <span className="block text-[13px] text-[var(--fg-mute)]">{POLICY_COPY[p].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* 금액·통화는 '금액 표시'일 때만 의미가 있다. 다른 정책에서는 서버가 값을 비워 저장한다(흘러나갈 길을 만들지 않는다). */}
      {needsPrice ? (
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="flex-1">
            <label className="label" htmlFor={`offer-amount-${id}`}>
              금액
            </label>
            <input
              id={`offer-amount-${id}`}
              className="field"
              type="number"
              min={0}
              step={1}
              required
              value={draft.priceAmount}
              onChange={(e) => setDraft({ ...draft, priceAmount: e.target.value })}
            />
          </div>
          <div className="sm:w-40">
            <label className="label" htmlFor={`offer-currency-${id}`}>
              통화 (ISO 4217)
            </label>
            <input
              id={`offer-currency-${id}`}
              className="field"
              maxLength={3}
              required
              placeholder="KRW"
              value={draft.priceCurrency}
              onChange={(e) => setDraft({ ...draft, priceCurrency: e.target.value.toUpperCase() })}
            />
          </div>
        </div>
      ) : null}

      <div>
        <label className="label" htmlFor={`offer-url-${id}`}>
          외부 링크 (선택)
        </label>
        <input
          id={`offer-url-${id}`}
          className="field"
          type="url"
          maxLength={2048}
          placeholder="https://"
          value={draft.externalUrl}
          onChange={(e) => setDraft({ ...draft, externalUrl: e.target.value })}
          aria-describedby={`offer-url-hint-${id}`}
        />
        <p id={`offer-url-hint-${id}`} className="mt-2 text-[12.5px] text-[var(--fg-mute)]">
          http · https 주소만 쓸 수 있습니다. 결제는 이 링크의 외부 채널에서 이루어집니다.
        </p>
      </div>

      <div>
        <label className="label" htmlFor={`offer-until-${id}`}>
          판매 기간 끝 (선택)
        </label>
        <input
          id={`offer-until-${id}`}
          className="field"
          type="date"
          value={draft.availableUntil}
          onChange={(e) => setDraft({ ...draft, availableUntil: e.target.value })}
          aria-describedby={`offer-until-hint-${id}`}
        />
        <p id={`offer-until-hint-${id}`} className="mt-2 text-[12.5px] text-[var(--fg-mute)]">
          이 날짜가 지나면 공개 화면에서 자동으로 내려갑니다.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "저장 중…" : submitLabel}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          취소
        </button>
      </div>
    </form>
  );
}
