/**
 * 외부 연동 — PROPLUS 상담 리드를 LINKOS 연락처로 전달한다.
 *
 * 출처: `docs/05_LINKOS_INTEGRATION.md` §2 · ADR-012. 기능 근거: P-183(트랜잭셔널 outbox),
 * P-184(idempotent 소비), N-11(동의 분리), N-13(로그·이벤트에 PII 금지).
 *
 * ## 이 모듈이 지키는 경계
 *
 * 1. **자동으로 보내지 않는다.** 상담 동의는 "이 상담에 답변하기 위해" 받은 것이다. 같은 담당자가
 *    자기 CRM 에서 이어 처리하는 것은 그 목적 안이지만, **프로필 소유자가 켜야** 흐른다
 *    (`public_settings.linkosSync`). 기본값은 꺼짐이고 판정은 `=== true` 로만 한다 —
 *    `publicContact()` 와 같은 규칙이다. truthy 로 열면 jsonb 에 들어온 문자열 `"false"` 가 연동을 켠다.
 * 2. **동의를 더 받지 않는다.** 전달은 소유자의 결정이지 제출자가 준 동의가 아니다. `consent_records`
 *    에 쓰면 받지 않은 동의를 받았다고 기록하는 것이고, 그게 N-11 이 막으려는 거짓이다. 그래서
 *    전달 사실은 **처리 기록**으로만 남는다 — `audit_logs` + `integration_deliveries`
 *    (마이그레이션 0003 ⑤ 주석이 같은 결정을 적고 있다).
 * 3. **마케팅 동의 여부를 보내지 않는다.** `lead.created` 이벤트 payload 에는 그 플래그가 있지만
 *    LINKOS 로는 가지 않는다 — 저쪽에서 마케팅 발송 근거로 오용될 수 있다(05 문서 §2).
 * 4. **멱등하다.** outbox 는 at-least-once 다. 같은 리드에 대한 두 번째 호출은 보내지 않는다(P-184).
 */

import type { Ctx } from "../lib/ctx";
import { one, pool } from "../lib/db";
import { writeAudit } from "../lib/audit";
import { decryptField } from "../lib/crypto";
import { log } from "../lib/log";
import { createLinkosLead, linkosConfigured, type LinkosContactInput } from "../lib/linkosClient";

/** `integration_deliveries` 의 좌표. UNIQUE (target, kind, source_id) 가 멱등성의 근거다 (0003 ④). */
const TARGET = "linkos";
const KIND = "lead";

/** LINKOS `contactInput` 의 상한값. 넘기면 저쪽 zod 가 400 을 주고 그 실패는 재시도해도 낫지 않는다. */
const NOTE_MAX = 2000;
const TAG_MAX = 40;

/**
 * 익명화된 리드의 표식 (`lead.purgeExpired` 가 남긴다). 같은 상수를 `modules/lead.ts` 가 들고 있는데
 * 거기서 export 하지 않는다 — 모듈끼리 상수를 주고받기 시작하면 리드 모듈의 내부 표현이 공개 API 가 된다.
 * 여기서 필요한 것은 "복호화를 시도하면 안 되는 행"의 판정 하나뿐이다.
 */
const PURGED_MARK = "[삭제됨]";

export interface ForwardResult {
  status: "sent" | "skipped" | "failed";
  /** 운영자가 "왜 안 갔는가"에 답할 수 있게 하는 코드. 사람이 읽는 문장이 아니다. */
  reason?: string;
}

export interface IntegrationSettingsView {
  /** 상담 리드를 LINKOS 연락처로 전달한다 (05 문서 §2). */
  linkosSync: boolean;
  /** 이메일 해시로 내 검증 배지를 조회당할 수 있게 허용한다 (05 문서 §3). */
  allowDirectoryLookup: boolean;
  /** 서버에 `LINKOS_BASE_URL`·`LINKOS_API_KEY` 가 있는지. 없으면 설정 화면이 스위치를 잠근다. */
  linkosConfigured: boolean;
}

export interface IntegrationSettingsPatch {
  linkosSync?: boolean;
  allowDirectoryLookup?: boolean;
}

