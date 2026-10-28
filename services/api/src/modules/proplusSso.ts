// PROPLUS 연동 — proplus/docs/05_LINKOS_INTEGRATION.md §1 (LINKOS 가 신원 제공자)
//
// 왜 LINKOS 가 발급하는가: 사용자를 이미 갖고 있는 쪽이 제공자다. PROPLUS 가 제공자가 되면
// 기존 LINKOS 사용자에게 새 계정을 만들라고 요구하게 되고 그건 연동이 아니라 분리다(05 §1).
//
// 왜 쿠키 공유가 아닌가: 두 호스트가 모두 *.ckp.kr 이라 `.ckp.kr` 도메인 쿠키를 쓰면 "되기는" 하지만
// 그 쿠키는 같은 영역의 무관한 사이트 전부로 함께 전송된다 — 세션 토큰을 남의 로그에 흘리는 설계다.
// 그래서 `lk_session` / `pp_session` 은 분리된 채 두고, 전달하는 것은 **서명된 단발 assertion** 하나뿐이다.
//
// 왜 PROPLUS 코드를 쓰지 않는가: 두 제품은 HTTP 로만 오간다(05 §4). `@proplus/*` 를 import 하면
// 그 격리가 깨지므로 같은 형식을 이쪽에 독립 구현한다. 형식이 어긋나면 로그인이 전부 실패하니
// 05 §1 의 JSON 키 이름·순서를 그대로 지킨다.
import { createHmac, randomBytes } from "node:crypto";
import { one, pool } from "../lib/db";
import { ApiError, badRequest, notFound } from "../lib/errors";
import { type Ctx, audit, rateLimit } from "../lib/platform";

/** 05 §1: 리다이렉트 한 번에 충분하고 유출 창은 짧게. */
const ASSERTION_TTL_SEC = 60;
/** 세션이 탈취됐을 때 베어러 자격증명을 무한히 찍어내지 못하게 한다(루트 CLAUDE.md §3 토큰 규칙). */
const ISSUE_LIMIT_PER_HOUR = 30;
/** 05 §5: SSO_SHARED_SECRET 은 32바이트 이상. 받는 쪽도 이 아래면 거부하므로 발급 전에 같은 선을 긋는다. */
const SECRET_MIN_BYTES = 32;

function secretOk(s: string | undefined): s is string {
  return Boolean(s) && Buffer.byteLength(s as string, "utf8") >= SECRET_MIN_BYTES;
}

/**
 * 연동 env 가 비면 이 연동만 조용히 꺼진다(05 §5). LINKOS 본체는 PROPLUS 없이 그대로 동작해야 한다.
 *
 * 비밀값이 너무 짧은 경우도 "꺼짐"으로 본다: 발급해도 PROPLUS 가 설정 오류로 거부하므로
 * 눌렀더니 실패하는 버튼을 보여 주는 것보다 화면 자체를 내보내지 않는 편이 정직하다.
 */
export function proplusSsoEnabled(): boolean {
  return secretOk(process.env.SSO_SHARED_SECRET) && Boolean(proplusBase());
}

function sharedSecret(): string {
  const s = process.env.SSO_SHARED_SECRET;
  if (!secretOk(s)) throw new ApiError(503, "proplus_sso_disabled", "PROPLUS 연동이 설정되지 않았습니다.");
  return s;
}

