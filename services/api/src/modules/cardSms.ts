// card-sms module — X-009 문자 명함 전송.
// 흐름: 상대의 종이 명함 촬영(OCR, 기존 /capture) → 번호 확인 → **내** 명함(이미지 + 기본정보 + 저장 링크)을 그 번호로 문자 발송
//      → 수신자는 로그인 없이 링크를 열어 구글 연락처/휴대폰 주소록에 저장한다.
//
// 지침과의 관계
//  §2.1 교환이 가입보다 먼저   — 랜딩(/s/{token})은 인증 없이 동작하고 가입을 요구하지 않는다.
//  §2.6 AI 는 사실을 지어내지 않는다 — 본문·이미지의 모든 값은 보낸 사람의 Living Card 에서 ACL 투영된 값뿐이다.
//  §2.8 고위험 자동행동 승인   — 발송은 항상 사용자의 명시적 승인(approved:true) 한 번에 한 건. 자동/예약 발송은 없다.
//  §3   토큰                  — 192bit 랜덤, DB 에는 SHA-256 해시만(재공유용 봉인 사본 별도), TTL·rate limit.
import {
  EXCHANGE_AUDIENCE,
  SEND_DEDUPE_HOURS,
  type CardSmsSender,
  type SmsPlatform,
  buildCardSmsText,
  generateToken,
  hashToken,
  isWellFormedToken,
  maskPhone,
  normalizePhone,
  phoneDeliveryWarning,
  sendGuard,
  smsDeepLink,
  smsKind,
  toVCard,
  vcardFileName,
} from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, conflict, notFound, unauthorized } from "../lib/errors";
import { track } from "../lib/metering";
import { serverOcrAvailable } from "../lib/ocr";
import { type Ctx, appOrigin, audit, hmac, log, rateLimit } from "../lib/platform";
import { type AndroidGatewayCredentials, type SmsImage, SmsUncertainError, checkAndroidGateway, sendSms, sendViaAndroidGateway, smsConfigured, smsProvider } from "../lib/sms";
import { seal, unseal } from "../lib/vault";
import { loadProfile, primaryProfileId, projectCard } from "./card";
import { recordView } from "./cardViews";
import { deleteStoredObject, readObjectBytes, signedFileUrl, storeObject } from "./files";

/** 링크 유효기간: 문자는 몇 시간 뒤에 열어보는 일이 흔하므로 교환 세션(15분)보다 길게 — 30일. */
export const CARD_SMS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- 내 명함 투영

/** 문자·이미지·vCard 에 쓰는 내 기본정보. 교환과 동일한 audience(business)로 투영하므로 교환보다 더 드러나지 않는다. */
async function myCard(userId: string, profileId?: string | null) {
  const pid = profileId ?? (await primaryProfileId(userId));
  if (!pid) throw new ApiError(422, "profile_required", "먼저 내 명함(Living Card)을 만들어 주세요.");
  const p = await loadProfile(pid);
  if (!p || p.userId !== userId) throw notFound("profile");
  const pub = projectCard(p, EXCHANGE_AUDIENCE);
  const f = (...types: string[]) => pub.fields.find((x) => types.includes(x.type))?.value ?? null;
  const sender: CardSmsSender = {
    name: pub.name,
    company: pub.company,
    jobTitle: pub.jobTitle,
    phone: f("mobile", "phone"),
    email: f("email"),
    website: f("website"),
  };
  return { profileId: pid, slug: p.slug, card: pub, sender };
}

// ---------------------------------------------------------------- 발송 경로

/**
 * 보낼 수 있는 길은 세 가지이고, 받는 사람 입장에서 전혀 다르다.
 *  gateway  — 사용자 본인 안드로이드 SIM(공식 Android SMS Gateway 앱). **본인 번호에서** 도착하고 우리 쪽 요금이 없다.
 *  provider — 상용 문자 API(Solapi·Twilio). 사전등록 발신번호로 도착하고 건당 요금이 든다.
 *  device   — 사용자의 문자 앱을 본문이 채워진 상태로 열어 준다. 서버는 발송 여부를 알 수 없다.
 * 명함을 건넨 상대에게는 본인 번호가 맞으므로 gateway 를 우선한다.
 */
export const SEND_CHANNELS = ["gateway", "provider", "device"] as const;
export type SendChannel = (typeof SEND_CHANNELS)[number];

