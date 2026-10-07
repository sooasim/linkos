// handoff channels — the remaining rungs of the Adaptive Handoff ladder (part of the handoff module, split for size):
//   F-044 NFC 액세서리 (owner-registered tag → fresh single-use session per tap)
//   F-046 웹-웹 페어링 (server rendezvous: receiver "받기 모드" code → sender enters + confirms)
//   F-039/F-040 앱 근접 교환 + 근접 확인 (BLE ephemeral ids, RSSI on device, mutual 4-digit confirmation)
//   F-052 오프라인 큐 (per-device HMAC keys, signed pass/receipt, idempotent sync)
// No browser phone↔phone NFC/Bluetooth: web pairing always goes through the server.
import { randomBytes } from "node:crypto";
import {
  DEFAULT_PROXIMITY_POLICY,
  PROXIMITY_ID_TTL_MS,
  PROXIMITY_MATCH_TTL_MS,
  PROXIMITY_ROTATE_MS,
  RENDEZVOUS_CONFIRM_MS,
  RENDEZVOUS_MAX_ATTEMPTS,
  RENDEZVOUS_TTL_MS,
  type RendezvousStatus,
  acceptsReply,
  checkReceiptWindow,
  ephemeralIdToServiceUuid,
  generateEphemeralId,
  generateRendezvousCode,
  generateToken,
  generateVerifyCode,
  hashToken,
  isEphemeralId,
  isWellFormedToken,
  normalizeRendezvousCode,
  parseOfflinePass,
  parseOfflineReceipt,
  rendezvousStatusAt,
  verifyOfflinePass,
  verifyOfflineReceiptSignature,
} from "@linkos/domain";
import type pg from "pg";
import { z } from "zod";
import { one, q, tx } from "../lib/db";
import { ApiError, badRequest, conflict, forbidden, gone, notFound, unauthorized } from "../lib/errors";
import { type Ctx, appOrigin, audit, emit, rateLimit, sha256 } from "../lib/platform";
import { getExchangeCard, primaryProfileId } from "./card";
import { type ReplyInput, type SessionRow, applyReply, cardToContact, createExchangeSession, recordAttempt } from "./handoff";
import { deviceLabel, recordConsents } from "./identity";
import { seal, unseal } from "./integration";
import { insertContact } from "./relationship";

const sealText = (v: string) => seal({ v }).toString("base64");
const unsealText = (b64: string) => unseal<{ v: string }>(Buffer.from(b64, "base64")).v;

// =====================================================================================
// F-044 NFC 액세서리
// =====================================================================================
export const nfcTagInput = z.object({ label: z.string().trim().min(1).max(60), profileId: z.string().uuid().optional() });
const MAX_ACTIVE_TAGS = 20;

export function nfcTagUrl(tagId: string): string {
  return `${appOrigin()}/n/${tagId}`;
}

/** Register a tag. The tag id (128-bit) is returned once — it is what gets written to the NDEF URL record. */
export async function registerNfcTag(ctx: Ctx, input: z.infer<typeof nfcTagInput>) {
  if (!ctx.userId) throw unauthorized();
  await rateLimit(`nfc:create:${ctx.userId}`, 20, 86400);
  const userId = ctx.userId;
  const profileId = input.profileId ?? (await primaryProfileId(userId));
  if (!profileId) throw new ApiError(422, "profile_required", "먼저 내 명함(Living Card)을 만들어 주세요.");
  const owns = await one("SELECT 1 FROM profiles WHERE id=$1 AND user_id=$2", [profileId, userId]);
  if (!owns) throw notFound("profile");
  const tagId = generateToken(16);
  return tx(async (c) => {
    const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM nfc_tags WHERE owner_user_id=$1 AND revoked_at IS NULL", [userId], c);
    if ((n?.n ?? 0) >= MAX_ACTIVE_TAGS) throw conflict("too_many_tags", `NFC 태그는 최대 ${MAX_ACTIVE_TAGS}개까지 등록할 수 있습니다.`);
    const row = await one<{ id: string; created_at: Date }>(
      "INSERT INTO nfc_tags (owner_user_id, profile_id, tag_hash, label) VALUES ($1,$2,$3,$4) RETURNING id, created_at",
      [userId, profileId, sha256(tagId), input.label],
      c,
    );
    await audit(c, ctx, "nfc_tag.registered", "nfc_tag", row!.id, { label: input.label });
    return { id: row!.id, tagId, url: nfcTagUrl(tagId), label: input.label, createdAt: row!.created_at };
  });
}