function proplusBase(): URL | null {
  const raw = process.env.PROPLUS_BASE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * 오픈 리다이렉트 차단. PROPLUS_BASE_URL 로 시작하는 절대 URL만 허용한다.
 *
 * 문자열 startsWith 로 비교하지 않는 이유: `https://proplus.ckp.kr.evil.example` 도
 * `https://proplus.ckp.kr` 로 시작한다. 그래서 파싱해서 **프로토콜·호스트가 같은지**를 보고,
 * PROPLUS_BASE_URL 에 경로가 붙어 있으면 그 하위 경로만 받는다.
 * userinfo(`https://user@host`)·프래그먼트는 받지 않는다 — 둘 다 목적지를 오인하게 만드는 수단이다.
 */
export function isAllowedRedirect(uri: string): boolean {
  const base = proplusBase();
  if (!base) return false;
  let target: URL;
  try {
    target = new URL(uri);
  } catch {
    return false;
  }
  if (target.protocol !== base.protocol || target.host !== base.host) return false;
  if (target.username || target.password || target.hash) return false;
  const prefix = base.pathname.replace(/\/+$/, "");
  if (prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) return false;
  return true;
}

interface AssertionPayload {
  iss: "linkos";
  aud: "proplus";
  sub: string;
  email: string;
  name: string | null;
  jti: string;
  iat: number;
  exp: number;
}

/**
 * 05 §1 의 assertion 을 발급한다 — `v1.<b64url payload>.<b64url sig>`.
 *
 * 서명 대상은 base64url 문자열이 아니라 **payload JSON 원문 바이트**다.
 * 05 §1 이 `base64url(hmac-sha256(payload, SSO_SHARED_SECRET))` 라고 적었고
 * 거기서 payload 는 바로 아래 정의된 JSON 객체를 가리킨다. 검증하는 쪽은
 * 받은 base64url 을 디코딩한 바이트에 그대로 HMAC 을 걸면 같은 값이 나온다.
 *
 * email 이 없으면 발급을 거부한다: PROPLUS 는 이메일로 자기 계정을 잇기 때문에(05 §1 계정 연결 규칙)
 * 이메일 없는 assertion 은 받는 쪽에서 쓸 수가 없다. 리다이렉트를 보내 놓고 거기서 실패하게 하는 것보다
 * 여기서 멈추는 편이 사용자에게 설명 가능하다.
 */
export async function issueAssertion(ctx: Ctx, userId: string): Promise<string> {
  const secret = sharedSecret();
  await rateLimit(`proplus-sso:${userId}`, ISSUE_LIMIT_PER_HOUR, 3600);
  const u = await one<{ email: string | null; display_name: string | null }>(
    "SELECT email, display_name FROM users WHERE id=$1 AND status='active'",
    [userId],
  );
  if (!u) throw notFound("user");
  if (!u.email) throw badRequest("email_required", "PROPLUS 연결에는 이메일이 등록된 계정이 필요합니다.");

  const iat = Math.floor(Date.now() / 1000);
  // 키 순서는 05 §1 문서 그대로. 서명이 JSON 원문 바이트에 걸리므로 순서를 바꾸면 서명도 바뀐다.
  const payload: AssertionPayload = {
    iss: "linkos",
    aud: "proplus", // 고정 — 다른 앱이 이 토큰을 재사용할 수 없다
    sub: userId,
    email: u.email,
    name: u.display_name ?? null,
    jti: randomBytes(16).toString("base64url"), // 1회성: PROPLUS 가 sso_assertions UNIQUE 로 재생을 막는다
    iat,
    exp: iat + ASSERTION_TTL_SEC,
  };
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const sig = createHmac("sha256", secret).update(json).digest("base64url");

  // 신원이 다른 제품으로 넘어간 사실은 남아야 한다. 이메일·이름은 넣지 않는다(루트 CLAUDE.md §3: 로그에 PII 금지).
  await audit(pool(), ctx, "sso.proplus.assertion_issued", "user", userId, { aud: payload.aud, jti: payload.jti, exp: payload.exp });

  return `v1.${json.toString("base64url")}.${sig}`;
}

/**
 * 발급한 assertion 을 돌려줄 목적지. redirectUri 에 이미 쿼리가 붙어 있어도 깨지지 않게 URL 로 조립한다.
 * 호출 전에 isAllowedRedirect 가 통과한 uri 여야 한다.
 */
export function redirectWithAssertion(uri: string, assertion: string, state: string): string {
  const u = new URL(uri);
  u.searchParams.set("assertion", assertion);
  u.searchParams.set("state", state);
  return u.toString();
}
