/**
 * LINKOS 단일 로그인 — PROPLUS 쪽 수신 (연동 ①).
 *
 * 근거: `proplus/docs/05_LINKOS_INTEGRATION.md` §1 (흐름 · assertion 형식 · 계정 연결 규칙 · 비밀값)
 *       `proplus/db/migrations/0003_linkos_integration.sql` (`sso_assertions`, `users.linkos_user_id`)
 *       ADR-012
 *
 * ## 격리는 그대로다
 *
 * 이 모듈은 LINKOS 의 DB·패키지를 **건드리지 않는다.** 오가는 것은 서명된 assertion 문자열 하나뿐이고
 * (`@linkos/*` import 는 architecture.test.ts 가 금지한다), LINKOS 에서 탈퇴·정지돼도 PROPLUS 계정은
 * 자동으로 사라지지 않는다 — PROPLUS 의 증거·배지는 PROPLUS 의 것이다(05 §1, N-12 와 같은 방향).
 * 그래서 `linkos_user_id` 는 **연결 식별용일 뿐 권한 근거가 아니다.** 권한은 계속
 * `users.platform_role` + `memberships` 에서 나온다(`identity.principalFor`).
 *
 * ## 연동 env 가 비면 이 연동만 조용히 꺼진다
 *
 * `linkosSsoEnabled()` 가 false 면 라우트가 404 를 돌려주고 끝이다. PROPLUS 의 핵심
 * (검증·공개 프로필·상담)은 LINKOS 없이 동작해야 한다 (05 §5).
 */

import { Buffer } from "node:buffer";
import { SSO_ISSUER, SSO_SECRET_MIN_BYTES, type SsoPayload, verifyAssertion } from "@proplus/domain";
import { writeAudit } from "../lib/audit";
import type { Ctx } from "../lib/ctx";
import { one, q, tx } from "../lib/db";
import { badRequest, conflict, forbidden, unavailable } from "../lib/errors";
import { consumeLimit } from "../lib/limits";
import { log } from "../lib/log";
import * as identity from "./identity";
import type { PoolClient } from "pg";

/** LINKOS 가 띄우는 1st-party 인증 화면 (05 §1 흐름 2). */
export const LINKOS_SSO_AUTHORIZE_PATH = "/sso/proplus";

/** LINKOS 가 assertion 을 붙여 되돌려 보내는 PROPLUS 화면 (05 §1 흐름 4). */
export const LINKOS_SSO_CALLBACK_PATH = "/login/linkos";

export interface LinkedAccount {
  userId: string;
  /** PROPLUS 계정이 이 로그인으로 **처음** 만들어졌는가. 화면 안내 문구를 고르는 데만 쓴다. */
  isNew: boolean;
}

interface UserLinkRow {
  id: string;
  status: string;
  deleted_at: Date | null;
  linkos_user_id: string | null;
}

function sharedSecret(): string {
  return process.env.SSO_SHARED_SECRET ?? "";
}

function linkosBaseUrl(): string {
  return (process.env.LINKOS_BASE_URL ?? "").replace(/\/+$/, "");
}

function appOrigin(): string {
  // identity.ts 와 같은 기본값을 쓴다 — 두 곳이 다른 주소를 만들면 redirect_uri 가 어긋난다.
  return (process.env.APP_ORIGIN ?? "https://proplus.linkos.com").replace(/\/+$/, "");
}

/**
 * 이 배포에서 LINKOS 로그인을 켤 수 있는가 (05 §5).
 *
 * 비밀값이 **있는데 짧은** 경우를 "꺼짐"으로 처리하는 이유: 그건 설정 누락이 아니라 설정 오류이고,
 * 그대로 켜 두면 약한 HMAC 키로 운영에 올라간다. 끄고, **끈 사실을 로그로 드러낸다** —
 * 조용히 끄면 "로그인 버튼이 왜 없지"를 아무도 설명할 수 없다.
 */