export async function listNfcTags(userId: string) {
  return q<{ id: string; label: string; use_count: number; last_used_at: Date | null; created_at: Date; revoked_at: Date | null }>(
    "SELECT id, label, use_count, last_used_at, created_at, revoked_at FROM nfc_tags WHERE owner_user_id=$1 ORDER BY revoked_at NULLS FIRST, created_at DESC LIMIT 50",
    [userId],
  );
}

export async function revokeNfcTag(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  return tx(async (c) => {
    const r = await c.query("UPDATE nfc_tags SET revoked_at = COALESCE(revoked_at, now()) WHERE id=$1 AND owner_user_id=$2", [id, ctx.userId]);
    if (r.rowCount === 0) throw notFound("nfc_tag");
    await audit(c, ctx, "nfc_tag.revoked", "nfc_tag", id);
    return { revoked: true };
  });
}

/**
 * GET /n/{tagId}: a tap opens the owner's card. Every tap mints a fresh single-use exchange session
 * (the tag never carries a reusable exchange token), then the browser is redirected to the guest landing.
 */
export async function tapNfcTag(tagId: string, ctx: Ctx): Promise<{ url: string; sessionId: string }> {
  if (!isWellFormedToken(tagId)) throw notFound("nfc_tag");
  const hash = sha256(tagId);
  await rateLimit(`nfc:tap:${hash.slice(0, 24)}`, 30, 600);
  await rateLimit(`nfc:tapip:${ctx.ip}`, 60, 600);
  const tag = await one<{ id: string; owner_user_id: string; profile_id: string | null; revoked_at: Date | null }>(
    "SELECT id, owner_user_id, profile_id, revoked_at FROM nfc_tags WHERE tag_hash=$1",
    [hash],
  );
  if (!tag) throw notFound("nfc_tag");
  if (tag.revoked_at) throw gone("nfc_tag_revoked", "이 NFC 태그는 소유자가 비활성화했습니다.");
  const ownerCtx: Ctx = { ...ctx, userId: tag.owner_user_id };
  const profileId = tag.profile_id ?? (await primaryProfileId(tag.owner_user_id)) ?? undefined;
  const s = await createExchangeSession(ownerCtx, { capabilities: { nfcAccessoryEnabled: true, online: true }, group: false, profileId, context: {} });
  await recordAttempt(ownerCtx, s.sessionId, "nfc_accessory", "success");
  await q("UPDATE nfc_tags SET use_count = use_count + 1, last_used_at = now() WHERE id=$1", [tag.id]);
  return { url: s.url, sessionId: s.sessionId };
}

// =====================================================================================
// F-046 웹-웹 페어링 (server rendezvous)
// =====================================================================================
interface RendezvousRow {
  id: string;
  code: string;
  receiver_user_id: string | null;
  receiver_hint: string | null;
  status: RendezvousStatus;
  exchange_session_id: string | null;
  token_enc: string | null;
  matched_at: Date | null;
  delivered_at: Date | null;
  expires_at: Date;
}

async function expireStaleRendezvous(c: pg.PoolClient) {
  await c.query(
    `UPDATE exchange_rendezvous SET status='expired'
     WHERE (status='waiting' AND expires_at <= now()) OR (status='matched' AND matched_at < now() - ($1 || ' milliseconds')::interval)`,
    [String(RENDEZVOUS_CONFIRM_MS)],
  );
}

