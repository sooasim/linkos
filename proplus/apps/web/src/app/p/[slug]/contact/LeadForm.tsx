"use client";

/**
 * P-100 공개 상담 요청 폼 · P-101 동의 분리 · P-112 스팸 차단 안내 · N-11.
 *
 * ## 동의 체크박스가 두 개인 것이 요구사항이다
 *
 * `consent-service`(필수)와 `consent-marketing`(선택, 기본 해제)은 **서로 다른 노드**다.
 * "약관에 모두 동의" 하나로 묶으면 마케팅 수신이 상담의 조건이 되고, 그건 목적 제한 위반이다
 * (보안정책 §3 / domain/consent.ts 주석). 각 체크박스 옆에 무엇에 쓰는지 한 줄로 적는다.
 *
 * 마케팅 동의는 **해제 상태도 그대로 보낸다**(`granted: false`). 거부를 기록으로 남겨야
 * 나중에 "동의받지 않았다"를 재현할 수 있다 — `consent_records` 는 목적별 한 행씩 쌓인다.
 *
 * ## 필수 동의 검사를 브라우저에 맡기지 않는 이유
 *
 * 체크박스에 `required` 를 걸면 브라우저가 제출 자체를 막고 **우리 메시지 대신** 네이티브 풍선을
 * 띄운다. 어떤 동의가 왜 필요한지 설명할 자리가 사라지므로, 서버 호출 전에 우리가 직접 멈추고
 * `lead-error` 로 말한다. 서버도 같은 규칙을 다시 본다(`validateLeadConsents`) — 화면은 설명이고
 * 판단은 서버다 (전략 §3 계층 규칙).
 *
 * ## 인라인 스크립트가 없다
 *
 * CSP 는 nonce 기반이고(P-042) 인라인 핸들러 문자열을 허용하지 않는다. 일반 client component 의
 * React 이벤트는 번들 안에 있으므로 그대로 동작한다 — `onClick="..."` 같은 문자열을 쓰지 않는다.
 */

import { ClientError, api, uid } from "@/lib/client";
import type { lead } from "@proplus/api";
import { useRef, useState } from "react";

type ContactKind = "email" | "phone";

interface LeadFormProps {
  slug: string;
  /** P-169: 어떤 약관 버전에 동의했는지. 서버 페이지가 내려준다 — 폼이 고정값을 들고 있으면 안 된다. */
  policyVersion: string;
  /** 상품 문의로 들어온 경우. 서버가 "그 프로필의 상품"인지 이미 확인해 넘겨 준 값만 받는다. */
  offerId?: string | null;
  offerTitle?: string | null;
  /** 동의 문구가 가리키는 처리방침 위치. */
  privacyHref: string;
}

/** 서버 응답(P-102): 평문 연락처가 돌아오지 않는다. 접수 확인에는 마스킹 값으로 충분하다. */
type Created = lead.CreatedLead;

const CONTACT_LABEL: Readonly<Record<ContactKind, string>> = {
  email: "이메일",
  phone: "휴대전화 번호",
};

