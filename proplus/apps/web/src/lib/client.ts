"use client";

/**
 * 브라우저에서 /api/v1 을 호출하는 얇은 래퍼.
 *
 * LINKOS 의 client.ts 와 달리 **오프라인 아웃박스가 없다.** 베끼지 않은 이유:
 * LINKOS 는 "만난 자리에서 지하 주차장에서도 명함을 받아야" 하지만, PROPLUS 의 쓰기는
 * 증거 제출·상담 응답처럼 책상에서 일어나고, 사용자 기기에 증거·고객 PII 사본을 남기는 것은
 * 보안정책 §2("증빙 파일 유출", "고객 PII")와 정면으로 충돌한다.
 * 그래서 실패는 조용히 큐에 넣지 않고 **사용자에게 그대로 알린다.**
 */

export class ClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

interface ApiInit {
  method?: string;
  body?: unknown;
  /** 재시도를 안전하게 만들려면 같은 키로 보낸다 (CLAUDE.md §5). 생략하면 자동 생성된다. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const mutating = method !== "GET" && method !== "HEAD";
  const idempotencyKey = init.idempotencyKey ?? (mutating ? uid() : undefined);

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      // 세션 쿠키는 same-origin 으로만 보낸다. 서버도 쓰기 요청의 Origin 을 검사한다 (server.ts).
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal,
    });
  } catch {
    throw new ClientError(0, "network_error", "네트워크에 연결할 수 없습니다. 연결 상태를 확인하세요.");
  }

  const contentType = res.headers.get("content-type") ?? "";
  const data: unknown = contentType.includes("application/json") ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const d = (data ?? {}) as { code?: string; message?: string; details?: unknown };
    throw new ClientError(res.status, d.code ?? "error", d.message ?? "요청을 처리하지 못했습니다.", d.details);
  }
  return data as T;
}

/** 증거 파일 업로드 (P-050). 본문이 바이너리라 api() 와 헤더가 다르다. */
export async function upload<T>(
  path: string,
  blob: Blob,
  opts: { method?: "POST" | "PUT"; filename?: string; idempotencyKey?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: opts.method ?? "POST",
      headers: {
        "content-type": blob.type || "application/octet-stream",
        // 파일명은 한글·공백을 포함할 수 있으므로 헤더에 넣을 때 인코딩한다.
        ...(opts.filename ? { "x-file-name": encodeURIComponent(opts.filename) } : {}),
        ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: blob,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ClientError(0, "network_error", "네트워크에 연결할 수 없습니다.");
  }

  const data: unknown = (res.headers.get("content-type") ?? "").includes("application/json")
    ? await res.json().catch(() => null)
    : null;
  if (!res.ok) {
    const d = (data ?? {}) as { code?: string; message?: string; details?: unknown };
    throw new ClientError(res.status, d.code ?? "error", d.message ?? "업로드하지 못했습니다.", d.details);
  }
  return data as T;
}

export function uid(): string {
  return crypto.randomUUID();
}

/**
 * 날짜 표기. 검증일·만료일은 **UTC 날짜를 그대로** 쓴다 —
 * 서버와 클라이언트가 같은 문자열을 만들어야 하이드레이션이 어긋나지 않고,
 * "언제 확인했는가"는 보는 사람의 시간대에 따라 달라져서는 안 되는 사실이다 (보안정책 §4.1).
 */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.replaceAll("-", ".") : "";
}

/** 시각까지 보여야 하는 운영 화면용(감사로그·검토 큐). 사용자 로컬 시간대로 그린다. */
export function fmtDateTime(value: string | Date | null | undefined, lang = "ko-KR"): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(d);
}