/** Receiver taps "받기 모드": gets a 4-digit code to say out loud and a secret listen token to poll with. */
export async function startRendezvous(ctx: Ctx) {
  await rateLimit(`rdv:start:${ctx.ip}`, 20, 600);
  const listenToken = generateToken();
  const listenHash = await hashToken(listenToken);
  let hint = deviceLabel(ctx.userAgent);
  if (ctx.userId) {
    const p = await one<{ name: string }>("SELECT name FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC, created_at LIMIT 1", [ctx.userId]);
    if (p?.name) hint = p.name;
  }
  const expiresAt = new Date(Date.now() + RENDEZVOUS_TTL_MS);
  return tx(async (c) => {
    await expireStaleRendezvous(c);
    for (let i = 0; i < 12; i++) {
      const code = generateRendezvousCode();
      const row = await one<{ id: string }>(
        `INSERT INTO exchange_rendezvous (listen_hash, code, receiver_user_id, receiver_hint, expires_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) WHERE status IN ('waiting','matched') DO NOTHING RETURNING id`,
        [listenHash, code, ctx.userId, hint, expiresAt],
        c,
      );
      if (row) return { listenToken, code, expiresAt: expiresAt.toISOString() };
    }
    throw new ApiError(503, "rendezvous_busy", "지금은 페어링 코드가 부족합니다. 잠시 후 다시 시도하세요.");
  });
}

/** Receiver polls. Once the sender confirmed, the exchange URL is handed over exactly once. */
export async function pollRendezvous(listenToken: string, ctx: Ctx) {
  if (!isWellFormedToken(listenToken)) throw notFound("rendezvous");
  await rateLimit(`rdv:poll:${ctx.ip}`, 240, 60);
  const listenHash = await hashToken(listenToken);
  return tx(async (c) => {
    const r = await one<RendezvousRow>("SELECT * FROM exchange_rendezvous WHERE listen_hash=$1 FOR UPDATE", [listenHash], c);
    if (!r) throw notFound("rendezvous");
    const status = rendezvousStatusAt({ status: r.status, expiresAt: r.expires_at, matchedAt: r.matched_at });
    if (status === "expired" && r.status !== "expired") await c.query("UPDATE exchange_rendezvous SET status='expired' WHERE id=$1", [r.id]);
    let senderName: string | null = null;
    if (r.exchange_session_id && (status === "matched" || status === "confirmed")) {
      const s = await one<{ sender_profile_id: string }>("SELECT sender_profile_id FROM exchange_sessions WHERE id=$1", [r.exchange_session_id], c);
      if (s) senderName = (await getExchangeCard(s.sender_profile_id, c)).name;
    }
    let url: string | null = null;
    if (status === "confirmed" && r.token_enc) {
      url = `${appOrigin()}/x/${unsealText(r.token_enc)}`;
      await c.query("UPDATE exchange_rendezvous SET token_enc=NULL, delivered_at=now() WHERE id=$1", [r.id]);
    }
    return { status, code: r.code, expiresAt: r.expires_at.toISOString(), senderName, url };
  });
}

export async function cancelRendezvous(listenToken: string) {
  if (!isWellFormedToken(listenToken)) throw notFound("rendezvous");
  await q("UPDATE exchange_rendezvous SET status='rejected', token_enc=NULL WHERE listen_hash=$1 AND status IN ('waiting','matched')", [await hashToken(listenToken)]);
  return { cancelled: true };
}

async function lockSenderSession(c: pg.PoolClient, ctx: Ctx, sessionId: string): Promise<SessionRow> {
  if (!ctx.userId) throw unauthorized();
  const s = await one<SessionRow & { token_hash: string }>("SELECT * FROM exchange_sessions WHERE id=$1 AND sender_user_id=$2 FOR UPDATE", [sessionId, ctx.userId], c);
  if (!s) throw notFound("exchange");
  if (!acceptsReply(s.state, s.expires_at)) throw conflict("exchange_closed", "이미 끝났거나 만료된 교환입니다.");
  return s;
}

/** Sender types the code they hear; the server matches it only inside the receiver's time window. */
export async function matchRendezvous(ctx: Ctx, sessionId: string, rawCode: string) {
  if (!ctx.userId) throw unauthorized();
  const code = normalizeRendezvousCode(rawCode);
  if (!code) throw badRequest("invalid_code", "4자리 숫자를 입력하세요.");
  await rateLimit(`rdv:match:${sessionId}`, RENDEZVOUS_MAX_ATTEMPTS, 600);
  await rateLimit(`rdv:matchu:${ctx.userId}`, 30, 600);
  return tx(async (c) => {
    await lockSenderSession(c, ctx, sessionId);
    await expireStaleRendezvous(c);
    const r = await one<RendezvousRow>("SELECT * FROM exchange_rendezvous WHERE code=$1 AND status='waiting' AND expires_at > now() FOR UPDATE", [code], c);
    if (!r) throw new ApiError(404, "rendezvous_not_found", "코드를 찾지 못했어요. 상대 화면의 숫자를 다시 확인하세요.");
    if (r.receiver_user_id === ctx.userId) throw badRequest("self_exchange", "자기 자신과는 교환할 수 없습니다.");
    await c.query("UPDATE exchange_rendezvous SET status='matched', exchange_session_id=$2, matched_at=now() WHERE id=$1", [r.id, sessionId]);
    return { rendezvousId: r.id, receiverHint: r.receiver_hint, confirmBy: new Date(Date.now() + RENDEZVOUS_CONFIRM_MS).toISOString() };
  });
}

