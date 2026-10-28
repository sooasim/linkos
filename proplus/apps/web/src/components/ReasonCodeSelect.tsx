"use client";

/**
 * P-162 사유 코드 입력 — 반려·취소에 **필수**인 값(데이터모델 §4).
 *
 * ## 왜 드롭다운이 아닌가
 *
 * 확정된 사유 코드 목록은 아직 없다. 반려 사유 분류는 첫 파일럿 직군이 정해진 뒤 운영이 채우는
 * 값이고(전략 §8 / 미결정 §2), 모듈은 **모양만** 검사한다(`^[a-z][a-z0-9_.:-]{1,59}$`).
 * 그래서 이 컴포넌트는 자유 입력 + 예시 제안(`<datalist>`)이다:
 *   - 드롭다운만 두면 확정되지 않은 목록이 확정된 정책처럼 보이고, 맞는 항목이 없을 때
 *     운영자가 "그중 아무거나"를 고른다. 그러면 집계는 돌아가지만 내용이 거짓이 된다.
 *   - 자유 문장을 그대로 받으면 코드 컬럼에 문장이 들어가 집계가 깨진다. 그래서 모양은 강제한다.
 *
 * 사유 코드는 **당사자에게 보일 문구가 아니다.** 통지 문구는 전이 요청의 `message` 이고,
 * N-14 에 따라 확정적 비난 표현을 쓰지 않는다. 이 둘을 섞지 않도록 화면에서도 분리해 적는다.
 *
 * TODO(운영): 코드 목록이 확정되면 아래 예시를 그 목록으로 교체하고, 그때도 자유 입력은 남긴다
 *   (목록 밖 사유를 "기타"로 뭉개면 반려 품질 측정이 불가능해진다).
 */

/** 모듈 `admin.ts` 의 `REASON_CODE_RE` 와 같은 모양. 어긋나면 서버가 400 으로 돌려보낸다. */
export const REASON_CODE_RE = /^[a-z][a-z0-9_.:-]{1,59}$/;

/**
 * 입력 예시다. **확정 목록이 아니다** — 화면에도 그렇게 적는다(브랜드 §5: 없는 것을 있는 것처럼 적지 않는다).
 */
const REASON_CODE_EXAMPLES: readonly { code: string; hint: string }[] = [
  { code: "document_illegible", hint: "제출 서류를 읽을 수 없음" },
  { code: "document_expired", hint: "서류의 유효기간이 지남" },
  { code: "scope_mismatch", hint: "서류 내용이 주장한 범위와 다름" },
  { code: "issuer_unconfirmed", hint: "발급기관을 확인할 수 없음" },
  { code: "evidence_insufficient", hint: "주장을 뒷받침할 근거가 부족함" },
  { code: "duplicate_submission", hint: "같은 내용이 이미 처리됨" },
];

/** 비어 있거나 모양이 틀렸으면 사람이 읽을 메시지를, 괜찮으면 null 을 돌려준다. */
export function reasonCodeError(value: string): string | null {
  const v = value.trim();
  if (v.length === 0) return "사유 코드를 입력해야 합니다.";
  if (!REASON_CODE_RE.test(v)) {
    return "소문자로 시작하고 소문자·숫자·_ . : - 만 쓰는 2~60자 코드여야 합니다.";
  }
  return null;
}

interface ReasonCodeSelectProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  label?: string;
  /** 제출을 시도한 뒤에만 오류를 보여주고 싶을 때 false 로 둔다. */
  showError?: boolean;
  disabled?: boolean;
}

export function ReasonCodeSelect({
  id,
  value,
  onChange,
  label = "사유 코드",
  showError = true,
  disabled = false,
}: ReasonCodeSelectProps) {
  const listId = `${id}-examples`;
  const noteId = `${id}-note`;
  const errorId = `${id}-error`;
  const error = reasonCodeError(value);
  const invalid = showError && error !== null;

  return (
    <div className="flex flex-col">
      <label className="label" htmlFor={id}>
        {label} <span aria-hidden="true">·</span> 필수
      </label>
      <input
        id={id}
        className="field"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required
        autoComplete="off"
        spellCheck={false}
        placeholder="예: document_illegible"
        aria-invalid={invalid}
        aria-describedby={invalid ? `${noteId} ${errorId}` : noteId}
      />
      <datalist id={listId}>
        {REASON_CODE_EXAMPLES.map((x) => (
          <option key={x.code} value={x.code} label={`${x.code} — ${x.hint}`} />
        ))}
      </datalist>

      <p id={noteId} className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
        집계용 코드입니다. 당사자에게 보이는 안내 문구는 아래 “당사자 안내”에 적습니다. 아래 예시는 입력을 돕기
        위한 것이며 확정된 목록이 아닙니다.
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {REASON_CODE_EXAMPLES.map((x) => (
          <li key={x.code}>
            <button
              type="button"
              className="chip text-[var(--fg-mute)] hover:border-[var(--accent)] hover:text-[var(--accent-text)]"
              onClick={() => onChange(x.code)}
              disabled={disabled}
            >
              {x.code}
            </button>
          </li>
        ))}
      </ul>

      {invalid ? (
        <p id={errorId} className="mt-1.5 text-[12.5px] font-semibold text-[var(--caution)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
