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
  type CardSmsSender,
  buildCardSmsText,
  generateToken,
  hashToken,
  isWellFormedToken,
  normalizePhone,
  smsDeepLink,
  smsKind,
  toVCard,
  vcardFileName,
} from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, conflict, notFound, unauthorized } from "../lib/errors";
import { track } from "../lib/metering";
import { type Ctx, appOrigin, audit, log, rateLimit } from "../lib/platform";
import { type SmsImage, sendSms, smsConfigured, smsProvider } from "../lib/sms";
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

/** 보낸 사람의 명함 미리보기(문자 본문·이미지 생성 전에 화면이 먼저 보여 준다). */
export async function cardSmsPreview(ctx: Ctx, profileId?: string | null) {
  if (!ctx.userId) throw unauthorized();
  const { sender, slug, profileId: pid } = await myCard(ctx.userId, profileId);
  return {
    profileId: pid,
    sender,
    cardUrl: `${appOrigin()}/p/${encodeURIComponent(slug)}`,
    provider: smsProvider(),
    /** false 면 화면은 "문자 앱으로 보내기"(딥링크)만 제안한다 */
    canSend: smsConfigured(),
  };
}

// ---------------------------------------------------------------- 명함 이미지 업로드(클라이언트 캔버스 렌더 결과)

/** 화면에서 그린 PNG 를 암호화 저장하고 object id 를 돌려준다. 같은 프로필의 이전 이미지는 지운다(한 장만 유지). */
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
  /** 상대가 명함을 직접 건네며 연락에 동의했다는 보낸 사람의 확인 — 없으면 초안조차 만들지 않는다 */
  consent: z.literal("card_handed", { message: "상대가 명함을 직접 건넸다는 확인이 필요합니다." }),
  /**
   * 사용자가 직접 쓴 인사말(자동 인사말 대체). 본문 전체를 받지 않는 이유: 저장 링크는 이 요청에서 처음 만들어지므로
   * 본문을 그대로 받으면 링크 없는 문자가 나갈 수 있다 — 링크 줄은 항상 서버가 붙인다.
   */
  note: z.string().trim().max(300).nullish(),
});