/** Sender confirms (or rejects) the matched receiver. Proves possession of the session token. */
export async function confirmRendezvous(ctx: Ctx, sessionId: string, rendezvousId: string, token: string, accept: boolean) {
  if (!ctx.userId) throw unauthorized();
  if (!isWellFormedToken(token)) throw badRequest("invalid_token");
  const started = Date.now();
  const out = await tx(async (c) => {
    const s = await lockSenderSession(c, ctx, sessionId);
    if ((s as SessionRow & { token_hash: string }).token_hash !== (await hashToken(token))) throw forbidden();
    const r = await one<RendezvousRow>("SELECT * FROM exchange_rendezvous WHERE id=$1 AND exchange_session_id=$2 FOR UPDATE", [rendezvousId, sessionId], c);
    if (!r) throw notFound("rendezvous");
    const status = rendezvousStatusAt({ status: r.status, expiresAt: r.expires_at, matchedAt: r.matched_at });
    if (status !== "matched") throw conflict("rendezvous_" + status, "페어링 시간이 지났습니다. 다시 시도하세요.");
    if (!accept) {
      await c.query("UPDATE exchange_rendezvous SET status='rejected' WHERE id=$1", [r.id]);
      return { status: "rejected" as const };
    }
    await c.query("UPDATE exchange_rendezvous SET status='confirmed', confirmed_at=now(), token_enc=$2 WHERE id=$1", [r.id, sealText(token)]);
    await audit(c, ctx, "exchange.rendezvous_confirmed", "exchange_session", sessionId);
    return { status: "confirmed" as const };
  });
  if (out.status === "confirmed") await recordAttempt(ctx, sessionId, "web_rendezvous", "success", Date.now() - started);
  return out;
}

// =====================================================================================
// F-039 앱 근접 교환 / F-040 근접 확인 (native apps only)
// =====================================================================================
/** Sender's app asks for an ephemeral id to advertise. Rotate every PROXIMITY_ROTATE_MS. */
export async function issueProximityId(ctx: Ctx, sessionId: string) {
  if (!ctx.userId) throw unauthorized();
  await rateLimit(`prox:issue:${ctx.userId}`, 120, 600);
  const eph = generateEphemeralId();
  const expiresAt = new Date(Date.now() + PROXIMITY_ID_TTL_MS);
  return tx(async (c) => {
    await lockSenderSession(c, ctx, sessionId);
    await c.query("DELETE FROM proximity_ids WHERE exchange_session_id=$1 AND expires_at < now()", [sessionId]);
    await c.query("INSERT INTO proximity_ids (exchange_session_id, eph_hash, expires_at) VALUES ($1,$2,$3)", [sessionId, sha256(eph), expiresAt]);
    return { ephemeralId: eph, serviceUuid: ephemeralIdToServiceUuid(eph), expiresAt: expiresAt.toISOString(), rotateAfterMs: PROXIMITY_ROTATE_MS };
  });
}

interface MatchRow {
  id: string;
  exchange_session_id: string;
  receiver_user_id: string;
  verify_code: string;
  status: "pending" | "exchanged" | "rejected" | "expired";
  sender_confirmed_at: Date | null;
  receiver_confirmed_at: Date | null;
  expires_at: Date;
}

/**
 * Receiver's app saw a consistently close advertiser (evaluateProximity on device) and resolves it.
 * Returns only the sender's public headline + the shared 4-digit code; nothing is exchanged until both confirm.
 */
