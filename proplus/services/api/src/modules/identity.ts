/**
 * M01 Identity & Access — P-001~P-011.
 *
 * 출처: dd/PROPLUS_Technical_Document_Set/02_모듈명세_제품요구사항.md M01
 *       + 04_보안_개인정보_신뢰정책.md §2 계정 탈취 / §3 목적 제한
 *       스키마: proplus/db/migrations/0001_proplus_core.sql §M01 (users / sessions / login_tokens / consent_records)
 *
 * 이 모듈의 설계 전제 네 가지:
 *
 * 1. **평문 토큰은 DB 에 들어오지 않는다.** 로그인 링크·세션 모두 `hashToken()` 결과만 저장한다
 *    (보안정책 §2). 그래서 "세션 목록"에 토큰을 돌려줄 방법이 아예 없다 — 의도된 제약이다.
 * 2. **계정은 링크를 클릭한 시점에 만들어진다.** `login_tokens` 에 `user_id` 가 없는 것이 그 설계다.
 *    요청만 하고 클릭하지 않은 주소로는 계정이 생기지 않으므로, 메일 폭탄이 계정 테이블을 늘리지 못한다.
 * 3. **권한은 계산하지 않고 묻는다.** 이 모듈은 `users.platform_role` + 활성 `memberships` 로
 *    `Principal` 을 조립하고 판정은 `domain/acl.can()` 에 맡긴다 (전략 §3 계층 규칙).
 * 4. **동의는 목적마다 한 행이다** (N-11). 한 행에 여러 목적을 담을 컬럼이 스키마에 없다.
 */

import {
  CONSENT_PURPOSES,
  type Capability,
  type ConsentInput,
  type ConsentPurpose,
  type Principal,
  type MemberRole,
  type PlatformRole,
  can,
  generateToken,
  hashToken,
  hashVisitor,
} from "@proplus/domain";
import { writeAudit } from "../lib/audit";
import type { Ctx } from "../lib/ctx";
import { one, pool, q, tx } from "../lib/db";
import { badRequest, forbidden, notFound, unauthorized, unavailable } from "../lib/errors";
import { consumeLimit } from "../lib/limits";
import { log } from "../lib/log";
import { sendMail } from "../lib/mail";
import { enqueue } from "../lib/outbox";
import type { PoolClient } from "pg";

/** P-001 수용기준: 매직링크는 1회성이고 TTL 10분이다. */
const LOGIN_TOKEN_TTL_MIN = 10;

/** 세션 수명. apps/web `SESSION_MAX_AGE`(30일)와 같아야 쿠키가 살아 있는데 DB 세션만 죽는 구간이 생기지 않는다. */
const SESSION_TTL_DAYS = 30;

/** user_agent 는 공격자가 길이를 늘릴 수 있는 입력이다. 저장 전 자른다. */
const UA_MAX = 300;

/**
 * 메일 본문에 들어가는 로그인 링크 경로. 웹 라우트가 이 경로를 받아 `consumeLoginLink()` 를 호출한다 —
 * 상수를 내보내는 이유는 메일 쪽과 라우트 쪽이 서로 다른 경로를 쓰는 사고를 막기 위함이다.
 */
export const LOGIN_LINK_PATH = "/login/verify";

export type SessionKind = "web" | "native";

export interface LoginLinkResult {
  /** SMTP 로 넘어갔는가. 미설정(로컬·CI)이면 false 이고, 그래도 토큰은 발급돼 있다. */
  sent: boolean;
  /** DEMO_LOGIN=1 경로에서만 채워진다. 메일 없이 바로 쓰는 세션 토큰(개발·테스트 서버 전용). */
  demoSessionToken?: string;
  demoUserId?: string;
  /**
   * SMTP 가 없고 **운영이 아닐 때만** 채워진다. 로컬·e2e 가 메일함 없이 로그인 흐름을 끝낼 수 있게 하는 값이고,
   * `NODE_ENV==='production'` 에서는 어떤 경우에도 채우지 않는다 (채우면 링크가 응답으로 새어 나간다).
   */
  devLoginToken?: string;
}

export interface SessionIssued {
  userId: string;
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  /** rotate=true 로 호출했을 때 발급된 새 토큰. 라우트가 쿠키에 다시 심는다 (P-002). */
  rotatedToken?: string;
  expiresAt: string;
}

