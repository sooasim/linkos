// P-185 Idempotency-Key (데이터모델 §5 / CLAUDE.md §3 "모든 create/update API 는 Idempotency-Key 를 지원한다").
//
// 왜 요청 해시를 같이 저장하는가: 같은 키로 **다른 본문**을 보내는 것은 재시도가 아니라 클라이언트 버그다.
// 그걸 "첫 응답 재생"으로 처리하면 사용자는 보내지도 않은 결과를 받는다. 409 로 끊는다.
//
// 왜 응답을 암호화하는가: 저장되는 본문에 리드 연락처나 일회성 토큰(초대·로그인)이 들어갈 수 있다.
// 재시도 캐시가 PII 사본 저장소가 되지 않게, 평문으로 저장하는 경로를 아예 두지 않는다 (보안정책 §3).
import { createHash } from "node:crypto";
import { one, pool } from "./db";
import { decryptField, encryptField } from "./crypto";
import { conflict } from "./errors";

interface StoredRow {
  request_hash: string;
  status: number;
  response: unknown;
}

function requestHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

/** 클라이언트가 만든 불투명 키. 너무 짧은 키는 다른 사용자의 재시도와 충돌할 수 있어 길이를 요구한다. */
export function isValidIdempotencyKey(key: string | null | undefined): key is string {
  return !!key && /^[A-Za-z0-9_.:-]{8,128}$/.test(key);
}

/**
 * (scope, key) 의 캐시된 응답을 찾는다.
 * @throws 같은 키가 다른 본문으로 재사용되면 409 `idempotency_key_reused`
 */
export async function idempotencyLookup<T>(
  scope: string,
  key: string,
  requestBody: unknown,
): Promise<{ status: number; body: T } | null> {
  const row = await one<StoredRow>("SELECT request_hash, status, response FROM idempotency_keys WHERE scope=$1 AND key=$2", [scope, key]);
  if (!row) return null;
  if (row.request_hash !== requestHash(requestBody)) {
    throw conflict("idempotency_key_reused", "같은 Idempotency-Key 로 다른 요청을 보낼 수 없습니다.");
  }
  const sealed = (row.response as { sealed?: unknown } | null)?.sealed;
  if (typeof sealed !== "string") throw new Error("저장된 idempotency 응답 형식이 올바르지 않습니다");
  return { status: row.status, body: JSON.parse(decryptField(sealed, `idem:${scope}:${key}`)) as T };
}

/**
 * 첫 응답을 저장한다. 경쟁 상태(같은 키 동시 2건)에서는 먼저 쓴 쪽이 이기고 뒤는 조용히 무시한다 —
 * 두 응답 중 하나를 고르는 것보다 `ON CONFLICT DO NOTHING` 이 재시도에서 일관된 값을 주기 때문이다.
 */
export async function idempotencyStore(scope: string, key: string, requestBody: unknown, status: number, body: unknown): Promise<void> {
  const sealed = encryptField(JSON.stringify(body ?? null), `idem:${scope}:${key}`);
  await pool().query(
    `INSERT INTO idempotency_keys (scope, key, request_hash, status, response)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [scope, key, requestHash(requestBody), status, JSON.stringify({ sealed })],
  );
}