async function gatewayRow(userId: string) {
  return one<{ user_id: string; credentials_sealed: Buffer; label: string | null; verified_at: Date | null; last_used_at: Date | null; last_error: string | null }>(
    "SELECT * FROM sms_gateway_accounts WHERE user_id=$1",
    [userId],
  );
}

/** 보낸 사람의 명함 미리보기(문자 본문·이미지 생성 전에 화면이 먼저 보여 준다). */
export async function cardSmsPreview(ctx: Ctx, profileId?: string | null) {
  if (!ctx.userId) throw unauthorized();
  const { sender, slug, profileId: pid } = await myCard(ctx.userId, profileId);
  const gw = await gatewayRow(ctx.userId);
  const provider = smsProvider();
  return {
    profileId: pid,
    sender,
    cardUrl: `${appOrigin()}/p/${encodeURIComponent(slug)}`,
    provider: smsConfigured() ? provider : null,
    /** 내 안드로이드 폰으로 보낼 수 있는지 */
    gateway: gw ? { connected: true, label: gw.label, verifiedAt: gw.verified_at, lastUsedAt: gw.last_used_at, lastError: gw.last_error } : { connected: false },
    /** 쓸 수 있는 경로. 항상 device 는 들어간다(아무 설정이 없어도 보낼 길은 남는다). */
    channels: [...(gw ? (["gateway"] as const) : []), ...(smsConfigured() ? (["provider"] as const) : []), "device" as const],
    /** 서버 OCR 폴백을 제안해도 되는지(키가 없으면 화면에 버튼을 띄우지 않는다) */
    serverOcr: serverOcrAvailable(),
  };
}

// ---------------------------------------------------------------- 내 안드로이드 폰 연결 (공식 앱 Cloud 모드)

export const gatewayInput = z.object({
  username: z.string().trim().min(1).max(150),
  password: z.string().min(1).max(300),
  label: z.string().trim().max(60).nullish(),
});

/**
 * 공식 앱이 알려 준 Cloud API 사용자명·비밀번호를 봉인해 저장한다. 프런트로 다시 돌려주지 않는다.
 * 저장 즉시 한 번 확인해 두어, 발송 순간에 "인증 실패"로 처음 알게 되는 일을 줄인다.
 */
export async function saveGateway(ctx: Ctx, input: z.infer<typeof gatewayInput>) {
  if (!ctx.userId) throw unauthorized();
  await rateLimit(`cardsms:gateway:${ctx.userId}`, 20, 3600);
  const creds: AndroidGatewayCredentials = { username: input.username, password: input.password };
  const check = await checkAndroidGateway(creds);
  if (check.status === 401 || check.status === 403) throw badRequest("gateway_unauthorized", "게이트웨이 사용자명 또는 비밀번호가 맞지 않습니다. 휴대폰 앱의 Cloud Server 화면에서 다시 확인해 주세요.");
  await pool().query(
    `INSERT INTO sms_gateway_accounts (user_id, credentials_sealed, label, verified_at, last_error)
     VALUES ($1,$2,$3,$4,NULL)
     ON CONFLICT (user_id) DO UPDATE SET credentials_sealed=$2, label=$3, verified_at=$4, last_error=NULL, updated_at=now()`,
    [ctx.userId, seal(creds), input.label ?? null, check.ok ? new Date() : null],
  );
  await audit(pool(), ctx, "card_sms.gateway_connected", "sms_gateway_account", ctx.userId, { verified: check.ok });
  return {
    connected: true,
    verified: check.ok,
    message: check.ok
      ? "인증정보를 암호화해 저장했습니다. 실제 발송은 휴대폰 앱이 켜져 있고 네트워크가 연결된 동안에만 성공합니다."
      : "인증정보를 저장했지만 지금은 게이트웨이에 연결할 수 없었습니다. 휴대폰 앱의 서비스가 실행 중인지 확인해 주세요.",
  };
}

export async function removeGateway(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  const r = await one("DELETE FROM sms_gateway_accounts WHERE user_id=$1 RETURNING user_id", [ctx.userId]);
  if (!r) throw notFound("sms_gateway_account");
  await audit(pool(), ctx, "card_sms.gateway_removed", "sms_gateway_account", ctx.userId);
  return { connected: false };
}

// ---------------------------------------------------------------- 명함 이미지 업로드(클라이언트 캔버스 렌더 결과)