export function linkosSsoEnabled(): boolean {
  const secret = sharedSecret();
  const base = linkosBaseUrl();
  if (!secret || !base) return false;

  const bytes = Buffer.byteLength(secret, "utf8");
  if (bytes < SSO_SECRET_MIN_BYTES) {
    log("warn", "linkos_sso.secret_too_short", { bytes, required: SSO_SECRET_MIN_BYTES });
    return false;
  }
  if (!/^https?:\/\//.test(base)) {
    log("warn", "linkos_sso.base_url_invalid", {});
    return false;
  }
  return true;
}

/**
 * LINKOS 인증 화면 주소 (05 §1 흐름 2).
 *
 * `redirect_uri` 를 호출자가 넘긴 값이 아니라 **PROPLUS 의 설정(`APP_ORIGIN`)에서** 만든다.
 * 호출자가 준 주소를 그대로 실으면 open redirect 가 되고, assertion 이 남의 호스트로 간다.
 */
export function authorizeUrl(state: string): string {
  if (!linkosSsoEnabled()) {
    throw unavailable("linkos_sso_disabled", "LINKOS 계정 로그인이 설정되지 않았습니다.");
  }
  if (typeof state !== "string" || state.length < 16) {
    // state 는 로그인 CSRF 를 막는 유일한 값이다. 짧으면 추측 가능해지므로 애초에 만들지 않는다.
    throw badRequest("sso_state_required", "로그인 요청을 시작할 수 없습니다.");
  }
  const url = new URL(`${linkosBaseUrl()}${LINKOS_SSO_AUTHORIZE_PATH}`);
  url.searchParams.set("redirect_uri", `${appOrigin()}${LINKOS_SSO_CALLBACK_PATH}`);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * 세션 발급은 `identity` 가 한다 — 여기서 `sessions` 에 직접 쓰지 않는다.
 *
 * 왜: 세션 수명(30일)·토큰 해시·행 모양이 두 곳으로 갈라지면 "세션 즉시 무효화"(P-003)가
 * 한쪽에만 적용되는 상태가 만들어진다. 전략 §3 도 모듈이 다른 모듈의 테이블에 쓰는 것을 금지한다.
 *
 * `identity.issueSession(ctx, userId, reason, meta)` 가 그 경로다. 그 함수는 **신원을 확인하지
 * 않는다** — 확인은 여기(`consumeAssertion`: 서명·만료·1회성·계정 연결)서 이미 끝났다는 전제다.
 * 그래서 `reason` 을 필수로 받아 감사로그에 "무엇이 신원을 확인했는가" 가 남는다.
 */

/**
 * 세션까지 끝낼 수 있는 배포인가. 라우트는 assertion 을 **소비하기 전에** 이것을 본다 —
 * 소비해 버리면 `jti` 가 타고 계정만 연결된 채 로그인은 안 되는 상태가 남는다.
 *
 * SSO 자체가 꺼져 있으면(비밀값 없음) 여기서도 false 다.
 */
export function ssoSessionIssuable(): boolean {
  return linkosSsoEnabled();
}

export async function issueSsoSession(ctx: Ctx, userId: string): Promise<identity.SessionIssued> {
  // reason 이 감사로그에 남는다. 나중에 "이 세션은 무엇으로 발급됐나" 를 되짚을 수 있어야 한다.
  return identity.issueSession(ctx, userId, "linkos_sso", { userAgent: ctx.userAgent, kind: "web" });
}

/**
 * assertion 을 PROPLUS 계정으로 바꾼다.
 *
 * 05 §1 의 검증 규칙 중 다섯 개(형식·서명·iss/aud·시간·email)는 도메인
 * (`domain/ssoAssertion.verifyAssertion`)이 보고, **1회성(규칙 5)은 여기서 DB 가 본다.**
 *
 * 순서가 설계다:
 *   1. 한도 소비 — 토큰 대입이 DB 조회 비용을 공짜로 쓰지 못하게 조회 **전에** 센다.
 *   2. 서명·시간 검증 — 믿을 수 없는 입력으로 DB 를 건드리지 않는다.
 *   3. `jti` INSERT — 트랜잭션의 **첫 쓰기**다. 재생된 토큰은 계정을 연결하기 전에 떨어진다.
 *   4. 계정 연결 (05 §1 계정 연결 규칙).
 *
 * `jti` 를 선조회(`SELECT ... WHERE jti = $1`)로 막지 않는 이유: 같은 토큰을 동시에 보낸 두 요청이
 * 둘 다 "없음"을 보고 둘 다 통과한다. UNIQUE 제약에는 그 창이 없다.
 */
export async function consumeAssertion(ctx: Ctx, token: string): Promise<LinkedAccount> {
  if (!linkosSsoEnabled()) {
    throw unavailable("linkos_sso_disabled", "LINKOS 계정 로그인이 설정되지 않았습니다.");
  }

  // P-004 와 같은 버킷이다. 이 경로도 "토큰을 들고 오는 로그인"이고 막아야 하는 것이 같다.
  await consumeLimit("login", `ip:${ctx.ip}`);

  const verified = verifyAssertion(token, sharedSecret(), new Date());
  if (!verified.ok) {
    if (verified.code === "bad_secret") {
      // 사용자의 잘못이 아니다. 설정 오류를 400 으로 돌려주면 "다시 시도"만 반복하게 된다.
      log("error", "linkos_sso.secret_unusable", { requestId: ctx.requestId });
      throw unavailable("linkos_sso_misconfigured", "LINKOS 계정 로그인을 지금 처리할 수 없습니다.");
    }
    // 만료·위조·형식 오류에 **같은 코드**를 쓴다(문구는 도메인이 준 사람 말을 그대로 쓴다).
    // 코드로 구분해 주면 서명을 맞춰 보는 쪽에 "어디까지 통과했는지" 알려 주는 오라클이 된다.
    log("warn", "linkos_sso.assertion_rejected", { reason: verified.code, requestId: ctx.requestId });
    throw badRequest("assertion_invalid", verified.message);
  }

  const payload = verified.payload;
  // 접기 규칙을 **복제하지 않고** identity 의 것을 그대로 쓴다. 두 경로(매직링크·SSO)가
  // 다르게 접으면 전각 입력이 `users.email UNIQUE` 를 우회해 같은 주소로 두 번째 계정이 생기고,
  // 그 순간 05 §1 의 "이메일이 같으면 기존 계정에 연결한다" 가 거짓이 된다.
  const email = identity.normalizeEmail(payload.email);

  return tx(async (c) => {
    await insertAssertionOnce(c, payload);
    const result = await resolveUser(c, payload, email);
    await writeAudit(c, {
      eventType: "identity.sso_login",
      actorId: result.userId,
      aggregateType: "user",
      aggregateId: result.userId,
      correlationId: ctx.requestId,
      // N-13: `sub`·이메일을 남기지 않는다. 어느 제공자였고 계정이 새로 생겼는지만 남긴다.
      payload: { provider: SSO_ISSUER, method: "sso_assertion", isNew: result.isNew },
    });
    return result;
  });
}

/**
 * 05 §1 검증규칙 5 — 1회성. 실패를 **DB 가** 알려 주게 둔다.
 *
 * 재생을 막는 이유가 "토큰이 60초 살아 있으니까"가 아니다: 리다이렉트 URL 은 브라우저 히스토리·
 * Referer·프록시 로그에 남을 수 있어서, 그 60초 안에 같은 토큰이 두 번 쓰일 **실제 경로**가 있다
 * (0003 마이그레이션 `sso_assertions` 주석).
 */
async function insertAssertionOnce(c: PoolClient, p: SsoPayload): Promise<void> {
  try {
    await q(
      `INSERT INTO sso_assertions (jti, issuer, subject, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4))`,
      [p.jti, p.iss, p.sub, p.exp],
      c,
    );
  } catch (e) {
    // 23505 unique_violation = 이미 쓰인 assertion.
    if ((e as { code?: string }).code === "23505") {
      throw badRequest("assertion_replayed", "이미 사용된 로그인 요청입니다. 다시 로그인해 주세요.");
    }
    throw e;
  }
}

/** 05 §1 "계정 연결 규칙" — 연결된 계정 → 같은 이메일의 기존 계정 → 새 계정 순서다. */
async function resolveUser(c: PoolClient, p: SsoPayload, email: string): Promise<LinkedAccount> {
  // ① 이미 연결된 계정. 가장 구체적인 단서부터 본다.
  const byLink = await one<UserLinkRow>(
    `SELECT id, status, deleted_at, linkos_user_id FROM users WHERE linkos_user_id = $1`,
    [p.sub],
    c,
  );
  if (byLink) {
    assertUsable(byLink);
    await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [byLink.id], c);
    return { userId: byLink.id, isNew: false };
  }

  // ② 같은 이메일의 기존 계정에 **붙인다.** 새로 만들지 않는다 (05 §1).
  const byEmail = await one<UserLinkRow>(
    `SELECT id, status, deleted_at, linkos_user_id FROM users WHERE email = $1`,
    [email],
    c,
  );
  if (byEmail) {
    assertUsable(byEmail);
    const attached = await one<{ id: string }>(
      // `linkos_user_id IS NULL` 조건이 핵심이다: 이 계정이 이미 **다른** LINKOS 계정과
      // 연결돼 있으면 조용히 덮어쓰지 않는다. 덮어쓰면 PROPLUS 계정의 소유자가 바뀐다.
      `UPDATE users SET linkos_user_id = $2, last_login_at = now()
        WHERE id = $1 AND linkos_user_id IS NULL
        RETURNING id`,
      [byEmail.id, p.sub],
      c,
    );
    if (!attached) {
      throw conflict(
        "linkos_account_conflict",
        "이 이메일의 PROPLUS 계정은 이미 다른 LINKOS 계정과 연결되어 있습니다. 운영자에게 문의해 주세요.",
      );
    }
    return { userId: attached.id, isNew: false };
  }

  // ③ 새 계정. `auth_provider='linkos'` 가 "이 계정은 LINKOS 로 들어왔다"는 사실을 남긴다.
  let created: { id: string } | null = null;
  try {
    created = await one<{ id: string }>(
      `INSERT INTO users (email, auth_provider, linkos_user_id, last_login_at)
       VALUES ($1, 'linkos', $2, now())
       RETURNING id`,
      [email, p.sub],
      c,
    );
  } catch (e) {
    // email 또는 linkos_user_id UNIQUE 와 경합했다 — 같은 사람의 동시 로그인 두 건이다.
    // 트랜잭션 안에서 재시도하지 않는 이유: `jti` INSERT 까지 되돌려야 해서 1회성 보장이 흐려진다.
    // 로그인은 사용자가 다시 누를 수 있는 동작이므로 여기서는 사람 말로 거절하는 쪽이 낫다.
    if ((e as { code?: string }).code === "23505") {
      throw conflict("account_link_race", "로그인 처리가 겹쳤습니다. 다시 로그인해 주세요.");
    }
    throw e;
  }
  if (!created) throw unavailable("user_upsert_failed", "계정을 준비할 수 없습니다.");
  return { userId: created.id, isNew: true };
}

/**
 * P-011: 삭제·정지된 계정이 LINKOS 를 우회로로 삼아 되살아나지 않는다.
 * `identity.upsertUserByEmail` 과 **같은 판정**이어야 한다 — 한쪽만 느슨하면 그 경로가 우회로다.
 */
function assertUsable(u: Pick<UserLinkRow, "status" | "deleted_at">): void {
  if (u.deleted_at || u.status !== "active") {
    throw forbidden("이 계정은 사용할 수 없습니다.");
  }
}
