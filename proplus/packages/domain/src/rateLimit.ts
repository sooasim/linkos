/**
 * 행위별 rate limit — P-189 (보안정책 §2 "계정 탈취" / "스팸 리드").
 *
 * 왜 고정 윈도(fixed window)인가:
 *   DB 테이블이 `rate_limits(bucket, window_start)` 를 PK 로 쓴다(0001_proplus_core.sql).
 *   즉 카운터 한 행이 윈도 하나다 — `UPSERT ... count = count + 1` 한 번으로 끝나고
 *   Redis 가 필요 없다. 슬라이딩 윈도는 요청마다 기록을 남겨야 해서 공개 폼(P-100)
 *   트래픽에 쓰기 비용이 그만큼 붙는다. 경계에서 최대 2배를 허용하는 것은 감수한다.
 *
 * 이 파일은 판정만 한다. 카운터 증가·조회는 `services/api/src/lib/limits.ts` 가 한다.
 */

import { createHash } from "node:crypto";

export interface Limit {
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * 한도값의 근거:
 *   login          로그인 시도는 사람이 15분에 5번 이상 틀릴 일이 드물다 (보안정책 §2)
 *   lead.create    공개 폼이므로 스팸 표면이다. 실제 상담 요청은 10분에 5건을 넘지 않는다
 *   evidence.submit 증거 업로드는 수동 검토 큐를 만든다 — 큐 폭주를 막는 것이 목적이다
 *   profile.update 자동 저장을 허용하되 무한 루프는 막는 수준
 *   search         탐색은 연속적이라 넉넉해야 한다. 분당 60 = 초당 1
 *   public.view    공개 프로필 조회. 사람의 클릭 속도 상한이자 스크래핑 하한
 */
export const RATE_LIMITS: Record<string, Limit> = {
  login: { limit: 5, windowMs: 15 * MINUTE },
  "lead.create": { limit: 5, windowMs: 10 * MINUTE },
  "evidence.submit": { limit: 20, windowMs: HOUR },
  "profile.update": { limit: 60, windowMs: HOUR },
  search: { limit: 60, windowMs: MINUTE },
  "public.view": { limit: 240, windowMs: MINUTE },
  /**
   * 신고 접수 (P-167). 한도를 낮게 두는 이유는 스팸 방어가 아니라 **표적 신고 방어**다 —
   * 한 사람이 특정 프로필에 신고를 쏟아부어 운영 큐를 막고 그 프로필을 사실상 정지시키는
   * 패턴이 트러스트&세이프티에서 흔하다. 정당한 신고자가 10분에 3건을 넘길 이유는 없다.
   *
   * 이 버킷이 없으면 `DEFAULT_LIMIT`(30/분)으로 떨어진다 — 분당 30건의 신고는 방어가 아니다.
   */
  "report.create": { limit: 3, windowMs: 10 * MINUTE },
};

/**
 * 등록되지 않은 이름에 쓰는 기본값.
 *
 * 왜 `allowed:true` 로 흘려보내지 않는가: 버킷 이름 오타 하나로 한도가 **조용히 사라진다.**
 * 보수적 기본값이면 오타는 "너무 빨리 429 가 뜬다"로 드러나고, 그건 고칠 수 있는 버그다.
 */
export const DEFAULT_LIMIT: Limit = { limit: 30, windowMs: MINUTE };

export function limitFor(name: string): Limit {
  // `Object.hasOwn` 을 쓰는 이유: 첨자 조회는 **프로토타입 멤버를 집어낸다.**
  // `RATE_LIMITS["toString"]` 은 undefined 가 아니라 함수이므로 `?? DEFAULT_LIMIT` 를
  // 통과하지 못하고, 그 결과 `windowMs` 가 undefined 가 되어 retryAfterSec 은 NaN
  // (`Retry-After: NaN`), windowStartFor 는 Invalid Date 를 돌려주고 카운터 INSERT 가 실패한다.
  // 즉 "toString"·"constructor" 같은 이름을 쓰는 순간 한도가 조용히 사라진다.
  return Object.hasOwn(RATE_LIMITS, name) ? (RATE_LIMITS[name] as Limit) : DEFAULT_LIMIT;
}

/**
 * 현재 윈도의 사용량(`used`)이 한도를 넘었는지 본다.
 *
 * `windowStart` 가 이미 지난 윈도라면 `used` 는 낡은 숫자다 — 호출부가 윈도를 새로
 * 열 것이므로 통과시킨다. 이 판정을 도메인에 둔 이유는 "경계에서 한 번 더 허용되는가"를
 * 단위테스트로 못 박을 수 있어서다.
 */
export function checkLimit(
  name: string,
  used: number,
  windowStart: Date | string,
  now: Date | string,
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const { limit, windowMs } = limitFor(name);
  const startMs = toMs(windowStart);
  const nowMs = toMs(now);

  // 시각을 못 읽으면 판정을 포기하지 않고 막는다 — 열어 두면 한도가 없어지는 쪽이다.
  if (startMs === null || nowMs === null) {
    return { allowed: false, retryAfterSec: Math.ceil(windowMs / 1000) };
  }

  const endMs = startMs + windowMs;
  if (nowMs >= endMs) return { allowed: true };
  if (used < limit) return { allowed: true };

  // Retry-After 는 초 단위이고 0 은 "즉시 재시도"로 읽힌다 — 최소 1초를 보장한다 (P-187).
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((endMs - nowMs) / 1000)) };
}

/**
 * 카운터 행의 키.
 *
 * `who`(IP·이메일·사용자 ID)를 **해시해서** 넣는다. 이 테이블에는 보존기간 정책이
 * 아직 없고(전략 §8), 평문 IP·이메일이 쌓이면 그 자체로 개인정보 저장소가 된다
 * (N-13 / 보안정책 §3 — analytics_events 가 `visitor_hash` 만 두는 것과 같은 이유).
 * 행위 이름은 평문으로 남겨 운영자가 어떤 버킷이 터지는지 바로 읽을 수 있게 한다.
 */
export function bucketKey(name: string, who: string): string {
  // `who` 를 정규화해서 해시한다. 정규화하지 않으면 `"A@b.com"` 과 `"a@b.com"` 이 **다른 버킷**이
  // 되어, 대소문자만 바꿔 가며 로그인 시도 한도를 무한히 늘릴 수 있다 (P-004 "동일 식별자 기준").
  // 호출부에 맡기면 한 군데라도 빠뜨리는 순간 한도가 뚫리므로 여기서 한다.
  const subject = createHash("sha256").update(who.trim().toLowerCase(), "utf8").digest("hex").slice(0, 32);
  return `${name}:${subject}`;
}

/** 고정 윈도의 시작 시각. 같은 윈도 안의 모든 요청이 같은 행을 가리켜야 UPSERT 가 성립한다. */
export function windowStartFor(name: string, now: Date | string): Date {
  const { windowMs } = limitFor(name);
  const nowMs = toMs(now);
  if (nowMs === null) throw new Error("windowStartFor: 시각을 해석할 수 없다");
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

function toMs(v: Date | string): number | null {
  const d = v instanceof Date ? v : new Date(v);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}