/**
 * 화면에서 그린 PNG 를 검사·재인코딩 후 암호화 저장하고 object id 를 돌려준다.
 * 보낼 때마다 새 object 를 만든다 — 지난 발송이 참조하는 이미지를 덮어쓰면 그 링크의 명함이 바뀌기 때문이다.
 * 만료된 발송의 이미지는 purgeExpiredCardSms 가 (다른 살아 있는 발송이 쓰지 않을 때만) 지운다.
 */
export async function putCardImage(ctx: Ctx, bytes: Buffer, profileId?: string | null) {
  if (!ctx.userId) throw unauthorized();
  await rateLimit(`cardsms:image:${ctx.userId}`, 60, 3600);
  const { profileId: pid } = await myCard(ctx.userId, profileId);
  const stored = await storeObject({ ownerUserId: ctx.userId, purpose: "card_image", bytes, filename: "my-card.png", metadata: { profileId: pid, kind: "card_sms_image" } });
  return { objectId: stored.id, byteSize: stored.byteSize, contentType: stored.contentType };
}

/** 이미지 소유자 확인 — 남의 object id 를 끼워 넣어 보내는 것을 막는다. */
async function ownedCardImage(userId: string, objectId: string): Promise<string> {
  const r = await one<{ id: string }>("SELECT id FROM stored_objects WHERE id=$1 AND owner_user_id=$2 AND purpose='card_image' AND deleted_at IS NULL", [objectId, userId]);
  if (!r) throw notFound("card_image");
  return r.id;
}

// ---------------------------------------------------------------- 준비(초안 생성)

export const prepareInput = z.object({
  /** 종이 명함에서 읽은 상대 정보 — 전화번호 외에는 인사말·이력 표시에만 쓴다 */
  recipient: z.object({
    fullName: z.string().trim().max(120).nullish(),
    phone: z.string().trim().min(6).max(32),
  }),
  profileId: z.string().uuid().nullish(),
  /** 이미 저장한 연락처/캡처와 연결(없어도 발송은 가능) */
  contactId: z.string().uuid().nullish(),
  businessCardId: z.string().uuid().nullish(),
  imageObjectId: z.string().uuid().nullish(),
  placeLabel: z.string().trim().max(120).nullish(),
  locale: z.enum(["ko", "en"]).default("ko"),
  /** 문자 앱 딥링크의 본문 구분자는 iOS/Android 가 다르다 — 폴백 링크를 올바르게 만들기 위해 받는다 */
  platform: z.enum(["ios", "android", "unknown"]).default("unknown"),
  /** 상대가 명함을 직접 건네며 연락에 동의했다는 보낸 사람의 확인 — 없으면 초안조차 만들지 않는다 */
  consent: z.literal("card_handed", { message: "상대가 명함을 직접 건넸다는 확인이 필요합니다." }),
  /**
   * 사용자가 직접 쓴 인사말(자동 인사말 대체). 본문 전체를 받지 않는 이유: 저장 링크는 이 요청에서 처음 만들어지므로
   * 본문을 그대로 받으면 링크 없는 문자가 나갈 수 있다 — 링크 줄은 항상 서버가 붙인다.
   */
  note: z.string().trim().max(300).nullish(),
});

/**
 * `full: false`(목록·이력)에서는 **마스킹된 번호만** 내보낸다 — 지난 발송 이력을 훑는 화면이
 * 연락처 전체를 다시 들고 있을 이유가 없다. 전체 번호는 방금 만든/보낸 건에만 붙는다.
 */