export async function resolveProximity(ctx: Ctx, ephemeralId: string, rssi: number) {
  if (!ctx.userId) throw unauthorized();
  const receiverId = ctx.userId;
  await rateLimit(`prox:resolve:${receiverId}`, 30, 60);
  if (!isEphemeralId(ephemeralId)) throw badRequest("invalid_ephemeral_id");
  if (!Number.isFinite(rssi) || rssi < DEFAULT_PROXIMITY_POLICY.rssiThreshold) throw badRequest("too_far", "조금 더 가까이 대 주세요.");
  return tx(async (c) => {
    const p = await one<{ exchange_session_id: string }>("SELECT exchange_session_id FROM proximity_ids WHERE eph_hash=$1 AND expires_at > now()", [sha256(ephemeralId)], c);
    if (!p) throw new ApiError(404, "proximity_not_found", "근처 기기를 찾지 못했어요. 다시 시도하세요.");
    const s = await one<SessionRow>("SELECT * FROM exchange_sessions WHERE id=$1 FOR UPDATE", [p.exchange_session_id], c);
    if (!s || !acceptsReply(s.state, s.expires_at)) throw conflict("exchange_closed", "상대의 교환이 끝났거나 만료되었습니다.");
    if (s.sender_user_id === receiverId) throw badRequest("self_exchange", "자기 자신과는 교환할 수 없습니다.");
    let m = await one<MatchRow>("SELECT * FROM proximity_matches WHERE exchange_session_id=$1 AND receiver_user_id=$2 FOR UPDATE", [s.id, receiverId], c);
    if (!m || m.status !== "pending" || m.expires_at.getTime() < Date.now()) {
      m = await one<MatchRow>(
        `INSERT INTO proximity_matches (exchange_session_id, receiver_user_id, verify_code, rssi, expires_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (exchange_session_id, receiver_user_id) DO UPDATE SET verify_code=EXCLUDED.verify_code, rssi=EXCLUDED.rssi, status='pending',
           sender_confirmed_at=NULL, receiver_confirmed_at=NULL, expires_at=EXCLUDED.expires_at, created_at=now()
         RETURNING *`,
        [s.id, receiverId, generateVerifyCode(), Math.round(rssi), new Date(Date.now() + PROXIMITY_MATCH_TTL_MS)],
        c,
      );
    }
    const card = await getExchangeCard(s.sender_profile_id, c);
    return { matchId: m!.id, verifyCode: m!.verify_code, expiresAt: m!.expires_at.toISOString(), sender: { name: card.name, company: card.company, jobTitle: card.jobTitle } };
  });
}

async function participantName(userId: string, c: pg.PoolClient): Promise<string> {
  const p = await one<{ name: string }>("SELECT name FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC, created_at LIMIT 1", [userId], c);
  if (p?.name) return p.name;
  const u = await one<{ display_name: string | null }>("SELECT display_name FROM users WHERE id=$1", [userId], c);
  return u?.display_name ?? "LINKOS 사용자";
}

/** Sender's app polls pending proximity matches for its session (shows the same code + the receiver's name). */
export async function listProximityMatches(ctx: Ctx, sessionId: string) {
  if (!ctx.userId) throw unauthorized();
  const s = await one("SELECT 1 FROM exchange_sessions WHERE id=$1 AND sender_user_id=$2", [sessionId, ctx.userId]);
  if (!s) throw notFound("exchange");
  return tx(async (c) => {
    const rows = await q<MatchRow>("SELECT * FROM proximity_matches WHERE exchange_session_id=$1 AND status='pending' AND expires_at > now() ORDER BY created_at DESC LIMIT 5", [sessionId], c);
    const out = [];
    for (const m of rows) out.push({ matchId: m.id, verifyCode: m.verify_code, receiverName: await participantName(m.receiver_user_id, c), senderConfirmed: !!m.sender_confirmed_at, receiverConfirmed: !!m.receiver_confirmed_at, expiresAt: m.expires_at.toISOString() });
    return { matches: out };
  });
}

function matchView(m: MatchRow, role: "sender" | "receiver", extra: Record<string, unknown> = {}) {
  const expired = m.status === "pending" && m.expires_at.getTime() < Date.now();
  return { matchId: m.id, role, status: expired ? "expired" : m.status, senderConfirmed: !!m.sender_confirmed_at, receiverConfirmed: !!m.receiver_confirmed_at, ...extra };
}

