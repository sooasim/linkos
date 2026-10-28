// 모듈 계층의 호출 문맥. 모든 모듈 함수의 첫 인자다 (전략 §3 계층 규칙: 모듈은 HTTP 객체에 의존하지 않는다).
//
// 왜 HTTP Request 를 넘기지 않는가: 모듈을 워커·CLI·테스트에서도 같은 코드로 호출해야 하고,
// 모듈이 헤더·쿠키를 직접 읽으면 권한 판단이 라우트와 모듈 두 곳에 흩어진다.

export interface Ctx {
  /** 로그인 사용자. 비회원(공개 프로필·공개 상담 폼) 경로에서는 null 이다. */
  userId: string | null;
  /**
   * **이 요청의 세션 행 id** (P-003 / P-005).
   *
   * 토큰이 아니라 id 를 싣는 이유: 라우트 래퍼가 매 요청 토큰을 회전시키므로(P-002)
   * 핸들러가 받는 시점의 토큰은 이미 낡았다. 그러면 "지금 이 기기의 세션"을 가리킬 방법이
   * 없어서 로그아웃이 **모든 기기의 세션을 끊는** 수밖에 없어진다(fail-closed 이지만
   * 휴대폰에서 로그아웃하면 데스크톱도 끊긴다). id 는 회전해도 바뀌지 않으므로 이 문제가 없다.
   *
   * 비회원 경로와 워커에서는 null 이다.
   */
  sessionId: string | null;
  /** 원문 IP 는 저장·로깅하지 않는다 — rate limit 버킷과 visitor 해시 재료로만 쓴다 (N-13). */
  ip: string;
  userAgent: string;
  /** P-187: 응답과 감사로그를 잇는 correlation_id 로 쓴다. */
  requestId: string;
}

/** 워커·마이그레이션처럼 사용자 요청이 없는 실행 경로의 문맥. actor 가 없다는 사실을 명시적으로 남긴다. */
export function systemCtx(requestId: string): Ctx {
  return { userId: null, sessionId: null, ip: "127.0.0.1", userAgent: "proplus-worker", requestId };
}