export function LeadForm({ slug, policyVersion, offerId, offerTitle, privacyHref }: LeadFormProps) {
  const [contactKind, setContactKind] = useState<ContactKind>("email");
  const [consentService, setConsentService] = useState(false);
  const [consentMarketing, setConsentMarketing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  /**
   * 재시도 안전성(CLAUDE.md §5): 같은 본문을 다시 보낼 때는 같은 키를 쓴다 — 모바일 네트워크에서
   * 응답을 못 받고 다시 누르는 일이 흔하고, 그때 상담 요청이 두 건으로 쌓이면 안 된다.
   * 반대로 입력이 바뀌면 키를 버린다: 같은 키 + 다른 본문은 서버가 409 로 끊는다(idempotency.ts).
   */
  const retryKey = useRef<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const form = new FormData(e.currentTarget);
    const contactName = String(form.get("contactName") ?? "").trim();
    const contact = String(form.get("contact") ?? "").trim();
    const message = String(form.get("message") ?? "").trim();

    // N-11: service 동의가 없으면 **서버를 부르지 않는다.** 보낼 수 없는 요청을 보내 400 을 받는 것보다
    // 여기서 이유를 말하는 편이 사용자에게 정확하다.
    if (!consentService) {
      setError("상담 처리에 대한 동의가 필요합니다. 아래 ‘상담 처리 동의’를 확인해 주세요.");
      return;
    }
    if (contactName.length === 0 || contact.length === 0) {
      setError("성함과 연락처를 입력해 주세요.");
      return;
    }

    if (!retryKey.current) retryKey.current = uid();
    setSubmitting(true);
    try {
      const result = await api<Created>(`/public/profiles/${encodeURIComponent(slug)}/leads`, {
        method: "POST",
        idempotencyKey: retryKey.current,
        body: {
          contactName,
          contactKind,
          contact,
          message: message.length > 0 ? message : null,
          offerId: offerId ?? null,
          // 목적별로 한 건씩. 묶음 플래그가 아니다 (N-11).
          consents: [
            { purpose: "service", granted: true, policyVersion },
            { purpose: "marketing", granted: consentMarketing, policyVersion },
          ],
        },
      });
      setCreated(result);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <div className="card flex flex-col gap-3 p-6" data-testid="lead-success" role="status">
        <p className="eyebrow">접수 완료</p>
        <h2 className="display text-[26px]">상담 요청을 보냈습니다</h2>
        <p className="text-[15px] leading-relaxed text-[var(--fg-mute)]">
          남겨 주신 {CONTACT_LABEL[contactKind]} <strong className="font-semibold text-[var(--fg)]">{created.contactMasked}</strong> 로
          연락이 갑니다. 답변 시점은 담당자에 따라 다르며, 이 페이지는 응답 시간을 약속하지 않습니다.
        </p>
        <p className="text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
          접수 번호 {created.id.slice(0, 8)} · 남긴 연락처는 암호화해 보관하고, 보존기간이 지나면 삭제합니다. 자세한 내용은{" "}
          <a href={privacyHref} className="font-semibold text-[var(--accent-text)] underline underline-offset-4">
            개인정보 처리방침
          </a>
          에 있습니다.
        </p>
      </div>
    );
  }

  return (
    <form
      data-testid="lead-form"
      onSubmit={onSubmit}
      // 입력이 바뀌면 재시도 키를 버린다(위 retryKey 주석). change 이벤트는 폼까지 올라온다.
      onChange={() => {
        retryKey.current = null;
      }}
      className="flex flex-col gap-5"
    >
      {offerTitle ? (
        <p className="panel px-4 py-3 text-[14px]">
          문의 대상: <strong className="font-semibold">{offerTitle}</strong>
        </p>
      ) : null}

      <div>
        <label className="label" htmlFor="lead-name">
          성함 <span className="text-[var(--caution)]">*</span>
        </label>
        <input
          id="lead-name"
          name="contactName"
          data-testid="lead-name"
          className="field"
          type="text"
          maxLength={80}
          required
          autoComplete="name"
        />
      </div>

      <fieldset>
        <legend className="label">연락 방법</legend>
        <div className="flex gap-2">
          {(["email", "phone"] as const).map((kind) => (
            <label
              key={kind}
              className={`chip cursor-pointer ${contactKind === kind ? "border-[var(--accent)] text-[var(--accent-text)]" : ""}`}
            >
              <input
                type="radio"
                name="contactKind"
                value={kind}
                checked={contactKind === kind}
                onChange={() => setContactKind(kind)}
                className="size-4 accent-[var(--accent)]"
              />
              {CONTACT_LABEL[kind]}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label className="label" htmlFor="lead-contact">
          {CONTACT_LABEL[contactKind]} <span className="text-[var(--caution)]">*</span>
        </label>
        <input
          id="lead-contact"
          name="contact"
          data-testid="lead-contact"
          className="field"
          // 형식 판정은 서버(`isValidContact`)가 한다. type 은 모바일 키보드를 맞추는 역할이다.
          type={contactKind === "email" ? "email" : "tel"}
          inputMode={contactKind === "email" ? "email" : "tel"}
          autoComplete={contactKind === "email" ? "email" : "tel"}
          maxLength={200}
          required
        />
        <p className="mt-1.5 text-[12px] text-[var(--fg-mute)]">
          남긴 연락처는 암호화해 저장하고, 담당자 화면에는 가려진 형태로 보입니다.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="lead-message">
          문의 내용
        </label>
        <textarea
          id="lead-message"
          name="message"
          data-testid="lead-message"
          className="field min-h-28"
          maxLength={2000}
          rows={4}
          placeholder="필요한 것, 일정, 예산 범위 등을 적어 주세요."
        />
      </div>

      {/* ── 동의 (N-11: 두 묶음을 시각적으로도 분리한다 — M07 수용기준) ───────── */}
      <div className="panel flex flex-col gap-4 p-4">
        <div className="flex gap-3">
          <input
            id="consent-service"
            data-testid="consent-service"
            type="checkbox"
            checked={consentService}
            onChange={(e) => setConsentService(e.currentTarget.checked)}
            // required 를 걸지 않는 이유는 파일 상단 주석에 있다. 보조기술에는 필수임을 알린다.
            aria-required="true"
            aria-describedby="consent-service-note"
            className="mt-0.5 size-5 shrink-0 accent-[var(--accent)]"
          />
          <label htmlFor="consent-service" className="flex flex-col gap-1">
            <span className="text-[14.5px] font-semibold">
              상담 처리 동의 <span className="text-[var(--caution)]">(필수)</span>
            </span>
            <span id="consent-service-note" className="text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
              남긴 성함·연락처·문의 내용을 이 상담에 답변하기 위해 사용합니다.
            </span>
          </label>
        </div>

        <hr className="rule" />

        <div className="flex gap-3">
          <input
            id="consent-marketing"
            data-testid="consent-marketing"
            type="checkbox"
            checked={consentMarketing}
            onChange={(e) => setConsentMarketing(e.currentTarget.checked)}
            aria-describedby="consent-marketing-note"
            className="mt-0.5 size-5 shrink-0 accent-[var(--accent)]"
          />
          <label htmlFor="consent-marketing" className="flex flex-col gap-1">
            <span className="text-[14.5px] font-semibold">마케팅 정보 수신 동의 (선택)</span>
            <span id="consent-marketing-note" className="text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
              이 상담과 직접 관련 없는 소식·안내를 받는 데 동의합니다. 동의하지 않아도 상담은 그대로 진행됩니다.
            </span>
          </label>
        </div>
      </div>

      {/* role="alert" 로 두면 메시지가 생기는 순간 스크린리더가 읽는다 (P-193). */}
      {error ? (
        <p
          data-testid="lead-error"
          role="alert"
          className="rounded-[10px] border border-[var(--caution)] bg-[var(--bg-sunk)] px-4 py-3 text-[14px] leading-relaxed text-[var(--caution)]"
        >
          {error}
        </p>
      ) : null}

      <button type="submit" data-testid="lead-submit" className="btn btn-primary btn-lg" disabled={submitting} aria-busy={submitting}>
        {submitting ? "보내는 중…" : "상담 요청 보내기"}
      </button>

      <p className="text-[12px] leading-relaxed text-[var(--fg-mute)]">
        보낸 내용은 이 프로필의 담당자에게만 전달됩니다. 처리 목적과 보존기간은{" "}
        <a href={privacyHref} className="font-semibold text-[var(--accent-text)] underline underline-offset-4">
          개인정보 처리방침
        </a>
        을 따릅니다.
      </p>
    </form>
  );
}

/**
 * 서버가 준 메시지를 기본으로 쓰고(한국어로 이유가 적혀 있다), 사용자가 **다음에 무엇을 할 수 있는지**가
 * 달라지는 상태만 우리 문구로 바꾼다.
 */
function messageFor(e: unknown): string {
  if (e instanceof ClientError) {
    // P-112/P-189: 한도 초과. 재시도 자체가 답이므로 "틀렸다"가 아니라 "잠시 후"라고 말한다.
    if (e.status === 429) return "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
    // 같은 연락처로 방금 접수된 건이 있는 경우(중복 억제) — 서버 문구가 그대로 적절하다.
    if (e.status === 409) return e.message;
    if (e.status === 0) return "네트워크에 연결할 수 없습니다. 연결 상태를 확인한 뒤 다시 보내 주세요.";
    return e.message;
  }
  return "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}