export async function getProximityMatch(ctx: Ctx, matchId: string) {
  if (!ctx.userId) throw unauthorized();
  const m = await one<MatchRow & { sender_user_id: string }>(
    "SELECT m.*, s.sender_user_id FROM proximity_matches m JOIN exchange_sessions s ON s.id = m.exchange_session_id WHERE m.id=$1",
    [matchId],
  );
  if (!m || (m.sender_user_id !== ctx.userId && m.receiver_user_id !== ctx.userId)) throw notFound("proximity_match");
  return matchView(m, m.sender_user_id === ctx.userId ? "sender" : "receiver");
}

/**
 * Both people confirm that their screens show the same code. When the second confirmation lands, the exchange is
 * performed atomically: the receiver's Living Card is replied into the sender's session (mutual relationship).
 */
export async function confirmProximity(ctx: Ctx, matchId: string, accept: boolean) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const started = Date.now();
  return tx(async (c) => {
    const pre = await one<{ exchange_session_id: string }>("SELECT exchange_session_id FROM proximity_matches WHERE id=$1", [matchId], c);
    if (!pre) throw notFound("proximity_match");
    // lock order: session, then match (same as resolveProximity)
    const s = await one<SessionRow>("SELECT * FROM exchange_sessions WHERE id=$1 FOR UPDATE", [pre.exchange_session_id], c);
    const m = await one<MatchRow>("SELECT * FROM proximity_matches WHERE id=$1 FOR UPDATE", [matchId], c);
    if (!s || !m) throw notFound("proximity_match");
    const role = s.sender_user_id === userId ? "sender" : m.receiver_user_id === userId ? "receiver" : null;
    if (!role) throw notFound("proximity_match");
    if (m.status !== "pending") return matchView(m, role);
    if (m.expires_at.getTime() < Date.now()) {
      await c.query("UPDATE proximity_matches SET status='expired' WHERE id=$1", [m.id]);
      return matchView({ ...m, status: "expired" }, role);
    }
    if (!accept) {
      await c.query("UPDATE proximity_matches SET status='rejected' WHERE id=$1", [m.id]);
      await audit(c, ctx, "exchange.proximity_rejected", "exchange_session", s.id, { role });
      return matchView({ ...m, status: "rejected" }, role);
    }
    const col = role === "sender" ? "sender_confirmed_at" : "receiver_confirmed_at";
    const upd = await one<MatchRow>(`UPDATE proximity_matches SET ${col} = COALESCE(${col}, now()) WHERE id=$1 RETURNING *`, [m.id], c);
    if (!upd!.sender_confirmed_at || !upd!.receiver_confirmed_at) return matchView(upd!, role);

    // both confirmed → exchange (receiver shares their exchange-audience card; sender's was offered by advertising)
    if (!acceptsReply(s.state, s.expires_at)) throw conflict("exchange_closed", "상대의 교환이 끝났거나 만료되었습니다.");
    const receiverProfile = await primaryProfileId(m.receiver_user_id, c);
    if (!receiverProfile) throw new ApiError(422, "profile_required", "받는 사람의 Living Card가 필요합니다.");
    const rc = await getExchangeCard(receiverProfile, c);
    const contact = cardToContact(rc);
    const card: ReplyInput["card"] = {
      fullName: contact.fullName,
      company: contact.company,
      jobTitle: contact.jobTitle,
      email: contact.email,
      phone: contact.phone,
      address: contact.address,
      website: contact.website,
    };
    const sharedFields = (Object.keys(card) as (keyof typeof card)[]).filter((k) => card[k]);
    const result = await applyReply(c, s, { ...ctx, userId: m.receiver_user_id }, {
      card,
      sharedFields,
      consent: { exchange: true },
      provenance: Object.fromEntries(sharedFields.map((k) => [k, { source: "user" as const }])),
    });
    await c.query("UPDATE proximity_matches SET status='exchanged' WHERE id=$1", [m.id]);
    await c.query("INSERT INTO exchange_attempts (exchange_session_id, channel, outcome, latency_ms) VALUES ($1,'ble_proximity','success',$2)", [s.id, Date.now() - started]);
    await emit(c, "exchange.channel.attempted", "exchange_session", s.id, { session_id: s.id, channel: "ble_proximity", outcome: "success", latency_ms: Date.now() - started });
    await audit(c, ctx, "exchange.proximity_exchanged", "exchange_session", s.id, { match: m.id });
    return matchView({ ...upd!, status: "exchanged" }, role, { receiverContactId: role === "receiver" ? result.receiverContactId : null });
  });
}

