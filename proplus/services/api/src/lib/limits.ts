// P-189 rate limit 공통 구현 (보안정책 §2 계정 탈취 · 스팸 리드).
//
// 왜 Postgres 카운터인가: Redis 를 추가하지 않는다는 결정(전략 §6)과 같은 이유다 —
// 요구사항은 "행위별 한도 + 초과 시 429 + retry-after"이고 고정창 카운터는 테이블 하나로 충분하다.
// 인메모리 카운터와 달리 인스턴스를 늘려도 실질 한도가 인스턴스 수만큼 늘어나지 않는다.
//
// 한도 값과 판정은 `@proplus/domain/rateLimit` 에 있다 — I/O 없는 순수 함수라 경계 조건을 전수 테스트할 수 있다.
// 이 파일이 하는 일은 카운터를 올리고 판정 결과를 HTTP 에러로 바꾸는 것뿐이다.
import { RATE_LIMITS, bucketKey, checkLimit, windowStartFor } from "@proplus/domain";
import { one, q } from "./db";
import { tooMany } from "./errors";
import { log } from "./log";

/**
 * 한 번의 행위를 소비하고 한도를 넘었으면 429 를 던진다.
 *
 * @param name `RATE_LIMITS` 의 키 (`login`, `lead.create`, `evidence.submit`, ...).
 *   등록되지 않은 이름은 도메인의 보수적 기본값(DEFAULT_LIMIT)으로 판정된다 — 오타가 "한도 없음"이 되지 않게.
 *   다만 조용히 넘기면 아무도 오타를 모르므로 로그로 드러낸다.
 * @param who 주체 식별자(사용자 id · 이메일 · IP). `bucketKey()` 가 해시하므로 원문은 DB 에 남지 않는다 (N-13).
 * @throws ApiError(429, 'rate_limited') — details.retryAfter 초
 */
export async function consumeLimit(name: string, who: string): Promise<void> {
  // 테스트·로컬에서 한도가 시나리오를 막는 경우의 탈출구. 운영 env 에는 넣지 않는다.
  if (process.env.RATE_LIMIT_DISABLED === "1") return;
  if (!RATE_LIMITS[name]) log("warn", "limits.unknown_bucket", { bucket: name });

  const now = new Date();
  const windowStart = windowStartFor(name, now);
  const row = await one<{ count: number }>(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1,$2,1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [bucketKey(name, who), windowStart],
  );

  // UPSERT 가 돌려준 count 는 **이번 요청까지 포함한** 값이다. checkLimit 은 "이번 요청 전까지 쓴 양"을 받으므로
  // 1 을 뺀다. 이렇게 해야 limit=5 일 때 5번째 요청이 통과하고 6번째가 막힌다.
  const used = Math.max(0, (row?.count ?? 1) - 1);
  const verdict = checkLimit(name, used, windowStart, now);
  if (!verdict.allowed) throw tooMany(verdict.retryAfterSec);
}

/** 지난 창의 카운터 정리. 워커 tick 에서 호출한다 — 이 테이블에는 보존기간 정책이 없으므로 코드가 지운다. */
export async function purgeOldLimitWindows(): Promise<void> {
  await q("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'");
}