export interface SessionSummary {
  id: string;
  kind: SessionKind;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface ConsentRecorded {
  id: string;
  purpose: ConsentPurpose;
  granted: boolean;
  policyVersion: string;
}

type UserAuthRow = {
  id: string;
  status: string;
  platform_role: string;
  deleted_at: Date | null;
};

type SessionAuthRow = {
  id: string;
  user_id: string;
  kind: string;
  expires_at: Date;
  status: string;
  deleted_at: Date | null;
};

/**
 * 이메일 형식. 저장·발송 전에 한 번 접는다(NFKC + 소문자) — 접지 않으면 전각 입력이
 * `users.email UNIQUE` 를 우회해 같은 주소로 두 계정이 생긴다.
 */
const EMAIL_RE = /^[^\s@,:;<>"]+@[^\s@,:;<>"]+\.[a-z]{2,}$/i;

/**
 * 이메일 정규화. **export 하는 이유**: 계정을 이메일로 잇는 경로가 둘이 됐다
 * (매직링크, LINKOS SSO — 05_LINKOS_INTEGRATION §1). 두 경로가 서로 다르게 접으면
 * 같은 주소에 계정이 **조용히 두 개** 생긴다. 접는 규칙은 한 곳에만 있어야 한다.
 */
export function normalizeEmail(raw: string): string {
  return typeof raw === "string" ? raw.normalize("NFKC").trim().toLowerCase() : "";
}

function appOrigin(): string {
  return (process.env.APP_ORIGIN ?? "https://proplus.linkos.com").replace(/\/+$/, "");
}

function iso(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function requireUser(ctx: Ctx): string {
  if (!ctx.userId) throw unauthorized();
  return ctx.userId;
}

/**
 * `domain/acl.assertCan()` 은 `Error('forbidden:<cap>')` 를 던진다. 그대로 올리면 라우트가 500 으로 바꾼다.
 * 판정은 도메인이 하고(계층 규칙) 에러 모양만 여기서 접는다.
 */
function requireCan(p: Principal, cap: Capability, target: { ownerUserId?: string; organizationId?: string } = {}): void {
  if (!can(p, cap, target)) throw forbidden();
}

function truncate(v: string | null | undefined, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.slice(0, max);
  return s.length > 0 ? s : null;
}

/**
 * 동의·방문 기록의 IP 해시 재료. 원문 IP 는 어디에도 저장하지 않는다 (N-13).
 * salt 가 없으면 IPv4 전수 대입으로 해시가 역산되므로 `AUTH_SECRET` 을 쓴다.
 */
function ipSalt(): string {
  return process.env.AUTH_SECRET ?? "proplus-dev-salt";
}

/**
 * 로그인 시점에 계정을 만들거나 찾는다. 정지·삭제 계정은 여기서 끊는다 —
 * 상태 확인을 세션 발급 뒤로 미루면 "쿠키는 받았는데 아무것도 못 하는" 상태가 된다.
 */
async function upsertUserByEmail(c: PoolClient, email: string): Promise<UserAuthRow> {
  const row = await one<UserAuthRow>(
    `INSERT INTO users (email, auth_provider, last_login_at)
     VALUES ($1, 'email', now())
     ON CONFLICT (email) DO UPDATE SET last_login_at = now()
     RETURNING id, status, platform_role, deleted_at`,
    [email],
    c,
  );
  if (!row) throw unavailable("user_upsert_failed", "계정을 준비할 수 없습니다.");
  // P-011: 삭제 요청된 계정은 재로그인으로 되살아나지 않는다. 복구는 별도 경로(P-007, 미구현)다.
  if (row.deleted_at || row.status !== "active") {
    throw forbidden("이 계정은 사용할 수 없습니다.");
  }
  return row;
}

async function createSession(
  c: PoolClient,
  userId: string,
  userAgent: string | null,
  kind: SessionKind,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const row = await one<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, user_agent, kind, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [userId, hashToken(token), truncate(userAgent, UA_MAX), kind, expiresAt],
    c,
  );
  if (!row) throw unavailable("session_create_failed", "세션을 만들 수 없습니다.");
  return { id: row.id, token, expiresAt };
}

/**
 * P-002: **이미 신원이 확인된** 사용자에게 세션을 발급한다.
 *
 * 왜 이 함수가 따로 있는가: 세션 생성(`createSession`)은 지금까지 `consumeLoginLink` 안에만
 * 있었다. 그런데 LINKOS SSO(ADR-012)는 매직링크 토큰 없이 신원을 확인한다 —
 * assertion 서명·만료·1회성·계정 연결을 `linkosSso` 가 이미 끝낸 뒤다.
 * 그 경로가 세션을 만들려고 `createSession` 을 복제하면 **세션 수명·감사·토큰 생성이 두 벌**이 되고,
 * 한쪽만 고쳐지는 날 조용히 갈라진다. 그래서 발급 경로를 하나로 모은다.
 *
 * ⚠️ **이 함수는 신원을 확인하지 않는다.** 호출부가 이미 확인했다는 전제로 세션을 만든다.
 * 라우트에서 직접 부르지 마라 — 부르는 순간 `userId` 를 아는 누구나 로그인하게 된다.
 * 지금 호출부는 `modules/linkosSso.ts` 하나뿐이고, 늘릴 때는 "무엇이 신원을 확인했는가" 를
 * 먼저 답할 수 있어야 한다.
 *
 * @param reason 감사로그에 남길 확인 근거 (예: "linkos_sso"). 비울 수 없다.
 */
export async function issueSession(
  ctx: Ctx,
  userId: string,
  reason: string,
  meta: { userAgent?: string; kind?: SessionKind } = {},
): Promise<SessionIssued> {
  if (!reason.trim()) {
    throw badRequest("issue_reason_required", "세션 발급 근거가 필요합니다.");
  }

  return tx(async (c) => {
    // 계정 상태를 다시 본다. 호출부가 신원은 확인했어도 **정지·삭제는 발급 시점에** 봐야 한다
    // (P-011: 삭제·정지된 계정의 기존 쿠키가 통하지 않는 것과 같은 기준).
    const user = await one<{ id: string; status: string; deleted_at: Date | null }>(
      `SELECT id, status, deleted_at FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
      c,
    );
    if (!user || user.deleted_at || user.status !== "active") {
      throw forbidden("이 계정으로는 로그인할 수 없습니다.");
    }

    const s = await createSession(c, user.id, meta.userAgent ?? ctx.userAgent, meta.kind ?? "web");
    await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id], c);

    await writeAudit(c, {
      eventType: "identity.session_issued",
      actorId: user.id,
      aggregateType: "session",
      aggregateId: s.id,
      correlationId: ctx.requestId,
      // N-13: 이메일·토큰 금지. 어떤 근거로 발급했는지만 남긴다.
      payload: { reason, kind: meta.kind ?? "web" },
    });

    return { userId: user.id, sessionId: s.id, sessionToken: s.token, expiresAt: iso(s.expiresAt) };
  });
}

/**
 * P-001: 매직링크 발송.
 *
 * 성공·실패 응답이 **계정 존재 여부를 말하지 않는다**(언제나 같은 모양을 돌려준다).
 * 여기서 "그런 계정이 없습니다"를 돌려주면 이 엔드포인트가 계정 열거 도구가 된다 (보안정책 §2).
 */
export async function requestLoginLink(ctx: Ctx, email: string): Promise<LoginLinkResult> {
  const addr = normalizeEmail(email);
  if (addr.length > 254 || !EMAIL_RE.test(addr)) {
    throw badRequest("invalid_email", "이메일 주소를 확인하세요.");
  }

  // P-004: 주소 단위 한도. 토큰 대입 쪽은 `consumeLoginLink` 가 IP 버킷으로 따로 막는다
  // (모듈명세 M01 "동일 식별자·IP 기준 시도 제한" 의 두 축이다).
  await consumeLimit("login", addr);

  // 개발·테스트 서버 전용 우회로. 운영 기본값은 꺼짐이며, 켜져 있다는 사실 자체를 로그·감사로그에 남긴다 —
  // 운영에 실수로 켜 두면 사후에 "언제부터 켜져 있었나"를 답할 수 있어야 한다.
  if (process.env.DEMO_LOGIN === "1") {
    const demo = await tx(async (c) => {
      const user = await upsertUserByEmail(c, addr);
      const s = await createSession(c, user.id, ctx.userAgent, "web");
      await writeAudit(c, {
        eventType: "identity.demo_login",
        actorId: user.id,
        aggregateType: "user",
        aggregateId: user.id,
        correlationId: ctx.requestId,
        payload: { reason: "DEMO_LOGIN", sessionId: s.id },
      });
      return { userId: user.id, token: s.token };
    });
    log("warn", "identity.demo_login_used", { requestId: ctx.requestId });
    return { sent: false, demoSessionToken: demo.token, demoUserId: demo.userId };
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MIN * 60 * 1000);

  await tx(async (c) => {
    // 이전에 보낸 미사용 링크를 같은 트랜잭션에서 소모시킨다. 살아 있는 링크가 여러 개면
    // 유효 창이 TTL 이 아니라 "마지막 요청까지의 누적"이 된다.
    await q(`UPDATE login_tokens SET used_at = now() WHERE email = $1 AND used_at IS NULL`, [addr], c);
    await q(
      `INSERT INTO login_tokens (email, token_hash, expires_at) VALUES ($1,$2,$3)`,
      [addr, hashToken(token), expiresAt],
      c,
    );
    await writeAudit(c, {
      eventType: "identity.login_link_requested",
      aggregateType: "login_token",
      correlationId: ctx.requestId,
      // N-13: 주소 원문을 남기지 않는다. 같은 주소의 반복 요청을 추적할 수 있는 해시 접두만 남긴다.
      payload: { subjectHash: hashToken(addr).slice(0, 16), ttlMinutes: LOGIN_TOKEN_TTL_MIN },
    });
  });

  const url = `${appOrigin()}${LOGIN_LINK_PATH}?token=${encodeURIComponent(token)}`;
  const sent = await sendMail(
    addr,
    "PROPLUS 로그인 링크",
    [
      "아래 링크로 로그인하세요.",
      "",
      url,
      "",
      `이 링크는 ${LOGIN_TOKEN_TTL_MIN}분 동안 한 번만 사용할 수 있습니다.`,
      "본인이 요청하지 않았다면 이 메일을 무시하세요.",
    ].join("\n"),
  );

  const devToken = !sent && process.env.NODE_ENV !== "production" ? token : undefined;
  return devToken ? { sent, devLoginToken: devToken } : { sent };
}

/**
 * P-001/P-002: 링크를 세션으로 바꾼다.
 *
 * 1회성 보장을 **조건부 UPDATE 한 방**으로 한다. SELECT 로 확인하고 UPDATE 하면
 * 링크를 두 번 클릭한(또는 메일 스캐너가 먼저 여는) 두 요청이 모두 통과하는 창이 생긴다.
 */
export async function consumeLoginLink(
  ctx: Ctx,
  token: string,
  meta: { userAgent?: string; kind?: SessionKind } = {},
): Promise<SessionIssued> {
  // P-004: 대입 시도는 주소를 모르는 상태에서 들어오므로 IP 버킷으로 막는다.
  // DB 조회 **전에** 소비해야 토큰 전수 대입이 조회 비용을 공짜로 쓰지 못한다.
  await consumeLimit("login", `ip:${ctx.ip}`);

  if (typeof token !== "string" || token.length < 20) {
    throw unauthorized("로그인 링크가 올바르지 않습니다.");
  }

  return tx(async (c) => {
    const row = await one<{ email: string }>(
      `UPDATE login_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING email`,
      [hashToken(token)],
      c,
    );
    // 만료·재사용·존재하지 않음을 **구분하지 않는다**. 구분하면 유효한 토큰의 존재가 응답으로 드러난다.
    if (!row) throw unauthorized("로그인 링크가 만료되었거나 이미 사용되었습니다.");

    const user = await upsertUserByEmail(c, row.email);
    const s = await createSession(c, user.id, meta.userAgent ?? ctx.userAgent, meta.kind ?? "web");
    await writeAudit(c, {
      eventType: "identity.login",
      actorId: user.id,
      actorRole: user.platform_role,
      aggregateType: "user",
      aggregateId: user.id,
      correlationId: ctx.requestId,
      payload: { method: "magic_link", sessionId: s.id, kind: meta.kind ?? "web" },
    });

    return { userId: user.id, sessionId: s.id, sessionToken: s.token, expiresAt: iso(s.expiresAt) };
  });
}

/**
 * P-002/P-003: 쿠키 토큰 → 세션. 폐기·만료·계정 상태를 **읽기 시점에** 확인한다.
 *
 * `Ctx` 를 받지 않는 유일한 함수다: Ctx 의 `userId` 를 만드는 것이 이 함수의 일이라
 * 자기 결과를 인자로 받을 수 없다 (apps/web `route()` 가 이 순서로 호출한다).
 *
 * @param rotate P-002 "매 요청 회전". 회전하면 `rotatedToken` 이 채워지고 호출부가 쿠키를 갱신해야 한다.
 *   회전은 유출된 토큰의 유효 창을 좁히는 대신, 같은 사용자의 병렬 요청 중 하나가 구 토큰을 쓰게 되는
 *   비용이 있다 — 그래서 읽기 전용 경로(SSR `getViewer()`)는 rotate=false 로 호출한다.
 * @param kind 지정하면 그 종류의 세션만 인정한다. 네이티브 전용 API 가 웹 쿠키를 그대로 받지 않게 하는 용도다.
 */
export async function resolveSession(
  token: string | null | undefined,
  meta: { userAgent?: string } = {},
  rotate = false,
  kind?: SessionKind,
): Promise<ResolvedSession | null> {
  if (typeof token !== "string" || token.length === 0) return null;

  const row = await one<SessionAuthRow>(
    `SELECT s.id, s.user_id, s.kind, s.expires_at, u.status, u.deleted_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (!row) return null;
  // P-011: 삭제·정지된 계정의 기존 쿠키는 즉시 통하지 않아야 한다. 세션을 일일이 지우는 것에 의존하지 않는다.
  if (row.deleted_at || row.status !== "active") return null;
  if (kind && row.kind !== kind) return null;

  if (!rotate) {
    // SSR 렌더마다 UPDATE 하면 공개 페이지 p95(P-194)에 쓰기 비용이 섞인다. 1분 단위로만 갱신한다.
    await q(
      `UPDATE sessions SET last_seen_at = now()
        WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`,
      [row.id],
    );
    return { sessionId: row.id, userId: row.user_id, expiresAt: iso(row.expires_at) };
  }

  const next = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const updated = await one<{ id: string; expires_at: Date }>(
    `UPDATE sessions
        SET token_hash = $2, last_seen_at = now(), expires_at = $3,
            user_agent = COALESCE($4, user_agent)
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id, expires_at`,
    [row.id, hashToken(next), expiresAt, truncate(meta.userAgent, UA_MAX)],
  );
  // 조회와 회전 사이에 폐기됐다면(다른 기기에서 "모든 세션 끊기") 회전하지 않고 비로그인으로 떨어뜨린다.
  if (!updated) return null;

  return {
    sessionId: row.id,
    userId: row.user_id,
    rotatedToken: next,
    expiresAt: iso(updated.expires_at),
  };
}

/** P-005: 세션 목록. 토큰 해시는 돌려주지 않는다(돌려줄 이유가 없고, 유출되면 대입 재료가 된다). */
export async function listSessions(ctx: Ctx): Promise<SessionSummary[]> {
  const userId = requireUser(ctx);
  const rows = await q<{
    id: string;
    kind: string;
    user_agent: string | null;
    created_at: Date;
    last_seen_at: Date;
    expires_at: Date;
  }>(
    // 소유자 스코프(IDOR 차단): user_id 조건 없는 세션 조회는 만들지 않는다.
    `SELECT id, kind, user_agent, created_at, last_seen_at, expires_at
       FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === "native" ? "native" : "web",
    userAgent: r.user_agent,
    createdAt: iso(r.created_at),
    lastSeenAt: iso(r.last_seen_at),
    expiresAt: iso(r.expires_at),
  }));
}

/** P-005: 개별 폐기. 소유자 조건이 WHERE 에 있어야 남의 세션 id 를 넣어도 아무 일이 없다. */
export async function revokeSession(ctx: Ctx, sessionId: string): Promise<{ revoked: true }> {
  const userId = requireUser(ctx);
  return tx(async (c) => {
    const row = await one<{ id: string }>(
      `UPDATE sessions SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [sessionId, userId],
      c,
    );
    if (!row) throw notFound("session");
    await writeAudit(c, {
      eventType: "identity.session_revoked",
      actorId: userId,
      aggregateType: "session",
      aggregateId: row.id,
      correlationId: ctx.requestId,
    });
    return { revoked: true as const };
  });
}

/**
 * P-003 / M01 수용기준: **계정 탈취 대응으로 모든 세션을 한 번에 무효화한다.**
 *
 * 다른 사용자를 대상으로 할 때는 운영 행위이므로 플랫폼 역할을 요구하고 접근 사유를 감사로그에 남긴다 (P-165).
 * 여기서 사유 없는 타인 세션 폐기를 허용하면 운영자 행위가 사후에 설명되지 않는다.
 */
export async function revokeAllSessions(
  ctx: Ctx,
  userId?: string,
  opts: { reason?: string; accessPurpose?: string } = {},
): Promise<{ revoked: number }> {
  const actor = requireUser(ctx);
  const target = userId ?? actor;

  if (target !== actor) {
    const p = await principalFor(actor);
    requireCan(p, "admin.access");
    if (!opts.accessPurpose?.trim()) {
      throw badRequest("access_purpose_required", "다른 사용자의 세션을 폐기하려면 접근 사유가 필요합니다.");
    }
  }

  return tx(async (c) => {
    const rows = await q<{ id: string }>(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [target],
      c,
    );
    await writeAudit(c, {
      eventType: "identity.all_sessions_revoked",
      actorId: actor,
      aggregateType: "user",
      aggregateId: target,
      correlationId: ctx.requestId,
      accessPurpose: target === actor ? null : (opts.accessPurpose ?? null),
      payload: { count: rows.length, reason: opts.reason ?? "owner_request" },
    });
    return { revoked: rows.length };
  });
}

/**
 * P-008 / N-11: 동의 기록.
 *
 * **목적마다 한 행**을 만든다. 묶음 저장을 허용하면 나중에 "마케팅 동의만 철회"를 표현할 수 없고,
 * 그 순간 마케팅 동의가 서비스 이용의 조건이 된다 (보안정책 §3).
 *
 * @param opts.subjectRef 비회원 동의(공개 상담 폼)에서 리드를 가리키는 참조.
 *   `consent_records` 는 `user_id` 또는 `subject_ref` 중 하나를 요구한다(CHECK).
 */
export async function recordConsents(
  ctx: Ctx,
  inputs: readonly ConsentInput[],
  opts: { subjectRef?: string | null } = {},
): Promise<ConsentRecorded[]> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw badRequest("consents_required", "동의 항목이 필요합니다.");
  }
  if (inputs.length > CONSENT_PURPOSES.length) {
    throw badRequest("too_many_consents", "동의 항목이 너무 많습니다.");
  }