// =====================================================================================
// F-052 오프라인 큐: per-device keys + signed receipts
// =====================================================================================
export const deviceKeyInput = z.object({ platform: z.enum(["ios", "android", "web"]), label: z.string().trim().max(60).optional() });
const MAX_DEVICE_KEYS = 10;

export async function registerDeviceKey(ctx: Ctx, input: z.infer<typeof deviceKeyInput>) {
  if (!ctx.userId) throw unauthorized();
  await rateLimit(`dkey:${ctx.userId}`, 10, 86400);
  const keyId = `dk_${generateToken(16)}`;
  const secret = randomBytes(32).toString("base64url");
  return tx(async (c) => {
    const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM device_exchange_keys WHERE user_id=$1 AND revoked_at IS NULL", [ctx.userId], c);
    if ((n?.n ?? 0) >= MAX_DEVICE_KEYS) {
      // keep the newest MAX-1 keys active
      await c.query(
        `UPDATE device_exchange_keys SET revoked_at=now() WHERE id IN (
           SELECT id FROM device_exchange_keys WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at ASC LIMIT $2)`,
        [ctx.userId, (n?.n ?? 0) - MAX_DEVICE_KEYS + 1],
      );
    }
    await c.query("INSERT INTO device_exchange_keys (key_id, user_id, secret_enc, platform, label) VALUES ($1,$2,$3,$4,$5)", [keyId, ctx.userId, sealText(secret), input.platform, input.label ?? null]);
    await audit(c, ctx, "device_key.registered", "device_exchange_key", null, { keyId, platform: input.platform });
    return { keyId, secret };
  });
}

export async function revokeDeviceKey(ctx: Ctx, keyId: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await q<{ id: string }>("UPDATE device_exchange_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE key_id=$1 AND user_id=$2 RETURNING id", [keyId, ctx.userId]);
  if (!r.length) throw notFound("device_key");
  return { revoked: true };
}

interface KeyRow {
  key_id: string;
  user_id: string;
  secret_enc: string;
  revoked_at: Date | null;
}

export const syncReceiptsInput = z.object({
  receipts: z.array(z.object({ payload: z.string().min(10).max(4096), signature: z.string().min(20).max(128) })).min(1).max(50),
});

export type ReceiptResult =
  | { receiptId: string | null; status: "created" | "duplicate"; contactId: string; mutual: boolean }
  | { receiptId: string | null; status: "rejected"; reason: string };

/** Upload queued receipts after reconnecting. Each receipt is verified and applied idempotently in its own transaction. */
export async function syncOfflineReceipts(ctx: Ctx, input: z.infer<typeof syncReceiptsInput>): Promise<{ results: ReceiptResult[] }> {
  if (!ctx.userId) throw unauthorized();
  await rateLimit(`offline:sync:${ctx.userId}`, 30, 600);
  const results: ReceiptResult[] = [];
  for (const r of input.receipts) results.push(await syncOne(ctx, ctx.userId, r));
  return { results };
}

