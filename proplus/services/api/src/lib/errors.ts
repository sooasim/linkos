// P-187 에러 응답 규격 (데이터모델 §5): code · message · correlation_id 만 내보내고 stack trace 는 노출하지 않는다.
//
// 왜 전용 에러 클래스인가: 라우트 핸들러가 status 를 직접 고르면 같은 실패가 어떤 경로에서는 500 으로 나간다.
// 모듈 계층이 의미(code)를 던지고 라우트는 그대로 직렬화하기만 하게 만든다.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

export const badRequest = (code: string, msg?: string, details?: unknown) => new ApiError(400, code, msg, details);
export const unauthorized = (msg = "로그인이 필요합니다.") => new ApiError(401, "unauthorized", msg);
export const forbidden = (msg = "권한이 없습니다.") => new ApiError(403, "forbidden", msg);
export const notFound = (what = "resource") => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (code: string, msg?: string, details?: unknown) => new ApiError(409, code, msg, details);

// P-189: 초과 응답에는 retry-after 가 따라가야 한다. 클라이언트가 재시도 간격을 추측하지 않게 한다.
export const tooMany = (retryAfterSec: number) =>
  new ApiError(429, "rate_limited", "요청이 너무 많습니다. 잠시 후 다시 시도하세요.", { retryAfter: retryAfterSec });

export const unavailable = (code: string, msg?: string) => new ApiError(503, code, msg);
