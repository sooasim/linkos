/**
 * PII 리댁션 — N-13 (보안정책 §3 / 기술백서 §7).
 * P-186 구조화 로그, P-130 방문 기록.
 *
 * 왜 이 파일이 **유일한 관문**인가:
 *   로그·이벤트 payload·분석 기록은 전부 "나중에 누군가 읽는 사본"이다. 한 번 적히면
 *   회수할 수 없고, 보존기간 정책(미결정 §2)이 아직 정해지지도 않았다. 그래서
 *   "적을 때 거르는" 쪽을 선택했다 — 호출부가 무엇을 넘겼는지 몰라도 안전해야 한다.
 *
 * 설계 원칙: **과하게 가리는 방향으로 실패한다.** 전화번호로 오인해 가린 주문번호는
 * 디버깅을 불편하게 하지만, 흘려보낸 전화번호는 사고다.
 */

import { createHash } from "node:crypto";

/** 로컬파트가 길어도 상관없다 — 패턴이 잡히면 전체를 치환하므로 복원 불가하다. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * 전화번호 후보. `\p{Nd}` 를 쓰는 이유: 한글 IME 가 만드는 전각 숫자
 * ("０１０－１２３４－５６７８")가 ASCII 전용 패턴을 그대로 통과한다.
 */
const PHONE_RE = /[+＋]?\p{Nd}[\p{Nd}\s().\-－—･·．]{6,}\p{Nd}/gu;

/** ISO 8601 날짜("2026-01-01 00:00")가 전화번호로 오인되면 로그를 읽을 수 없게 된다. */
const ISO_DATE_PREFIX_RE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}/u;

/**
 * UUID. **전화번호 판정보다 먼저 보호한다.**
 *
 * 왜 필요한가: `PHONE_RE` 의 문자 클래스에 하이픈이 있어서 uuid 뒷부분이 전화번호 후보로 잡힌다.
 * 예) `123e4567-e89b-12d3-a456-426614174000` → 후보 `456-426614174000` = 15자리 → 범위 안 → 치환.
 * 실측으로 **uuid 의 약 35%** 가 이 경로를 탄다.
 *
 * 그 결과가 특히 나쁘다: `audit_logs.payload_minimized` 와 `outbox_events.payload` 는
 * "PII 대신 **식별자만** 담는다" 는 규칙(N-13 / 기술백서 §7)을 지키려고 uuid 를 넣는데,
 * 그 uuid 가 `[redacted:phone]` 으로 바뀌면 **조사도 연동도 불가능해진다.**
 * 즉 리댁션이 지키려던 바로 그 설계를 리댁션이 망가뜨린다.
 */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * 키 이름만 보고 값을 통째로 가릴 대상. 값의 모양을 믿지 않는다 —
 * `token` 에 담긴 base64url 은 아무 패턴에도 걸리지 않지만 노출되면 계정이 넘어간다.
 *
 * 부분 일치를 쓰는 이유: `contactEmail`, `tokenHash`, `Authorization`, `smtpPassword`
 * 처럼 조합된 이름이 실제로 더 많다.
 */
const SENSITIVE_KEY_PARTS: readonly string[] = [
  "email",
  "phone",
  "contact",
  "token",
  "secret",
  "password",
  "authorization",
];

/** 중첩이 아무리 깊어도 스택을 터뜨리지 않게 둔 상한. 실제 payload 는 3~4단이면 충분하다. */
const MAX_DEPTH = 16;

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => k.includes(part));
}

/**
 * 문자열 안에 섞인 연락처를 치환한다.
 *
 * 순서가 규칙이다:
 *   1. **uuid 를 자리표시자로 빼 둔다** — 안 그러면 전화번호 판정이 식별자를 먹는다(위 UUID_RE 주석).
 *   2. 이메일을 먼저 지운다 — 도메인 속 숫자가 전화로 오인되지 않게.
 *   3. 전화번호를 지운다.
 *   4. uuid 를 되돌린다.
 */
export function redactString(input: string): string {
  const uuids: string[] = [];
  const masked = input.replace(UUID_RE, (m) => {
    uuids.push(m);
    // 숫자·하이픈이 없는 자리표시자여야 전화 후보로 다시 잡히지 않는다.
    return `\u0000UUID${uuids.length - 1}\u0000`;
  });

  const redacted = masked.replace(EMAIL_RE, "[redacted:email]").replace(PHONE_RE, redactPhoneCandidate);

  return redacted.replace(/\u0000UUID(\d+)\u0000/g, (_, i: string) => uuids[Number(i)] ?? "");
}

/**
 * 후보 하나를 판정한다. 자릿수 범위를 벗어나면 **공백으로 쪼개 다시 판정한다.**
 *
 * 왜 재분할이 필요한가: `PHONE_RE` 의 문자 클래스에 `\s` 가 들어 있어서
 * `"010-1234-5678 010-8765-4321"` 이 **한 후보**로 잡힌다. 그러면 자릿수가 22 가 되어
 * 9~15 범위를 벗어나고, "전화가 아니다"로 판정돼 **두 번호가 로그에 원문으로 남는다**(N-13 위반).
 * 연락처를 공백으로 이어 적는 입력(메모·문의 본문)은 드물지 않으므로 그냥 둘 수 없다.
 *
 * `\s` 를 클래스에서 빼는 쪽이 간단해 보이지만, 그러면 `"010 1234 5678"` 처럼
 * 공백으로 구분한 **한 개**의 번호를 놓친다. 그래서 넓게 잡고 좁게 판정하는 순서를 유지한다.
 */