async function syncOne(ctx: Ctx, receiverId: string, signed: { payload: string; signature: string }): Promise<ReceiptResult> {
  const reject = (reason: string, receiptId: string | null = null): ReceiptResult => ({ receiptId, status: "rejected", reason });
  const rc = parseOfflineReceipt(signed.payload);
  if (!rc) return reject("malformed");
  const rkey = await one<KeyRow>("SELECT key_id, user_id, secret_enc, revoked_at FROM device_exchange_keys WHERE key_id=$1", [rc.k]);
  if (!rkey || rkey.user_id !== receiverId) return reject("unknown_device_key", rc.id);
  if (!verifyOfflineReceiptSignature(signed, unsealText(rkey.secret_enc))) return reject("bad_signature", rc.id);
  // `at` is device-claimed (could be backdated with a stolen key), so a revoked key is refused outright
  if (rkey.revoked_at) return reject("device_key_revoked", rc.id);

  const prior = await one<{ result: ReceiptResult }>("SELECT result FROM offline_receipts WHERE key_id=$1 AND receipt_id=$2", [rc.k, rc.id]);
  if (prior) return prior.result.status === "rejected" ? prior.result : { ...prior.result, status: "duplicate" };

  const pass = parseOfflinePass(rc.pass);
  if (!pass) return reject("malformed_pass", rc.id);
  const skey = await one<KeyRow>("SELECT key_id, user_id, secret_enc, revoked_at FROM device_exchange_keys WHERE key_id=$1", [pass.claims.k]);
  if (!skey || skey.user_id !== pass.claims.u) return reject("unknown_sender_key", rc.id);
  if (skey.revoked_at) return reject("sender_key_revoked", rc.id);
  const claims = verifyOfflinePass(rc.pass, unsealText(skey.secret_enc));
  if (!claims) return reject("bad_pass_signature", rc.id);
  const windowErr = checkReceiptWindow(rc, claims, receiverId);
  if (windowErr) return reject(windowErr, rc.id);
  const senderProfile = await one<{ id: string }>("SELECT id FROM profiles WHERE id=$1 AND user_id=$2", [claims.p, claims.u]);
  if (!senderProfile) return reject("invalid_pass", rc.id);

  return tx(async (c) => {
    // claim the idempotency slot first; a concurrent upload of the same receipt waits on the unique index
    const slot = await one<{ id: string }>(
      `INSERT INTO offline_receipts (key_id, receipt_id, receiver_user_id, sender_user_id, pass_nonce, occurred_at, result)
       VALUES ($1,$2,$3,$4,$5,$6,'{}') ON CONFLICT DO NOTHING RETURNING id`,
      [rc.k, rc.id, receiverId, claims.u, claims.r, new Date(rc.at)],
      c,
    );
    if (!slot) {
      const existing = await one<{ result: ReceiptResult }>(
        "SELECT result FROM offline_receipts WHERE (key_id=$1 AND receipt_id=$2) OR (receiver_user_id=$3 AND sender_user_id=$4 AND pass_nonce=$5) LIMIT 1",
        [rc.k, rc.id, receiverId, claims.u, claims.r],
        c,
      );
      const res = existing?.result;
      if (res && res.status !== "rejected") return { ...res, receiptId: rc.id, status: "duplicate" } as ReceiptResult;
      return reject("duplicate", rc.id);
    }
    const occurredAt = new Date(rc.at).toISOString();
    const senderCard = await getExchangeCard(claims.p, c);
    const mine = await insertContact(
      c,
      receiverId,
      { ...cardToContact(senderCard), encounter: { occurredAt, placeLabel: rc.pl?.slice(0, 120) } },
      { linkedUserId: claims.u, encounterSource: "offline_receipt" },
    );
    const relationshipIds = [mine.relationshipId];
    let mutual = false;
    await recordConsents(c, claims.u, [{ type: "exchange", granted: true }], { offline_pass: claims.r });
    if (rc.rc) {
      const receiverProfile = await primaryProfileId(receiverId, c);
      if (receiverProfile) {
        const receiverCard = await getExchangeCard(receiverProfile, c);
        const theirs = await insertContact(
          c,
          claims.u,
          { ...cardToContact(receiverCard), encounter: { occurredAt, placeLabel: rc.pl?.slice(0, 120) } },
          { linkedUserId: receiverId, encounterSource: "offline_receipt" },
        );
        relationshipIds.push(theirs.relationshipId);
        await recordConsents(c, receiverId, [{ type: "exchange", granted: true }], { offline_receipt: rc.id });
        mutual = true;
      }
    }
    const result: ReceiptResult = { receiptId: rc.id, status: "created", contactId: mine.contactId, mutual };
    await c.query("UPDATE offline_receipts SET result=$2 WHERE id=$1", [slot.id, JSON.stringify(result)]);
    await emit(c, "exchange.completed", "offline_receipt", slot.id, { relationship_ids: relationshipIds, encounter_id: mine.encounterId });
    await audit(c, ctx, "exchange.offline_synced", "offline_receipt", slot.id, { mutual });
    return result;
  });
}