  const subjectRef = opts.subjectRef?.trim() || null;
  if (!ctx.userId && !subjectRef) {
    throw badRequest("consent_subject_required", "동의 주체가 필요합니다.");
  }

  const valid: ReadonlySet<string> = new Set<string>(CONSENT_PURPOSES);
  const seen = new Map<ConsentPurpose, boolean>();
  for (const c of inputs) {
    if (!c || !valid.has(c.purpose)) {
      throw badRequest("unknown_consent_purpose", "알 수 없는 동의 목적입니다.");
    }
    if (typeof c.policyVersion !== "string" || c.policyVersion.trim() === "") {
      // 버전 없는 동의는 나중에 "무엇에 동의했는지"를 말할 수 없어 기록으로서 쓸모가 없다 (P-169).
      throw badRequest("policy_version_required", "동의 약관 버전이 필요합니다.");
    }
    const prev = seen.get(c.purpose);
    if (prev !== undefined && prev !== c.granted) {
      throw badRequest("consent_conflict", "같은 목적에 상충하는 동의가 들어왔습니다.");
    }
    seen.set(c.purpose, c.granted === true);
  }

  const ipHash = hashVisitor(ctx.ip, ctx.userAgent, ipSalt());

  return tx(async (c) => {
    const out: ConsentRecorded[] = [];
    for (const input of inputs) {
      const row = await one<{ id: string }>(
        `INSERT INTO consent_records (user_id, subject_ref, purpose, granted, policy_version, ip_hash)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [ctx.userId, subjectRef, input.purpose, input.granted === true, input.policyVersion.trim(), ipHash],
        c,
      );
      if (!row) throw unavailable("consent_write_failed", "동의를 기록할 수 없습니다.");
      out.push({
        id: row.id,
        purpose: input.purpose,
        granted: input.granted === true,
        policyVersion: input.policyVersion.trim(),
      });
    }
    await writeAudit(c, {
      eventType: "identity.consents_recorded",
      actorId: ctx.userId,
      aggregateType: "consent_record",
      correlationId: ctx.requestId,
      // 목적·허용 여부만 남긴다. 동의 본문·연락처는 남기지 않는다 (N-13).
      payload: { purposes: out.map((r) => ({ purpose: r.purpose, granted: r.granted })) },
    });
    return out;
  });
}

/**
 * P-009: 권한 판단에 필요한 `Principal` 을 DB 에서 조립한다.
 *
 * 판정은 하지 않는다 — 판정은 `domain/acl.can()` 의 일이다 (전략 §3). 이 함수의 책임은
 * "지금 이 사람이 가진 역할의 **사실**"을 모으는 것뿐이고, 활성 소속만 담는 것이 그 사실의 일부다
 * (P-084: 퇴사하면 소속 효력이 즉시 끊긴다 — `acl.isOrgManager` 도 status='active' 를 요구한다).
 */
export async function principalFor(userId: string | null): Promise<Principal> {
  if (!userId) return { userId: null, platformRole: "none", memberships: [] };

  const user = await one<{ platform_role: string; status: string; deleted_at: Date | null }>(
    `SELECT platform_role, status, deleted_at FROM users WHERE id = $1`,
    [userId],
  );
  // 계정이 없거나 정지·삭제됐으면 **비로그인과 같은 권한**으로 떨어뜨린다 (fail-closed).
  if (!user || user.deleted_at || user.status !== "active") {
    return { userId: null, platformRole: "none", memberships: [] };
  }

  const rows = await q<{ organization_id: string; role: string; status: string }>(
    `SELECT organization_id, role, status FROM memberships WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );

  return {
    userId,
    platformRole: toPlatformRole(user.platform_role),
    memberships: rows.map((r) => ({
      organizationId: r.organization_id,
      role: toMemberRole(r.role),
      status: r.status,
    })),
  };
}

function toPlatformRole(v: string): PlatformRole {
  return v === "admin" || v === "reviewer" ? v : "none";
}

function toMemberRole(v: string): MemberRole {
  return v === "owner" || v === "manager" ? v : "member";
}

/**
 * P-010: 본인 데이터 내보내기.
 *
 * 두 가지를 **일부러 넣지 않는다**:
 *   - 증거 원본 파일 (N-5). 메타데이터만 넣고 원본은 감사 기록이 남는 별도 경로로 안내한다
 *     (보안정책 §3: 증거 원본 다운로드는 매번 audit_logs 에 남아야 한다).
 *   - 리드(상담 요청)의 복호화된 연락처. 그건 **문의한 제3자의 PII** 이고, 내보내기라는
 *     낮은 마찰의 경로로 평문화할 이유가 없다 (N-13). 목록 화면과 같은 마스킹 값만 담는다.
 */
export async function exportMyData(ctx: Ctx): Promise<Record<string, unknown>> {
  const userId = requireUser(ctx);

  const user = await one<Record<string, unknown>>(
    `SELECT id, email, phone, auth_provider, status, platform_role, created_at, last_login_at
       FROM users WHERE id = $1`,
    [userId],
  );
  if (!user) throw notFound("user");

  const profile = await one<Record<string, unknown>>(
    `SELECT id, slug, display_name, headline, bio, specialties, languages, region,
            public_settings, published_at, version, created_at, updated_at
       FROM profiles WHERE user_id = $1`,
    [userId],
  );
  const profileId = profile && typeof profile.id === "string" ? profile.id : null;

  type Rows = Record<string, unknown>[];
  let facts: Rows = [];
  let blocks: Rows = [];
  let versions: Rows = [];
  let badges: Rows = [];
  let evidence: Rows = [];
  let offers: Rows = [];
  let metrics: Rows = [];
  let leads: Rows = [];
  if (profileId) {
    [facts, blocks, versions, badges, evidence, offers, metrics, leads] = await Promise.all([
      q(`SELECT kind, label, detail, started_on, ended_on, (verification_id IS NOT NULL) AS verified, position
           FROM profile_facts WHERE profile_id = $1 ORDER BY position`, [profileId]),
      q(`SELECT kind, position, props, visible FROM profile_blocks WHERE profile_id = $1 ORDER BY position`, [profileId]),
      q(`SELECT version, created_at FROM profile_versions WHERE profile_id = $1 ORDER BY version`, [profileId]),
      // 공개 6필드만 (N-5: 증거 조인 없음).
      q(`SELECT badge_type, public_label, method, scope, issuer_name, status, verified_at, expires_at
           FROM badges WHERE profile_id = $1 ORDER BY issued_at`, [profileId]),
      q(`SELECT id, evidence_type, source_type, status, submitted_at FROM evidence
          WHERE subject_type = 'profile' AND subject_id = $1 ORDER BY submitted_at`, [profileId]),
      q(`SELECT id, title, description, price_display_policy, status, published_at
           FROM offers WHERE profile_id = $1 ORDER BY created_at`, [profileId]),
      q(`SELECT metric_code, value_numeric, unit, period_start, period_end, sample_size, basis,
                (verification_id IS NOT NULL) AS verified
           FROM metric_claims WHERE profile_id = $1 ORDER BY created_at`, [profileId]),
      q(`SELECT id, contact_name, contact_masked, contact_channel_kind, purpose, stage, created_at
           FROM leads WHERE profile_id = $1 ORDER BY created_at`, [profileId]),
    ]);
  }

  const consents = await q(
    `SELECT purpose, granted, policy_version, created_at FROM consent_records
      WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  const memberships = await q(
    `SELECT m.role, m.status, m.started_at, m.ended_at, o.name AS organization_name
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 ORDER BY m.created_at`,
    [userId],
  );
  const sessions = await listSessions(ctx);

  // CLAUDE.md §5: export·대량조회는 감사로그에 남긴다. 트랜잭션에 묶을 쓰기가 없으므로 풀로 바로 남긴다.
  await writeAudit(pool(), {
    eventType: "identity.data_exported",
    actorId: userId,
    aggregateType: "user",
    aggregateId: userId,
    correlationId: ctx.requestId,
    accessPurpose: "subject_access_request",
    payload: { profileIncluded: profileId !== null, leadCount: leads.length },
  });

  return {
    exportedAt: new Date().toISOString(),
    user,
    profile: profile ?? null,
    profileFacts: facts,
    profileBlocks: blocks,
    profileVersions: versions,
    badges,
    evidence,
    offers,
    metricClaims: metrics,
    // 마스킹된 값만 들어 있다 — 위 주석 참조.
    leads,
    consents,
    memberships,
    sessions,
    notice: {
      evidenceFiles: "증거 원본 파일은 이 파일에 포함되지 않습니다. 원본 열람은 감사 기록이 남는 별도 요청 경로를 이용하세요.",
      leads: "상담 요청자의 연락처는 보호를 위해 마스킹된 값만 포함됩니다.",
    },
  };
}

/**
 * P-011: 계정 삭제 요청 — **즉시 공개 중단 + 접근 차단**, 보존 대상은 남긴다 (데이터모델 §6).
 *
 * 실제 파기(행 삭제)를 여기서 하지 않는 이유:
 *   보존기간·국외이전이 법률검토 전(미결정 §2)이고 `retention_policies` 의 `retain_days` 가 비어 있다.
 *   값이 없는 상태에서 하드 삭제를 구현하면 분쟁 대응에 필요한 검증 이력·감사로그까지 사라진다.
 *   TODO(P-199): 보존기간이 확정되면 워커의 파기 작업이 이 상태를 소비한다.
 */
export async function requestAccountDeletion(ctx: Ctx): Promise<{
  status: "pending_erasure";
  unpublishedProfiles: number;
  revokedSessions: number;
}> {
  const userId = requireUser(ctx);

  return tx(async (c) => {
    const user = await one<{ id: string }>(
      `UPDATE users SET status = 'deleted', deleted_at = now()
        WHERE id = $1 AND status <> 'deleted'
        RETURNING id`,
      [userId],
      c,
    );
    if (!user) throw badRequest("already_deleted", "이미 삭제 요청된 계정입니다.");

    // 공개 중단이 먼저다. 공개 뷰는 `users.status='active'` 도 보지만, published_at 을 끊어
    // 두 겹으로 막는다 — 한쪽 조건이 바뀌어도 프로필이 다시 노출되지 않아야 한다.
    const profiles = await q<{ id: string }>(
      `UPDATE profiles SET published_at = NULL WHERE user_id = $1 AND published_at IS NOT NULL RETURNING id`,
      [userId],
      c,
    );
    const sessions = await q<{ id: string }>(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
      [userId],
      c,
    );

    // 외부 연동(검색 인덱스·연동 CRM)이 "이 프로필은 더 이상 공개가 아니다"를 알아야 한다.
    // 같은 트랜잭션에 기록해야 공개 중단과 통지가 갈라지지 않는다 (P-183).
    for (const p of profiles) {
      await enqueue(c, {
        eventType: "profile.unpublished",
        aggregateType: "profile",
        aggregateId: p.id,
        actorId: userId,
        correlationId: ctx.requestId,
        payload: { reason: "account_deletion_requested" },
      });
    }

    await writeAudit(c, {
      eventType: "identity.account_deletion_requested",
      actorId: userId,
      aggregateType: "user",
      aggregateId: userId,
      correlationId: ctx.requestId,
      payload: { unpublishedProfiles: profiles.length, revokedSessions: sessions.length },
    });

    return {
      status: "pending_erasure" as const,
      unpublishedProfiles: profiles.length,
      revokedSessions: sessions.length,
    };
  });
}