function dto(r: any, opts: { token?: string | null } = {}) {
  const token = opts.token ?? null;
  return {
    id: r.id,
    contactId: r.contact_id,
    toName: r.to_name,
    toPhone: r.to_phone,
    body: r.body,
    kind: r.channel_kind,
    status: r.status,
    provider: r.provider,
    error: r.error,
    link: token ? `${appOrigin()}/s/${token}` : null,
    smsLink: token ? smsDeepLink(r.to_phone, r.body) : null,
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
       (owner_user_id, profile_id, contact_id, business_card_id, image_object_id, token_hash, token_sealed, to_phone, to_name, body, channel_kind, consent_basis, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'card_handed',$12) RETURNING *`,
    [userId, profileId, input.contactId ?? null, input.businessCardId ?? null, imageObjectId, tokenHash, seal({ t: token }), phone, input.recipient.fullName ?? null, body, kind, new Date(Date.now() + CARD_SMS_TTL_MS)],
  );
  await audit(pool(), ctx, "card_sms.prepared", "card_sms_delivery", row!.id, { kind, withImage: Boolean(imageObjectId), consentBasis: "card_handed" });
  return { ...dto(row, { token }), cardUrl: `${appOrigin()}/p/${encodeURIComponent(slug)}`, canSend: smsConfigured(), sender };
}

// ---------------------------------------------------------------- 발송(명시적 승인)

export const sendCardSmsInput = z.object({
  approved: z.literal(true, { message: "문자를 보내려면 사용자의 명시적 승인이 필요합니다." }),
});

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

/**
 * 승인 1회 = 발송 1회. 같은 버튼을 두 번 눌러도 두 번 가지 않는다(상태 전이로 선점).
 * 게이트웨이가 없으면 실패가 아니라 `manual` — 링크와 본문이 담긴 문자 앱 딥링크를 돌려주고 사용자가 직접 보낸다.
 */
export async function sendCardSms(ctx: Ctx, id: string, input: z.infer<typeof sendCardSmsInput>) {
  if (!ctx.userId) throw unauthorized();
  if (!input.approved) throw badRequest("approval_required", "문자를 보내려면 사용자의 명시적 승인이 필요합니다.");
  const userId = ctx.userId;
  await rateLimit(`cardsms:send:${userId}`, 50, 3600);
  const pre = await ownedDelivery(userId, id);
  const token = tokenOf(pre);
  // 재클릭·재시도는 보낸 결과를 그대로 돌려준다(두 번 가지 않는다)
  if (pre.status === "sent") return { ...dto(pre, { token }), gateway: true as const };
  if (pre.status === "manual") return { ...dto(pre, { token }), gateway: false as const };
  if (new Date(pre.expires_at).getTime() < Date.now()) throw conflict("link_expired", "링크가 만료되었습니다. 다시 만들어 주세요.");

  if (!smsConfigured()) {
    const row = await one<any>("UPDATE card_sms_deliveries SET status='manual', approved_at=now(), approved_by=$2, updated_at=now() WHERE id=$1 AND status IN ('draft','failed') RETURNING *", [id, userId]);
    const r = row ?? pre;
    await audit(pool(), ctx, "card_sms.handed_to_device", "card_sms_delivery", id, { reason: "gateway_not_configured" });
    return { ...dto(r, { token }), gateway: false as const };
  }

  const claimed = await one<any>(
    "UPDATE card_sms_deliveries SET status='sending', approved_at=now(), approved_by=$2, error=NULL, updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND status IN ('draft','failed') RETURNING *",
    [id, userId],
  );
  if (!claimed) throw conflict("not_sendable", "이미 보내는 중이거나 취소된 문자입니다.");

  // 1) provider 호출. 여기서 실패하면 아직 아무것도 가지 않았으므로 failed 로 되돌려 다시 시도할 수 있게 한다.
  let result: Awaited<ReturnType<typeof sendSms>>;
  try {
    result = await sendSms(claimed.to_phone, claimed.body, await imageFor(claimed));
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    await pool().query("UPDATE card_sms_deliveries SET status='failed', error=$2, updated_at=now() WHERE id=$1", [id, message]);
    log("error", "card_sms.send_failed", { delivery: id, error: message });
    throw new ApiError(502, "sms_send_failed", "문자 발송이 거부되었습니다. 발신번호 등록과 잔액을 확인하거나, 문자 앱으로 직접 보내세요.", { providerError: message });
  }

  // 2) 이 지점부터 문자는 이미 상대 휴대폰으로 갔다 — 기록이 실패해도 **다시 보내서는 안 되므로** sent 로 남긴다.
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
        [id, result.provider, result.messageId, result.withImage ? "mms" : claimed.channel_kind === "mms" ? "lms" : claimed.channel_kind, msg!.id],
        c,
      );
      if (claimed.contact_id) await c.query("UPDATE relationships SET last_contact_at=now() WHERE owner_user_id=$1 AND contact_id=$2", [userId, claimed.contact_id]);
      await audit(c, ctx, "card_sms.sent", "card_sms_delivery", id, { provider: result.provider, approved: true, withImage: result.withImage });
      await track(c, "card_sms_sent", { userId }, { provider: result.provider ?? "none", with_image: result.withImage, kind: r!.channel_kind });
      return r;
    });
    log("info", "card_sms.sent", { delivery: id, provider: result.provider, withImage: result.withImage });
    return { ...dto(sent, { token }), gateway: true as const, imageDropped: result.reason === "image_upload_failed" };
  } catch (e) {
    // 기록 실패: 문자는 이미 갔으므로 failed(=재시도 대상)로 되돌리지 않고, sent 로 두고 흔적만 남긴다.
    const message = (e as Error).message.slice(0, 300);
    log("error", "card_sms.record_failed_after_send", { delivery: id, provider: result.provider, error: message });
    const r = await one<any>(
      "UPDATE card_sms_deliveries SET status='sent', provider=$2, provider_message_id=$3, sent_at=COALESCE(sent_at, now()), error=$4, updated_at=now() WHERE id=$1 RETURNING *",
      [id, result.provider, result.messageId, `발송은 성공했지만 이력 기록에 실패했습니다: ${message}`],
    ).catch(() => null);
    return { ...dto(r ?? { ...claimed, status: "sent" }, { token }), gateway: true as const, imageDropped: result.reason === "image_upload_failed" };
  }
}

export async function cancelCardSms(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<any>("UPDATE card_sms_deliveries SET status='cancelled', updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND status IN ('draft','failed') RETURNING *", [id, ctx.userId]);
  if (!r) throw conflict("not_cancellable", "이미 보낸 문자는 취소할 수 없습니다.");
  await audit(pool(), ctx, "card_sms.cancelled", "card_sms_delivery", id);
  return dto(r, { token: tokenOf(r) });
}

export async function listCardSms(userId: string, limit = 30) {
  const rows = await q<any>("SELECT * FROM card_sms_deliveries WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT $2", [userId, Math.min(limit, 100)]);
  return rows.map((r) => dto(r, { token: tokenOrNull(r) }));
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
