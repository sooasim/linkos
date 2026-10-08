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
export const gone = (code: string, msg?: string) => new ApiError(410, code, msg);
export const tooMany = (retryAfter: number) => new ApiError(429, "rate_limited", "요청이 너무 많습니다. 잠시 후 다시 시도하세요.", { retryAfter });
export const unavailable = (code: string, msg?: string) => new ApiError(503, code, msg);
