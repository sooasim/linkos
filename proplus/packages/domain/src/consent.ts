/**
 * 동의 정책 — N-11 (모듈명세 M07 / 보안정책 §3 "목적 제한").
 *
 * P-008 동의 기록 (종류별 분리) · P-101 리드 생성 시 동의 분리 기록
 *
 * 왜 이 모듈이 따로 있는가:
 *   상담 요청 폼은 "동의합니다" 체크 하나로 끝내려는 압력이 가장 센 화면이다.
 *   한 번 묶이면 마케팅 수신 동의가 서비스 이용의 **조건**이 되고, 그건 목적 제한 위반이다
 *   (보안정책 §3). 그래서 "무엇이 필수인가"를 폼이나 라우트가 아니라 여기 상수 하나로 고정하고,
 *   그 상수를 테스트가 지킨다 — `REQUIRED_FOR_LEAD` 에 'marketing' 을 넣는 PR 은 테스트에서 터진다.
 *
 * 저장은 `consent_records`(purpose enum + policy_version)가 받는다. 한 행에 여러 목적을 담는
 * 컬럼이 스키마에 아예 없다는 점이 이 규칙의 DB 쪽 짝이다 (0001_proplus_core.sql §M01).
 */

import { CONSENT_PURPOSES, type ConsentPurpose } from "./types";

/** 폼·API 가 보내는 동의 한 건. 목적마다 한 건씩 온다 — 묶음 플래그가 아니다. */
export interface ConsentInput {
  purpose: ConsentPurpose;
  granted: boolean;
  /** 어떤 약관 버전에 동의했는지 (P-169). 나중에 "무엇에 동의했나"를 재현하려면 이게 있어야 한다. */
  policyVersion: string;
}

/**
 * 리드(상담 요청) 생성에 **반드시** 필요한 동의.
 *
 * 'service' 하나뿐이다. 상담을 처리하려면 문의 내용과 연락처를 쓸 근거가 필요하지만,
 * 마케팅 발송은 상담 처리에 필요하지 않다 — 필요하지 않은 것을 필수로 만들면
 * 동의가 동의가 아니게 된다 (보안정책 §3). 'marketing' 은 **절대** 이 배열에 들어가지 않는다.
 */
export const REQUIRED_FOR_LEAD: readonly ConsentPurpose[] = ["service"];

export type ConsentResult = { ok: true } | { ok: false; code: string; message: string };

/** 저장된 동의 이력 한 행. `consent_records` 에서 읽은 것도, 입력도 그대로 받는다. */
export interface ConsentRecordLike {
  purpose: ConsentPurpose;
  granted: boolean;
  /** 있으면 시각 순으로 판정한다. 없으면 배열 순서를 시간 순(오래된 것 먼저)으로 본다. */
  createdAt?: Date | string | null;
}

const VALID_PURPOSES: ReadonlySet<string> = new Set<string>(CONSENT_PURPOSES);

/**
 * 리드 생성 전 동의 검사.
 *
 * 통과 조건은 하나다: `service` 가 `granted=true` 로 들어왔다.
 * 'marketing' 이 없어도, 거부돼 있어도 통과한다 — 그게 "선택"의 의미다.
 *
 * 추가로 두 가지를 막는다(계약서의 거부 목록에는 없지만 저장이 불가능한 입력이다):
 *   - 알 수 없는 purpose: 타입은 컴파일 시점만 지키므로 HTTP 본문은 런타임에 걸러야 한다.
 *     `consent_purpose` enum 밖의 값은 INSERT 가 실패한다.
 *   - 빈 policyVersion: `consent_records.policy_version` 이 NOT NULL 이고, 버전 없는 동의는
 *     나중에 "무엇에 동의했는지" 말할 수 없어 기록으로서 쓸모가 없다 (P-169).
 */