type ForwardRow = {
  id: string;
  profile_id: string;
  organization_id: string | null;
  contact_name: string;
  contact_channel_encrypted: string;
  contact_channel_kind: "email" | "phone";
  contact_masked: string;
  purpose: string | null;
  message: string | null;
  public_settings: Record<string, unknown> | null;
  organization_name: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// 05 문서 §2 — 리드 전달
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `lead.created` outbox 소비자가 호출한다. 요청 문맥이 없으므로 `ctx` 는 보통 `systemCtx()` 다.
 *
 * ## 반환값을 어떻게 읽는가
 *
 * - `skipped` — 보낼 이유가 없다. 호출부는 **성공으로 간주하고 이벤트를 완료 처리한다.**
 * - `sent` — 보냈고 기록했다.
 * - `failed` — 기록이 남았거나(4xx: 더 시도하지 않는다) 재시도 대상이다(5xx·네트워크).
 *   재시도 가능한 실패에서는 **`integration_deliveries` 에 행을 남기지 않는다** — 행이 남으면
 *   아래 (3)번 검사가 다음 시도를 건너뛰어, "일시적 장애"가 영구 누락이 된다.
 *
 * 예외를 던지지 않는 이유: 알림·연동 실패가 본업(상담 접수·배지 판정)에 영향을 주지 않아야 한다
 * (P-060 수용기준과 같은 태도, `lib/mail.ts` 주석 참조).
 */
export async function forwardLeadToLinkos(ctx: Ctx, leadId: string): Promise<ForwardResult> {
  // (1) 05 문서 §5: env 가 비면 이 연동만 조용히 꺼진다. PROPLUS 핵심은 LINKOS 없이 동작한다.
  if (!linkosConfigured()) return { status: "skipped", reason: "not_configured" };

  const row = await one<ForwardRow>(
    `SELECT l.id, l.profile_id, l.organization_id, l.contact_name, l.contact_channel_encrypted,
            l.contact_channel_kind, l.contact_masked, l.purpose, l.message,
            p.public_settings, o.name AS organization_name
       FROM leads l
       JOIN profiles p ON p.id = l.profile_id
       LEFT JOIN organizations o ON o.id = l.organization_id
      WHERE l.id = $1`,
    [leadId],
  );
  // 리드가 사라졌으면 재시도해도 생기지 않는다. 이벤트를 영구 재시도 큐에 묶어 두지 않는다.
  if (!row) return { status: "skipped", reason: "lead_not_found" };

  // (2) 소유자 opt-in. jsonb 에 키가 없으면 "아직 모른다"이고, 그건 꺼짐이다 (0003 ③).
  const settings = row.public_settings ?? {};
  if (settings.linkosSync !== true) return { status: "skipped", reason: "opt_out" };

  // 보존기간이 지나 익명화된 리드다. 복호화를 시도하지 않는다 (P-110).
  if (row.contact_channel_encrypted === "" || row.contact_masked === PURGED_MARK) {
    return { status: "skipped", reason: "purged" };
  }

  // (3) P-184 멱등성. 행이 있으면 이미 결론이 난 리드다 — 4xx 로 멈춘 것도 다시 보내지 않는다
  // (05 문서 §2: 잘못된 키로 무한 재시도하면 LINKOS 의 레이트리밋만 태운다).
  const existing = await one<{ status: string }>(
    `SELECT status FROM integration_deliveries WHERE target = $1 AND kind = $2 AND source_id = $3`,
    [TARGET, KIND, leadId],
  );
  if (existing) {
    return { status: "skipped", reason: existing.status === "sent" ? "already_sent" : "already_failed" };
  }

  // (4) 복호화는 여기 한 번뿐이고, 평문은 아래 payload 를 넘어가지 않는다 (P-102).
  let contact: string;
  try {
    contact = decryptField(row.contact_channel_encrypted, `lead:${row.id}`);
  } catch {
    // 키 회전 중이거나 암호문이 손상됐다. 재시도해도 같으므로 멈추고, 오류 본문은 남기지 않는다.
    log("error", "integration.lead_decrypt_failed", { leadId });
    await recordDelivery(leadId, "failed", null, "decrypt_failed");
    await auditForward(ctx, row, "failed", "decrypt_failed");
    return { status: "failed", reason: "decrypt_failed" };
  }

  const payload = buildContactPayload(row, contact);

  // (5) 호출 → 결과 기록.
  const result = await createLinkosLead(payload);

  if (!result.ok && result.retriable) {
    // 행을 남기지 않는다. 다음 시도가 (3)번에서 걸리지 않아야 한다.
    log("warn", "integration.lead_forward_retriable", { leadId, status: result.status, error: result.error });
    return { status: "failed", reason: `retriable:${result.error}` };
  }

  const status = result.ok ? "sent" : "failed";
  const remoteId = result.ok ? (result.id ?? null) : null;
  // `result.error` 는 `http_403` 같은 코드다. LINKOS 응답 본문은 들여오지 않는다 (N-13 / linkosClient 주석).
  const error = result.ok ? null : result.error;

  const stored = await recordDelivery(leadId, status, remoteId, error);
  // UNIQUE 위반 = 그 사이 다른 소비자가 결론을 남겼다. 이쪽 호출을 성공으로 기록해 두 줄을 만들지 않는다.
  if (!stored) return { status: "skipped", reason: "already_sent" };

  // (6) 전달 사실을 감사로그에 남긴다 (05 문서 §2). 재시도 대상인 실패는 위에서 이미 반환했으므로
  // 여기 도달하는 것은 **결론이 난 건**뿐이다 — 일시 장애가 audit_logs 를 재시도 횟수만큼 채우지 않는다.
  await auditForward(ctx, row, status, error);

  return result.ok ? { status: "sent" } : { status: "failed", reason: result.error };
}

// ─────────────────────────────────────────────────────────────────────────────
// 설정 (05 문서 §2 opt-in · §3 opt-in)
// ─────────────────────────────────────────────────────────────────────────────

/** 로그인 사용자의 연동 설정. 프로필이 아직 없으면 둘 다 꺼짐이다. */
export async function integrationSettings(ctx: Ctx): Promise<IntegrationSettingsView> {
  const configured = linkosConfigured();
  if (!ctx.userId) {
    // 라우트가 인증을 보장하지만, 모듈이 그걸 가정해 전체 프로필을 긁는 쿼리를 돌리지는 않는다.
    return { linkosSync: false, allowDirectoryLookup: false, linkosConfigured: configured };
  }

  const row = await one<{ public_settings: Record<string, unknown> | null }>(
    `SELECT public_settings FROM profiles WHERE user_id = $1`,
    [ctx.userId],
  );
  const settings = row?.public_settings ?? {};
  return {
    linkosSync: settings.linkosSync === true,
    allowDirectoryLookup: settings.allowDirectoryLookup === true,
    linkosConfigured: configured,
  };
}

/**
 * 두 플래그를 `profiles.public_settings` 에 **머지**한다.
 *
 * jsonb 전체를 덮어쓰지 않는 이유: 같은 컬럼에 공개 설정(`showEmail`·`showPhone`·`showRegion` …)이
 * 들어 있다. 연동 화면이 그 컬럼을 통째로 쓰면 **프로필 편집기의 설정이 조용히 지워진다** —
 * 그건 "연락처 공개를 껐는데 다시 켜졌다" 같은 형태로 나타나서 원인을 찾기 어렵다.
 * 그래서 들어온 키만 `||` 로 덮는다.
 *
 * 들어오지 않은 키는 건드리지 않는다(`undefined` 는 "변경 없음"이고 "끔"이 아니다).
 */
export async function setIntegrationSettings(ctx: Ctx, patch: IntegrationSettingsPatch): Promise<void> {
  if (!ctx.userId) return;

  const next: Record<string, boolean> = {};
  if (typeof patch.linkosSync === "boolean") next.linkosSync = patch.linkosSync;
  if (typeof patch.allowDirectoryLookup === "boolean") next.allowDirectoryLookup = patch.allowDirectoryLookup;
  if (Object.keys(next).length === 0) return;

  const updated = await one<{ id: string }>(
    `UPDATE profiles
        SET public_settings = public_settings || $2::jsonb
      WHERE user_id = $1
      RETURNING id`,
    [ctx.userId, JSON.stringify(next)],
  );
  if (!updated) return; // 프로필이 없으면 켤 대상도 없다. 빈 프로필을 만들지 않는다.

  /**
   * "누가 언제 전달을 켰는가"는 나중에 반드시 질문된다 — 전달의 법적 근거가 **소유자의 결정**이기
   * 때문이다(05 문서 §2). 그 결정이 기록되지 않으면 전달 자체를 설명할 수 없다.
   * payload 에는 플래그만 들어간다 (N-13).
   */
  await writeAudit(pool(), {
    eventType: "integration.settings_changed",
    actorId: ctx.userId,
    aggregateType: "profile",
    aggregateId: updated.id,
    payload: next,
    correlationId: ctx.requestId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 내부
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 05 문서 §2 매핑표를 그대로 옮긴다.
 *
 * `provenance` 를 채우는 이유: LINKOS 는 출처별 신뢰도를 쓴다. PROPLUS 상담은 **본인이 직접 입력한**
 * 연락처라 confidence 1 이 정직하다 — OCR 추정값과 구분된다.
 *
 * `company` 에 들어가는 것은 **프로필 소유 조직 이름**이다(매핑표). 제출자의 회사가 아니다 —
 * PROPLUS 는 제출자의 소속을 묻지 않으므로 그 값을 알 수 없고, 모르는 것을 지어내지 않는다.
 */
function buildContactPayload(row: ForwardRow, contact: string): LinkosContactInput {
  const kind = row.contact_channel_kind;
  const tags = ["proplus"];
  // 태그 상한은 40자다. lead 모듈은 purpose 를 200자까지 허용하므로 여기서 자른다.
  if (row.purpose) {
    const tag = row.purpose.trim().slice(0, TAG_MAX);
    if (tag.length > 0) tags.push(tag);
  }

  return {
    fullName: row.contact_name,
    company: row.organization_name,
    email: kind === "email" ? contact : null,
    phone: kind === "phone" ? contact : null,
    // enum 에서 외부 유입에 맞는 값은 이것뿐이다.
    source: "import",
    provenance: { [kind]: { source: "proplus", confidence: 1 } },
    ...(row.message ? { encounter: { note: row.message.slice(0, NOTE_MAX) } } : {}),
    tags,
    // 마케팅 동의 여부는 **여기 없다.** 05 문서 §2 — 저쪽에서 발송 근거로 오용될 수 있다.
  };
}

/**
 * @returns 행을 남겼으면 true. UNIQUE 위반(이미 결론이 난 리드)이면 false —
 *   `ON CONFLICT DO NOTHING` 으로 받는 이유는 경쟁 상황을 예외가 아니라 값으로 다루려는 것이다.
 */
async function recordDelivery(
  leadId: string,
  status: "sent" | "failed",
  remoteId: string | null,
  error: string | null,
): Promise<boolean> {
  const stored = await one<{ id: string }>(
    `INSERT INTO integration_deliveries (target, kind, source_id, remote_id, status, error)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (target, kind, source_id) DO NOTHING
     RETURNING id`,
    [TARGET, KIND, leadId, remoteId, status, error],
  );
  return stored !== null;
}

/** N-13: payload 에 성함·연락처·문의 본문을 넣지 않는다. 남겨야 하는 사실은 "어디로 보냈고 결과가 무엇인가"다. */
async function auditForward(ctx: Ctx, row: ForwardRow, status: string, error: string | null): Promise<void> {
  await writeAudit(pool(), {
    eventType: "integration.lead_forwarded",
    actorId: ctx.userId,
    // 소유자가 켜 둔 설정에 따라 **워커가** 보낸 것이다. 사람이 누른 동작이 아니라는 사실을 남긴다.
    actorRole: ctx.userId ? null : "system",
    tenantId: row.organization_id,
    aggregateType: "lead",
    aggregateId: row.id,
    payload: { leadId: row.id, target: TARGET, status, ...(error ? { error } : {}) },
    accessPurpose: "소유자 설정에 따른 리드 전달",
    correlationId: ctx.requestId,
  });
}