function dto(r: any, opts: { token?: string | null; platform?: SmsPlatform; full?: boolean } = {}) {
  const token = opts.token ?? null;
  const full = opts.full !== false;
  return {
    id: r.id,
    contactId: r.contact_id,
    toName: r.to_name,
    toPhone: full ? r.to_phone : null,
    toPhoneMasked: maskPhone(r.to_phone),
    body: full ? r.body : null,
    kind: r.channel_kind,
    channel: r.channel ?? null,
    status: r.status,
    provider: r.provider,
    error: r.error,
    link: token ? `${appOrigin()}/s/${token}` : null,
    smsLink: token && full ? smsDeepLink(r.to_phone, r.body, opts.platform ?? "unknown") : null,
    withImage: Boolean(r.image_object_id),
    sentAt: r.sent_at,
    openedAt: r.opened_at,
    savedAt: r.saved_at,
    openCount: r.open_count,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

/** 초안 1건 = 링크 1개. 같은 사람에게 다시 보내면 새 링크가 생긴다(이전 링크는 만료까지 그대로 유효하다). */
export async function prepareCardSms(ctx: Ctx, input: z.infer<typeof prepareInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await rateLimit(`cardsms:prepare:${userId}`, 60, 3600);
  const phone = normalizePhone(input.recipient.phone);
  if (!phone) throw badRequest("invalid_phone", "받는 사람 휴대폰 번호를 확인하세요. 종이 명함의 번호가 잘못 읽혔을 수 있어요.");
  const { profileId, slug, sender } = await myCard(userId, input.profileId);
  if (input.contactId) {
    const c = await one("SELECT 1 FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [input.contactId, userId]);
    if (!c) throw notFound("contact");
  }
  if (input.businessCardId) {
    const b = await one("SELECT 1 FROM business_cards WHERE id=$1 AND captured_by=$2", [input.businessCardId, userId]);
    if (!b) throw notFound("business_card");
  }
  const imageObjectId = input.imageObjectId ? await ownedCardImage(userId, input.imageObjectId) : null;

  const token = generateToken();
  const tokenHash = await hashToken(token);
  const link = `${appOrigin()}/s/${token}`;
  const body = buildCardSmsText(sender, link, {
    recipientName: input.recipient.fullName ?? null,
    placeLabel: input.placeLabel ?? null,
    note: input.note ?? null,
    withImage: Boolean(imageObjectId),
    locale: input.locale,
  });
  const kind = smsKind(body, Boolean(imageObjectId));
  if (kind === "too_long") throw badRequest("body_too_long", "문자 본문이 2,000바이트를 넘습니다. 내용을 줄여 주세요.");

  const row = await one<any>(
    `INSERT INTO card_sms_deliveries
       (owner_user_id, profile_id, contact_id, business_card_id, image_object_id, token_hash, token_sealed, to_phone, destination_hash, to_name, body, channel_kind, consent_basis, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'card_handed',$13) RETURNING *`,
    [userId, profileId, input.contactId ?? null, input.businessCardId ?? null, imageObjectId, tokenHash, seal({ t: token }), phone, destinationHash(phone), input.recipient.fullName ?? null, body, kind, new Date(Date.now() + CARD_SMS_TTL_MS)],
  );
  await audit(pool(), ctx, "card_sms.prepared", "card_sms_delivery", row!.id, { kind, withImage: Boolean(imageObjectId), consentBasis: "card_handed" });
  return {
    ...dto(row, { token, platform: input.platform }),
    cardUrl: `${appOrigin()}/p/${encodeURIComponent(slug)}`,
    canSend: smsConfigured(),
    sender,
    /** 유선번호처럼 문자가 도착하지 않을 수 있는 번호면 화면이 한 번 더 묻는다(차단은 하지 않는다) */
    deliveryWarning: phoneDeliveryWarning(phone),
  };
}

// ---------------------------------------------------------------- 발송(명시적 승인)

export const sendCardSmsInput = z.object({
  approved: z.literal(true, { message: "문자를 보내려면 사용자의 명시적 승인이 필요합니다." }),
  /** 어느 길로 보낼지. auto = 내 폰(gateway) → 상용 API(provider) → 내 문자 앱(device) 순. */
  via: z.enum(["auto", "gateway", "provider", "device"]).default("auto"),
  platform: z.enum(["ios", "android", "unknown"]).default("unknown"),
});

/** 번호를 그대로 비교하지 않기 위한 값. 키는 AUTH_SECRET 이라 DB 만 새도 번호를 되돌릴 수 없다. */
function destinationHash(e164: string): string {
  return hmac(`card_sms:${e164}`);
}

/**
 * 사람 기준 남용 방지. 시간당 rate limit 과 다른 층이다 — 같은 상대에게 두 번, 연타, 하루 과다를 막는다.
 * 판정은 순수 함수(domain.sendGuard)가 하고 여기서는 셋만 조회한다.
 */
async function assertSendable(userId: string, destHash: string, excludeId: string) {
  const counted = "status IN ('sent','sending','uncertain','manual')";
  const [last, daily, same] = await Promise.all([
    one<{ at: Date }>(`SELECT COALESCE(sent_at, approved_at, created_at) AS at FROM card_sms_deliveries WHERE owner_user_id=$1 AND id<>$2 AND ${counted} ORDER BY at DESC LIMIT 1`, [userId, excludeId]),
    one<{ n: number }>(`SELECT count(*)::int AS n FROM card_sms_deliveries WHERE owner_user_id=$1 AND id<>$2 AND ${counted} AND created_at > now() - interval '24 hours'`, [userId, excludeId]),
    one(`SELECT 1 FROM card_sms_deliveries WHERE owner_user_id=$1 AND id<>$2 AND destination_hash=$3 AND ${counted} AND created_at > now() - interval '${SEND_DEDUPE_HOURS} hours' LIMIT 1`, [userId, excludeId, destHash]),
  ]);
  const verdict = sendGuard({ lastSentAt: last?.at ?? null, dailyCount: daily?.n ?? 0, recentSameRecipient: Boolean(same) });
  if (verdict.ok) return;
  if (verdict.code === "too_soon") throw new ApiError(429, verdict.code, verdict.message, { retryAfter: verdict.retryAfterSec });
  throw new ApiError(verdict.code === "duplicate_recipient" ? 409 : 429, verdict.code, verdict.message);
}

async function ownedDelivery(userId: string, id: string) {
  const r = await one<any>("SELECT * FROM card_sms_deliveries WHERE id=$1 AND owner_user_id=$2", [id, userId]);
  if (!r) throw notFound("card_sms_delivery");
  return r;
}

function tokenOf(row: { token_sealed: Buffer }): string {
  return unseal<{ t: string }>(row.token_sealed).t;
}

/** 목록용: 봉인 사본을 열 수 없는 행(키가 이미 폐기됨)이 목록 전체를 깨뜨리지 않게 한다. */
function tokenOrNull(row: { id: string; token_sealed: Buffer }): string | null {
  try {
    return tokenOf(row);
  } catch (e) {
    log("warn", "card_sms.token_unseal_failed", { delivery: row.id, error: (e as Error).message });
    return null;
  }
}

/** 문자에 실어 보낼 이미지. Twilio 는 발송 시점에 URL 을 직접 가져가므로 짧은 서명 URL 을 같이 넘긴다. */
async function imageFor(row: any): Promise<SmsImage | null> {
  if (!row.image_object_id) return null;
  try {
    const o = await readObjectBytes(row.image_object_id);
    const origin = appOrigin();
    const url = /^https:\/\//.test(origin) ? `${origin}${signedFileUrl(row.image_object_id, 900)}` : null;
    return { bytes: o.bytes, contentType: o.contentType, publicUrl: url };
  } catch (e) {
    log("warn", "card_sms.image_unavailable", { delivery: row.id, error: (e as Error).message });
    return null;
  }
}

/** 요청한 경로를 쓸 수 있는지 확인하고, auto 면 내 폰 → 상용 API → 내 문자 앱 순으로 고른다. */
async function pickChannel(userId: string, via: "auto" | SendChannel): Promise<{ channel: SendChannel; creds?: AndroidGatewayCredentials }> {
  const gw = via === "provider" || via === "device" ? null : await gatewayRow(userId);
  if (via === "gateway") {
    if (!gw) throw new ApiError(409, "gateway_not_connected", "내 안드로이드 폰을 먼저 연결해 주세요.");
    return { channel: "gateway", creds: unseal<AndroidGatewayCredentials>(gw.credentials_sealed) };
  }
  if (via === "provider") {
    if (!smsConfigured()) throw new ApiError(409, "provider_not_configured", "이 서버에는 문자 발송 API가 설정돼 있지 않습니다.");
    return { channel: "provider" };
  }
  if (via === "device") return { channel: "device" };
  if (gw) return { channel: "gateway", creds: unseal<AndroidGatewayCredentials>(gw.credentials_sealed) };
  return { channel: smsConfigured() ? "provider" : "device" };
}

/**
 * 승인 1회 = 발송 1회. 같은 버튼을 두 번 눌러도 두 번 가지 않는다(상태 전이로 선점).
 *
 * 세 가지 결말이 있고 **어느 것도 "상대가 받았다"를 뜻하지 않는다**:
 *  sent      — 외부(상용 API 또는 내 폰의 게이트웨이)가 요청을 접수했다.
 *  uncertain — 요청은 나갔지만 응답을 못 받았다. 이미 갔을 수 있으니 **자동 재시도하지 않는다**.
 *  manual    — 보낼 길이 없어 사용자의 문자 앱으로 넘겼다. 서버는 발송 여부를 알 수 없다.
 */
export async function sendCardSms(ctx: Ctx, id: string, input: z.infer<typeof sendCardSmsInput>) {
  if (!ctx.userId) throw unauthorized();
  if (!input.approved) throw badRequest("approval_required", "문자를 보내려면 사용자의 명시적 승인이 필요합니다.");
  const userId = ctx.userId;
  await rateLimit(`cardsms:send:${userId}`, 50, 3600);
  const pre = await ownedDelivery(userId, id);
  const token = tokenOf(pre);
  const view = (row: any) => dto(row, { token, platform: input.platform });
  // 재클릭·재시도는 이미 난 결과를 그대로 돌려준다(두 번 가지 않는다)
  if (pre.status === "sent") return { ...view(pre), gateway: true as const };
  if (pre.status === "uncertain") return { ...view(pre), gateway: true as const, uncertain: true as const };
  if (pre.status === "manual") return { ...view(pre), gateway: false as const };
  if (new Date(pre.expires_at).getTime() < Date.now()) throw conflict("link_expired", "링크가 만료되었습니다. 다시 만들어 주세요.");

  const { channel, creds } = await pickChannel(userId, input.via);
  // 사람 기준 남용 방지는 실제로 나가는 경로에만 적용한다(문자 앱을 여는 것은 발송이 아니다).
  if (channel !== "device") await assertSendable(userId, pre.destination_hash ?? destinationHash(pre.to_phone), id);

  if (channel === "device") {
    const row = await one<any>(
      "UPDATE card_sms_deliveries SET status='manual', channel='device', approved_at=now(), approved_by=$2, updated_at=now() WHERE id=$1 AND status IN ('draft','failed') RETURNING *",
      [id, userId],
    );
    const r = row ?? pre;
    await audit(pool(), ctx, "card_sms.handed_to_device", "card_sms_delivery", id, { reason: smsConfigured() ? "user_choice" : "no_gateway_configured" });
    return { ...view(r), gateway: false as const };
  }

  const claimed = await one<any>(
    "UPDATE card_sms_deliveries SET status='sending', channel=$3, approved_at=now(), approved_by=$2, error=NULL, updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND status IN ('draft','failed') RETURNING *",
    [id, userId, channel],
  );
  if (!claimed) throw conflict("not_sendable", "이미 보내는 중이거나 취소된 문자입니다.");

  // 1) 외부 호출.
  //    거절(인증 실패·발신번호 미등록 …)  → 아무것도 가지 않았으므로 failed(재시도 가능)
  //    응답 없음(네트워크·5xx)            → uncertain. 재시도하지 않는다 — 두 번 도착하는 것이 더 나쁘다.
  let result: Awaited<ReturnType<typeof sendSms>>;
  try {
    result =
      channel === "gateway"
        ? await sendViaAndroidGateway(creds!, claimed.to_phone, claimed.body)
        : await sendSms(claimed.to_phone, claimed.body, await imageFor(claimed));
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    const uncertain = e instanceof SmsUncertainError;
    await pool().query("UPDATE card_sms_deliveries SET status=$2, error=$3, updated_at=now() WHERE id=$1", [id, uncertain ? "uncertain" : "failed", message]);
    if (channel === "gateway") await pool().query("UPDATE sms_gateway_accounts SET last_error=$2, updated_at=now() WHERE user_id=$1", [userId, message]);
    await audit(pool(), ctx, uncertain ? "card_sms.uncertain" : "card_sms.failed", "card_sms_delivery", id, { channel });
    log(uncertain ? "warn" : "error", uncertain ? "card_sms.uncertain" : "card_sms.send_failed", { delivery: id, channel, error: message });
    if (uncertain) {
      throw new ApiError(502, "sms_uncertain", message, { status: "uncertain", retryable: false });
    }
    throw new ApiError(
      502,
      "sms_send_failed",
      channel === "gateway"
        ? "내 폰의 게이트웨이가 요청을 거절했습니다. 앱이 실행 중인지, 문자 권한과 네트워크가 살아 있는지 확인하거나 문자 앱으로 직접 보내세요."
        : "문자 발송이 거부되었습니다. 발신번호 등록과 잔액을 확인하거나, 문자 앱으로 직접 보내세요.",
      { providerError: message },
    );
  }

  // 2) 이 지점부터 문자는 이미 나갔다 — 기록이 실패해도 **다시 보내서는 안 되므로** sent 로 남긴다.
  const nextKind = result.withImage ? "mms" : claimed.channel_kind === "mms" ? "lms" : claimed.channel_kind;
  try {
    const sent = await tx(async (c) => {
      // 발송 이력은 messages(channel='sms') 에도 남겨 /app/messages 에서 함께 보인다.
      const msg = await one<{ id: string }>(
        `INSERT INTO messages (owner_user_id, contact_id, channel, to_address, to_name, body, language, provenance, status, provider, provider_message_id, approved_at, approved_by, sent_at)
         VALUES ($1,$2,'sms',$3,$4,$5,'ko','user','sent',$6,$7,now(),$1,now()) RETURNING id`,
        [userId, claimed.contact_id, claimed.to_phone, claimed.to_name, claimed.body, result.provider, result.messageId],
        c,
      );
      const r = await one<any>(
        "UPDATE card_sms_deliveries SET status='sent', provider=$2, provider_message_id=$3, channel_kind=$4, message_id=$5, sent_at=now(), error=NULL, updated_at=now() WHERE id=$1 RETURNING *",
        [id, result.provider, result.messageId, nextKind, msg!.id],
        c,
      );
      if (claimed.contact_id) await c.query("UPDATE relationships SET last_contact_at=now() WHERE owner_user_id=$1 AND contact_id=$2", [userId, claimed.contact_id]);
      if (channel === "gateway") await c.query("UPDATE sms_gateway_accounts SET last_used_at=now(), last_error=NULL, verified_at=COALESCE(verified_at, now()), updated_at=now() WHERE user_id=$1", [userId]);
      await audit(c, ctx, "card_sms.sent", "card_sms_delivery", id, { channel, provider: result.provider, approved: true, withImage: result.withImage });
      await track(c, "card_sms_sent", { userId }, { channel, provider: result.provider ?? "none", with_image: result.withImage, kind: r!.channel_kind });
      return r;
    });
    log("info", "card_sms.sent", { delivery: id, channel, provider: result.provider, withImage: result.withImage });
    return { ...view(sent), gateway: true as const, imageDropped: result.reason === "image_upload_failed" };
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    log("error", "card_sms.record_failed_after_send", { delivery: id, provider: result.provider, error: message });
    const r = await one<any>(
      "UPDATE card_sms_deliveries SET status='sent', provider=$2, provider_message_id=$3, channel_kind=$4, sent_at=COALESCE(sent_at, now()), error=$5, updated_at=now() WHERE id=$1 RETURNING *",
      [id, result.provider, result.messageId, nextKind, `발송은 성공했지만 이력 기록에 실패했습니다: ${message}`],
    ).catch(() => null);
    return { ...view(r ?? { ...claimed, status: "sent" }), gateway: true as const, imageDropped: result.reason === "image_upload_failed" };
  }
}

export async function cancelCardSms(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<any>("UPDATE card_sms_deliveries SET status='cancelled', updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND status IN ('draft','failed') RETURNING *", [id, ctx.userId]);
  if (!r) throw conflict("not_cancellable", "이미 보낸 문자는 취소할 수 없습니다.");
  await audit(pool(), ctx, "card_sms.cancelled", "card_sms_delivery", id);
  return dto(r, { token: tokenOf(r) });
}

/**
 * 보낸 이력. 번호는 마스킹만, 본문·딥링크는 내보내지 않는다 — 이력을 보려고 지난 연락처 전체를
 * 다시 브라우저로 내려보낼 이유가 없다(§3 최소 수집). 저장 링크는 다시 공유할 수 있어야 하므로 남긴다.
 */
export async function listCardSms(userId: string, limit = 30) {
  const rows = await q<any>("SELECT * FROM card_sms_deliveries WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT $2", [userId, Math.min(limit, 100)]);
  return rows.map((r) => dto(r, { token: tokenOrNull(r), full: false }));
}

// ---------------------------------------------------------------- 수신자(공개, 로그인 없음)

export interface CardSmsLanding {
  deliveryId: string;
  sender: Awaited<ReturnType<typeof myCard>>["card"];
  /** 문자로 받은 것과 같은 명함 이미지(짧은 서명 URL) */
  imageUrl: string | null;
  toName: string | null;
  vcardPath: string;
  googleContactsUrl: string;
  expiresAt: string;
}

async function byToken(token: string, db: Db = pool()) {
  if (!isWellFormedToken(token)) throw notFound("card_sms_delivery");
  const r = await one<any>("SELECT * FROM card_sms_deliveries WHERE token_hash=$1", [await hashToken(token)], db);
  if (!r) throw notFound("card_sms_delivery");
  if (new Date(r.expires_at).getTime() < Date.now()) throw new ApiError(410, "link_expired", "링크가 만료되었습니다. 보낸 분께 다시 요청해 주세요.");
  if (r.status === "cancelled") throw new ApiError(410, "link_revoked", "보낸 분이 이 링크를 취소했습니다.");
  return r;
}

/**
 * 랜딩 열기. 가입·로그인 요구 없음(§2.1). 토큰은 192bit 라 추측할 수 없으므로 코드 추측 방어는 필요하지 않지만,
 * 한 링크를 긁어 가는 것을 막기 위해 열람 자체에 느슨한 rate limit 을 둔다.
 */
export async function openCardSmsLanding(token: string, ctx: Ctx, privacy: { gpc?: string | null; dnt?: string | null } = {}): Promise<CardSmsLanding> {
  await rateLimit(`cardsms:open:${ctx.ip}`, 120, 600);
  const row = await byToken(token);
  const p = await loadProfile(row.profile_id);
  if (!p) throw notFound("profile");
  const card = projectCard(p, EXCHANGE_AUDIENCE);
  await pool().query("UPDATE card_sms_deliveries SET opened_at=COALESCE(opened_at, now()), open_count=open_count+1, updated_at=now() WHERE id=$1", [row.id]);
  // X-003 조회 집계는 카드 소유자에게만 +1 (방문자 식별자는 저장하지 않는다)
  await recordView({ profileId: row.profile_id, kind: "view", viewerUserId: ctx.userId, gpc: privacy.gpc, dnt: privacy.dnt }).catch(() => false);
  await track(null, "card_sms_opened", { userId: row.owner_user_id }, { with_image: Boolean(row.image_object_id) });
  return {
    deliveryId: row.id,
    sender: card,
    imageUrl: row.image_object_id ? signedFileUrl(row.image_object_id, 1800) : null,
    toName: row.to_name,
    vcardPath: `/s/${token}/vcard`,
    googleContactsUrl: "https://contacts.google.com/",
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** 수신자가 누르는 "연락처에 저장" — 구글 연락처·휴대폰 주소록이 모두 읽는 .vcf 를 그대로 내려준다. */
export async function cardSmsVcard(token: string, ctx: Ctx): Promise<{ filename: string; vcard: string }> {
  await rateLimit(`cardsms:vcard:${ctx.ip}`, 60, 600);
  const row = await byToken(token);
  const p = await loadProfile(row.profile_id);
  if (!p) throw notFound("profile");
  const card = projectCard(p, EXCHANGE_AUDIENCE);
  const f = (...types: string[]) => card.fields.find((x) => types.includes(x.type))?.value ?? null;
  const vcard = toVCard({
    fullName: card.name,
    company: card.company,
    jobTitle: card.jobTitle,
    email: f("email"),
    phone: f("mobile", "phone"),
    address: f("address"),
    website: f("website"),
    note: card.headline,
  });
  await pool().query("UPDATE card_sms_deliveries SET saved_at=COALESCE(saved_at, now()), updated_at=now() WHERE id=$1", [row.id]);
  await recordView({ profileId: row.profile_id, kind: "vcard", viewerUserId: ctx.userId }).catch(() => false);
  await track(null, "card_sms_saved", { userId: row.owner_user_id }, {});
  return { filename: vcardFileName(card.name), vcard };
}

/** 관리자/보존 정책: 만료된 링크의 명함 이미지는 더 쓰이지 않으므로 지운다. 워커에서 호출한다. */
export async function purgeExpiredCardSms(limit = 200): Promise<number> {
  const rows = await q<{ id: string; image_object_id: string | null }>(
    "SELECT id, image_object_id FROM card_sms_deliveries WHERE expires_at < now() AND image_object_id IS NOT NULL ORDER BY expires_at LIMIT $1",
    [limit],
  );
  let n = 0;
  for (const r of rows) {
    // 같은 이미지를 아직 살아 있는 다른 발송이 쓰고 있으면 건드리지 않는다
    const inUse = await one("SELECT 1 FROM card_sms_deliveries WHERE image_object_id=$1 AND expires_at >= now() LIMIT 1", [r.image_object_id]);
    await pool().query("UPDATE card_sms_deliveries SET image_object_id=NULL, updated_at=now() WHERE id=$1", [r.id]);
    if (!inUse && r.image_object_id) await deleteStoredObject(r.image_object_id).catch(() => undefined);
    n++;
  }
  return n;
}