export function validateLeadConsents(inputs: readonly ConsentInput[]): ConsentResult {
  const seen = new Map<ConsentPurpose, boolean>();

  for (const c of inputs) {
    if (!VALID_PURPOSES.has(c.purpose)) {
      return { ok: false, code: "unknown_consent_purpose", message: "알 수 없는 동의 목적입니다." };
    }
    if (typeof c.policyVersion !== "string" || c.policyVersion.trim() === "") {
      return { ok: false, code: "policy_version_required", message: "동의 약관 버전이 필요합니다." };
    }
    // 같은 목적에 true 와 false 가 같이 오면 어느 쪽이 사용자의 뜻인지 알 수 없다.
    // 임의로 해석해 저장하는 것(특히 true 로 해석하는 것)이 가장 위험하므로 거부한다.
    const prev = seen.get(c.purpose);
    if (prev !== undefined && prev !== c.granted) {
      return { ok: false, code: "consent_conflict", message: "같은 목적에 상충하는 동의가 들어왔습니다." };
    }
    seen.set(c.purpose, c.granted);
  }

  for (const required of REQUIRED_FOR_LEAD) {
    if (seen.get(required) !== true) {
      return { ok: false, code: "consent_required", message: "상담 처리에 대한 동의가 필요합니다." };
    }
  }

  return { ok: true };
}

/**
 * 이 목적에 대한 현재 동의 상태.
 *
 * `consent_records` 는 append-only 성격이라 같은 목적의 행이 여러 개 쌓인다
 * (동의 → 철회 → 재동의). **철회가 이겨야** 하므로 "하나라도 true 면 true"가 아니라
 * **가장 최근 기록**을 따른다. 철회를 못 이기게 만들면 수신 거부가 작동하지 않는다.
 */
export function hasConsent(records: readonly ConsentRecordLike[], purpose: ConsentPurpose): boolean {
  const matching = records.filter((r): r is ConsentRecordLike => !!r && r.purpose === purpose);
  if (matching.length === 0) return false;

  // 두 시간 축을 **섞지 않는다.** 섞으면 epoch ms(~1.7e12)와 배열 인덱스(0,1,2…)를
  // 같은 수직선에서 비교하게 되고, DB 에서 읽은 옛 동의 뒤에 방금 들어온 철회(타임스탬프 없음)를
  // 붙이면 옛 동의가 이긴다 — 철회가 작동하지 않는다는 뜻이고 N-11 의 실질적 위반이다.
  //
  // 그래서 규칙을 하나로 고정한다: **전부 타임스탬프가 있으면 타임스탬프로, 하나라도 없으면 배열 순서로** 판정한다.
  const times = matching.map((r) => toTime(r.createdAt));
  const allTimed = times.every((t) => t !== null);

  if (!allTimed) {
    // 배열 순서가 시간 축이다 — 마지막 기록이 현재 상태다.
    return matching[matching.length - 1]?.granted === true;
  }

  let best = matching[0];
  let bestAt = times[0] as number;
  for (let i = 1; i < matching.length; i++) {
    const at = times[i] as number;
    // 같은 시각이면 배열 뒤쪽(나중에 읽힌 행)을 최신으로 본다.
    if (at >= bestAt) {
      best = matching[i];
      bestAt = at;
    }
  }
  return best?.granted === true;
}

/**
 * 필수 동의와 선택 동의를 나눈다.
 *
 * UI 가 두 묶음을 **시각적으로도 분리**해 그리게 하려는 것이다 (모듈명세 M07 수용기준).
 * 선택 동의를 필수 묶음 안에 섞어 그리면 체크박스가 하나뿐인 폼과 실질적으로 같아진다.
 */
export function separateConsents(inputs: readonly ConsentInput[]): {
  required: ConsentInput[];
  optional: ConsentInput[];
} {
  const required: ConsentInput[] = [];
  const optional: ConsentInput[] = [];
  for (const c of inputs) {
    if (REQUIRED_FOR_LEAD.includes(c.purpose)) required.push(c);
    else optional.push(c);
  }
  return { required, optional };
}

function toTime(v: Date | string | null | undefined): number | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}
