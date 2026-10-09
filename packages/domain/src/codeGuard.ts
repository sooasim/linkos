// F-045 / F-171 — 4자리 교환 코드 추측 방어의 판단 로직. 순수 함수(I/O 없음)라 단위테스트로 전부 덮는다.
//
// 왜 따로 떼어냈나:
// 코드 공간이 10,000가지뿐이라 방어가 제품의 안전성을 사실상 결정한다. 이전 구현은 서비스 전체 "틀린 코드"
// 카운터가 한도를 넘으면 **모든** 코드 조회를 거부했는데, 이는 두 가지로 잘못됐다.
//
//   1) self-DoS. 봇넷이 틀린 코드 3,000개만 던지면 10분 동안 정상 사용자의 코드 교환까지 전부 막힌다.
//      방어 장치가 그대로 서비스 거부 수단이 된다 — 공격자에게 가장 싼 공격이 된 셈이다.
//   2) 전역 한도는 실패만 센다. 성공한 추측은 세지 않으므로, 전역 한도에 닿기 전까지 공격자가 맞춘 코드는
//      공짜다. 살아 있는 코드가 N개일 때 시도 1회의 성공 확률은 N/10,000 이다.
//
// 지금 방식: 전역 압력은 **전면 차단이 아니라 IP별 허용치를 좁히는 신호**로 쓴다.
//   - 평시: IP당 10분 8회 · 하루 30회 "틀린 코드" 까지 허용(정상 사용자는 보통 한 번에 맞힌다).
//   - 전역 압력 상태(10분간 전체 실패가 한도 초과): 이미 틀린 적 있는 IP는 즉시 막고,
//     **아직 한 번도 틀리지 않은 IP는 그대로 통과시킨다.** 공격자의 IP당 예산은 8 → strictIpLimit 로 줄고,
//     코드를 제대로 입력하는 정상 사용자는 영향을 받지 않는다.
//
// 남는 위험(정직하게): IP를 충분히 많이 가진 분산 공격자는 여전히 쓸어볼 수 있다. IP마다 첫 시도는 통과하기
// 때문이다. 이걸 근본적으로 막으려면 코드 엔트로피를 올리거나(= 4자리라는 F-045 제품 결정을 바꾸거나)
// 코드를 기기·세션에 묶어야 한다. 그건 제품 결정이라 여기서 하지 않는다. 대신 전역 압력이 걸린 사실을
// 호출부가 관측할 수 있게 `underPressure` 로 알린다.

export interface CodeGuardLimits {
  /** IP별 짧은 창(기본 10분) */
  ipWindow: { limit: number; sec: number };
  /** IP별 하루 */
  ipDay: { limit: number; sec: number };
  /** 서비스 전체 압력. 넘으면 전면 차단이 아니라 IP별 허용치를 strictIpLimit 로 좁힌다. */
  global: { limit: number; sec: number; strictIpLimit: number };
}

export interface CodeGuardCounts {
  /** 이 IP 가 짧은 창 안에서 틀린 횟수 */
  ipFails: number;
  /** 이 IP 가 하루 안에서 틀린 횟수 */
  ipDayFails: number;
  /** 서비스 전체가 짧은 창 안에서 틀린 횟수 */
  globalFails: number;
}

export type CodeGuardDenyReason = "ip_window" | "ip_day" | "global_pressure";

export type CodeGuardDecision =
  | { allow: true; underPressure: boolean }
  | { allow: false; reason: CodeGuardDenyReason; retryAfterSec: number; underPressure: boolean };

/** 짧은 창이 아닌 이유로 막을 때 알려줄 재시도 간격(초). */
const SHORT_RETRY_SEC = 60;

/**
 * 코드 조회를 허용할지 판단한다. 전체 토큰(/x/{token}) 경로에는 쓰지 않는다 — 128bit 이상이라 추측이 불가능하다.
 * 호출 순서상 더 구체적인 이유(IP별)를 먼저 돌려주어, 429 를 받은 쪽이 원인을 구분할 수 있게 한다.
 */
export function decideCodeLookup(counts: CodeGuardCounts, limits: CodeGuardLimits): CodeGuardDecision {
  const underPressure = counts.globalFails >= limits.global.limit;

  if (counts.ipFails >= limits.ipWindow.limit) {
    return { allow: false, reason: "ip_window", retryAfterSec: limits.ipWindow.sec, underPressure };
  }
  if (counts.ipDayFails >= limits.ipDay.limit) {
    return { allow: false, reason: "ip_day", retryAfterSec: SHORT_RETRY_SEC, underPressure };
  }
  // 전역 압력: 전면 차단 대신 "이미 틀린 적 있는 IP" 만 막는다. 깨끗한 IP 는 통과 — self-DoS 를 만들지 않는다.
  if (underPressure && counts.ipFails >= limits.global.strictIpLimit) {
    return { allow: false, reason: "global_pressure", retryAfterSec: limits.ipWindow.sec, underPressure };
  }
  return { allow: true, underPressure };
}