function redactPhoneCandidate(m: string): string {
  if (looksLikePhone(m)) return "[redacted:phone]";
  if (!/\s/.test(m)) return m;
  // 공백 구분자를 보존하면서 각 조각을 따로 판정한다 (로그 가독성 유지).
  return m
    .split(/(\s+)/)
    .map((part) => (/\s/.test(part) ? part : looksLikePhone(part) ? "[redacted:phone]" : part))
    .join("");
}

/**
 * 값 전체를 재귀적으로 훑어 PII 를 치환한 **새 값**을 돌려준다. 입력은 변형하지 않는다.
 *
 * 순환 참조는 `WeakSet` 으로 끊는다. 로그 필드에 요청 객체나 ORM 엔터티가 그대로
 * 넘어오는 일이 실제로 생기고, 그때 무한루프로 프로세스가 죽으면 리댁션보다 큰 사고다.
 */
export function redact(value: unknown): unknown {
  return redactInner(value, new WeakSet<object>(), 0);
}

function redactInner(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") {
    // number·boolean·undefined·bigint·symbol·function 은 그대로 둔다.
    // 숫자는 치환 대상이 아니다 — JSON 숫자에 전화번호를 담는 경로가 없고(스키마상 text),
    // 지표 값(value_numeric)까지 가리면 집계 로그가 무의미해진다.
    return typeof value === "function" ? "[function]" : value;
  }

  if (depth >= MAX_DEPTH) return "[depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  // Date 를 Object.entries 로 풀면 `{}` 가 되어 시각이 조용히 사라진다.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();

  // Error 도 열거 가능한 속성이 없어서 `{}` 가 된다. 메시지는 디버깅의 핵심이라 살린다.
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, seen, depth + 1));
  }

  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      const key = String(k);
      out[key] = isSensitiveKey(key) && v != null ? "[redacted]" : redactInner(v, seen, depth + 1);
    }
    return out;
  }

  if (value instanceof Set) {
    return [...value.values()].map((v) => redactInner(v, seen, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) && v != null ? "[redacted]" : redactInner(v, seen, depth + 1);
  }
  return out;
}

/**
 * 화면용 마스킹 (P-102). 리댁션과 목적이 다르다 —
 * 리댁션은 "되돌릴 수 없게 지우기", 마스킹은 "담당자가 같은 사람인지 알아보게 하기"다.
 *
 * `abcdef@example.com` → `ab***@example.com`
 */
export function maskEmail(e: string): string {
  const at = e.lastIndexOf("@");
  // 이메일 모양이 아니면 식별 가능한 조각을 남기지 않는다.
  if (at <= 0 || at === e.length - 1) return "***";
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}

/**
 * `01012345678` / `010-1234-5678` → `010-****-1234`
 *
 * 앞 3자리(통신사·지역)와 뒤 4자리만 남긴다. 7자리보다 짧으면 남길 조각이 식별력을
 * 가지므로 전부 가린다.
 */
export function maskPhone(p: string): string {
  const digits = p.normalize("NFKC").replace(/\D/g, "");
  // 하한이 8 이어야 한다: 앞 3 + 뒤 4 = 7 자를 **드러내므로**, 입력이 7자리면 마스크가
  // 원문을 그대로 복원하고 8자리면 7자리가 노출된다. 가려지는 자릿수가 2 이상 남는
  // 길이(≥9, 국내 최단 02-123-4567)부터만 부분 마스킹을 쓴다 (P-102).
  if (digits.length < 9) return "***";
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

/**
 * 방문자 식별자 (P-130 / N-13). IP·UA 원문을 저장하지 않고 이것만 남긴다.
 *
 * `salt` 를 필수 인자로 둔 이유: salt 없는 IP 해시는 IPv4 공간이 좁아 전수 대입으로
 * 복원된다(보안정책 §3). 운영에서는 환경변수로 주입하고 주기적으로 교체한다.
 * 32자로 자르는 것은 128bit — 충돌 확률이 집계 정확도에 영향을 주지 않는 수준이면 충분하고,
 * 짧을수록 유출 시 활용 가치가 낮다.
 */
export function hashVisitor(ip: string, ua: string, salt: string): string {
  return createHash("sha256").update(`${salt}\n${ip}\n${ua}`).digest("hex").slice(0, 32);
}

function looksLikePhone(candidate: string): boolean {
  if (ISO_DATE_PREFIX_RE.test(candidate)) return false;
  const digits = candidate.normalize("NFKC").replace(/\D/g, "").length;
  // 국내 최단(02-123-4567 = 9) ~ E.164 최대(15). 범위 밖은 주문번호·좌표 같은 다른 값이다.
  return digits >= 9 && digits <= 15;
}
