// handoff module — Adaptive Handoff & Exchange (F-037~F-052) + Guest Viral Conversion (F-053~F-064)
// 핵심 규칙: 교환이 가입보다 먼저, QR은 최종 폴백, 토큰은 해시만 저장하고 PII 없음.
import {
  CLAIM_TTL_MS,
  type CapabilityVector,
  type Channel,
  DEFAULT_CAPABILITIES,
  EXCHANGE_TTL_MS,
  type ExchangeState,
  GROUP_EXCHANGE_TTL_MS,
  SHORT_CODE_TTL_MS,
  acceptsReply,
  canTransition,
  generateShortCode,
  generateToken,
  hashToken,
  isWellFormedToken,
  normalizeShortCode,
  planChannels,
} from "@linkos/domain";
import type pg from "pg";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, conflict, gone, notFound, unauthorized } from "../lib/errors";
import { type Ctx, appOrigin, audit, emit, rateLimit, sha256 } from "../lib/platform";
import { type PublicCard, getExchangeCard, loadProfile, primaryProfileId, saveProfile } from "./card";
import { recordReferral } from "./referral";
import { recordConsents } from "./identity";
import { track } from "../lib/metering";
import { consume } from "./billing";
import { adaptCardForSession } from "./living";
import { insertContact } from "./relationship";

export const capabilityInput = z
  .object({
    installedApp: z.boolean().optional(),
    nativeBle: z.boolean().optional(),
    receiverHasApp: z.boolean().nullable().optional(),
    webShare: z.boolean().optional(),
    appClipEntry: z.boolean().optional(),
    nfcAccessoryEnabled: z.boolean().optional(),
    camera: z.boolean().optional(),
    online: z.boolean().optional(),
    pwaInstalled: z.boolean().optional(),
    receiverMode: z.enum(["unknown", "nearby_app", "web_exchange_screen"]).optional(),
    experimentalAcoustic: z.boolean().optional(),
  })
  .partial()
  .default({});

export const createSessionInput = z.object({
  capabilities: capabilityInput,
  group: z.boolean().default(false),
  maxUses: z.number().int().min(1).max(500).optional(),
  profileId: z.string().uuid().optional(),
  context: z
    .object({
      placeLabel: z.string().max(120).optional(),
      eventId: z.string().uuid().optional(),
      /** F-031 explicit audience variant chosen by the sender */
      audience: z.enum(["investor", "customer", "partner", "recruiting", "general"]).optional(),
    })
    .default({}),
});

export interface SessionRow {
  id: string;
  sender_user_id: string;
  sender_profile_id: string;
  state: ExchangeState;
  expires_at: Date;
  selected_channel: string | null;
  short_code: string | null;
  short_code_expires_at: Date | null;
  is_group: boolean;
  max_uses: number;
  use_count: number;
  channel_plan: string[];
  receiver_opened_at: Date | null;
  context: Record<string, any>;
  created_at: Date;
}

export async function createExchangeSession(ctx: Ctx, input: z.infer<typeof createSessionInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await rateLimit(`xch:create:${userId}`, 60, 3600);
  const profileId = input.profileId ?? (await primaryProfileId(userId));
  if (!profileId) throw new ApiError(422, "profile_required", "먼저 내 명함(Living Card)을 만들어 주세요.");
  const prof = await one<{ user_id: string }>("SELECT user_id FROM profiles WHERE id=$1", [profileId]);
  if (prof?.user_id !== userId) throw notFound("profile");

  const cap: CapabilityVector = { ...DEFAULT_CAPABILITIES, ...input.capabilities } as CapabilityVector;
  // F-044: a registered, active NFC accessory adds the NFC step even if this browser never saw the settings toggle
  if (!cap.nfcAccessoryEnabled && cap.online) {
    cap.nfcAccessoryEnabled = Boolean(await one("SELECT 1 FROM nfc_tags WHERE owner_user_id=$1 AND revoked_at IS NULL LIMIT 1", [userId]));
  }
  const plan = planChannels(cap);
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const ttl = input.group ? GROUP_EXCHANGE_TTL_MS : EXCHANGE_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  return tx(async (c) => {
    // F-192: the sender's plan meters exchanges (402 + upgrade info). Receiving/replying as a guest is never metered.
    await consume(c, userId, "exchanges");
    let shortCode: string | null = null;
    if (plan.includes("short_code")) {
      for (let i = 0; i < 5 && !shortCode; i++) {
        const cand = generateShortCode();
        const clash = await one("SELECT 1 FROM exchange_sessions WHERE short_code=$1 AND short_code_expires_at > now()", [cand], c);
        if (!clash) {
          await c.query("UPDATE exchange_sessions SET short_code=NULL WHERE short_code=$1", [cand]);
          shortCode = cand;
        }
      }
    }
    const row = await one<SessionRow>(
      `INSERT INTO exchange_sessions (sender_user_id, sender_profile_id, token_hash, state, expires_at, selected_channel, short_code, short_code_expires_at, is_group, max_uses, channel_plan, context)
       VALUES ($1,$2,$3,'CHANNEL_SELECTED',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [userId, profileId, tokenHash, expiresAt, plan[0], shortCode, shortCode ? new Date(Date.now() + Math.min(ttl, input.group ? ttl : SHORT_CODE_TTL_MS)) : null, input.group, input.group ? (input.maxUses ?? 200) : 1, plan, JSON.stringify(input.context ?? {})],
      c,
    );
    await emit(c, "exchange.session.created", "exchange_session", row!.id, {
      session_id: row!.id,
      sender_id: userId,
      channel_candidates: plan,
      expires_at: expiresAt.toISOString(),
    });
    await audit(c, ctx, "exchange.session_created", "exchange_session", row!.id, { group: input.group });
    await track(c, "exchange_created", { userId }, { channel: plan[0], group: input.group, at_event: !!input.context?.eventId });
    const origin = appOrigin();
    return {
      sessionId: row!.id,
      token,
      url: `${origin}/x/${token}`,
      shortCode,
      shortUrl: shortCode ? `${origin}/c/${shortCode}` : null,
      channelPlan: plan,
      expiresAt: expiresAt.toISOString(),
      state: row!.state,
    };
  });
}

async function findSession(tokenOrCode: string, db: Db = pool(), forUpdate = false): Promise<SessionRow> {
  const lock = forUpdate ? " FOR UPDATE" : "";
  let row: SessionRow | null = null;
  if (isWellFormedToken(tokenOrCode)) {
    row = await one<SessionRow>(`SELECT * FROM exchange_sessions WHERE token_hash=$1${lock}`, [await hashToken(tokenOrCode)], db);
  } else {
    const code = normalizeShortCode(tokenOrCode);
    if (!code) throw notFound("exchange");
    row = await one<SessionRow>(`SELECT * FROM exchange_sessions WHERE short_code=$1 AND short_code_expires_at > now()${lock}`, [code], db);
  }
  if (!row) throw notFound("exchange");
  return row;
}

export async function setState(db: Db, s: SessionRow, to: ExchangeState) {
  if (s.state === to) return;
  if (!canTransition(s.state, to)) throw conflict("invalid_state", `exchange is ${s.state}`);
  await db.query("UPDATE exchange_sessions SET state=$2, updated_at=now() WHERE id=$1", [s.id, to]);
  s.state = to;
}

/** Sender-side: record a handoff attempt outcome and advance the ladder (F-048 자동 폴백). */
export async function recordAttempt(ctx: Ctx, sessionId: string, channel: Channel, outcome: "success" | "failed" | "cancelled" | "timeout" | "unsupported", latencyMs?: number, reason?: string) {
  if (!ctx.userId) throw unauthorized();
  return tx(async (c) => {
    const s = await one<SessionRow>("SELECT * FROM exchange_sessions WHERE id=$1 AND sender_user_id=$2 FOR UPDATE", [sessionId, ctx.userId], c);
    if (!s) throw notFound("exchange");
    await c.query("INSERT INTO exchange_attempts (exchange_session_id, channel, outcome, reason, latency_ms) VALUES ($1,$2,$3,$4,$5)", [s.id, channel, outcome, reason ?? null, latencyMs ?? null]);
    await emit(c, "exchange.channel.attempted", "exchange_session", s.id, { session_id: s.id, channel, outcome, latency_ms: latencyMs ?? null });
    const plan = s.channel_plan as Channel[];
    let next: Channel | null = null;
    if (outcome === "success") {
      if (["CHANNEL_SELECTED", "CHANNEL_FAILED", "CREATED"].includes(s.state)) await setState(c, s, "OFFERED");
    } else if (acceptsReply(s.state, s.expires_at) && !["RECEIVER_OPENED", "CONSENT_PENDING"].includes(s.state)) {
      const idx = plan.indexOf(channel);
      next = (plan[idx + 1] as Channel | undefined) ?? "qr";
      if (s.state === "CHANNEL_SELECTED" || s.state === "OFFERED") await setState(c, s, "CHANNEL_FAILED");
      await c.query("UPDATE exchange_sessions SET selected_channel=$2 WHERE id=$1", [s.id, next]);
    }
    return { state: s.state, nextChannel: next };
  });
}

export async function revokeSession(ctx: Ctx, sessionId: string) {
  if (!ctx.userId) throw unauthorized();
  return tx(async (c) => {
    const s = await one<SessionRow>("SELECT * FROM exchange_sessions WHERE id=$1 AND sender_user_id=$2 FOR UPDATE", [sessionId, ctx.userId], c);
    if (!s) throw notFound("exchange");
    if (s.is_group && ["RECEIVER_OPENED", "CONSENT_PENDING"].includes(s.state)) {
      await c.query("UPDATE exchange_sessions SET state='REVOKED', revoked_at=now() WHERE id=$1", [s.id]);
    } else {
      await setState(c, s, "REVOKED");
      await c.query("UPDATE exchange_sessions SET revoked_at=now(), short_code=NULL WHERE id=$1", [s.id]);
    }
    await audit(c, ctx, "exchange.revoked", "exchange_session", s.id);
    return { state: "REVOKED" };
  });
}

/** Sender polls/streams this (SSE) to see receiver progress (백서 20: status propagation p95 < 1s). */
export async function getSenderSessionStatus(ctx: Ctx, sessionId: string) {
  if (!ctx.userId) throw unauthorized();
  const s = await one<SessionRow>("SELECT * FROM exchange_sessions WHERE id=$1 AND sender_user_id=$2", [sessionId, ctx.userId]);
  if (!s) throw notFound("exchange");
  const latest = await q<{ id: string; full_name: string; company: string | null }>(
    `SELECT c.id, c.full_name, co.name AS company FROM encounters e JOIN contacts c ON c.id = e.contact_id LEFT JOIN companies co ON co.id = c.company_id
     WHERE e.exchange_session_id=$1 AND e.owner_user_id=$2 ORDER BY e.occurred_at DESC LIMIT 20`,
    [s.id, ctx.userId],
  );
  const expired = s.expires_at.getTime() < Date.now() && !["EXCHANGED", "CLAIM_PENDING", "CLAIMED", "SYNCED"].includes(s.state);
  return {
    sessionId: s.id,
    state: expired ? ("EXPIRED" as ExchangeState) : s.state,
    selectedChannel: s.selected_channel,
    channelPlan: s.channel_plan,
    receiverOpenedAt: s.receiver_opened_at,
    useCount: s.use_count,
    isGroup: s.is_group,
    expiresAt: s.expires_at,
    received: latest.map((r) => ({ contactId: r.id, fullName: r.full_name, company: r.company })),
  };
}

export interface GuestLanding {
  sessionId: string;
  state: ExchangeState;
  sender: PublicCard;
  expiresAt: string;
  acceptsReply: boolean;
  isGroup: boolean;
  placeLabel: string | null;
}

/** F-053 비회원 즉시 열람 — no login wall, public-safe card only. */
export async function openGuestLanding(tokenOrCode: string, ctx: Ctx, anonymousReceiverId: string): Promise<GuestLanding> {
  await rateLimit(`xch:open:${ctx.ip}`, normalizeShortCode(tokenOrCode) && !isWellFormedToken(tokenOrCode) ? 30 : 120, 60);
  const s = await findSession(tokenOrCode);
  if (s.state === "REVOKED" || s.state === "CANCELLED") throw gone("exchange_revoked", "보낸 사람이 교환을 취소했습니다.");
  const open = acceptsReply(s.state, s.expires_at);
  if (!open && s.expires_at.getTime() < Date.now() && !["EXCHANGED", "CLAIM_PENDING", "CLAIMED", "SYNCED"].includes(s.state)) {
    throw gone("exchange_expired", "교환 링크가 만료되었습니다. 상대에게 새 링크를 요청하세요.");
  }
  if (open && !s.receiver_opened_at) {
    await tx(async (c) => {
      const locked = await one<SessionRow>("SELECT * FROM exchange_sessions WHERE id=$1 FOR UPDATE", [s.id], c);
      if (locked && !locked.receiver_opened_at) {
        if (canTransition(locked.state, "RECEIVER_OPENED")) await setState(c, locked, "RECEIVER_OPENED");
        await c.query("UPDATE exchange_sessions SET receiver_opened_at=now() WHERE id=$1", [s.id]);
        await emit(c, "exchange.receiver.opened", "exchange_session", s.id, { session_id: s.id, anonymous_receiver_id: sha256(anonymousReceiverId).slice(0, 16) });
        await track(c, "guest_landing_viewed", { anonId: `session:${s.id}` }, { signed_in: !!ctx.userId });
        s.state = locked.state;
      }
    });
  }
  return {
    sessionId: s.id,
    state: s.state,
    // F-031: audience variant chosen from the sender's explicit choice / event audience
    sender: await adaptCardForSession(await getExchangeCard(s.sender_profile_id), s.sender_profile_id, s.context),
    expiresAt: s.expires_at.toISOString(),
    acceptsReply: open,
    isGroup: s.is_group,
    placeLabel: (s.context?.placeLabel as string | undefined) ?? null,
  };
}

const guestField = z.string().trim().max(300).nullish();
export const replyInput = z.object({
  card: z.object({
    fullName: z.string().trim().min(1).max(120),
    company: guestField,
    jobTitle: guestField,
    department: guestField,
    email: guestField,
    phone: guestField,
    address: guestField,
    website: guestField,
  }),
  /** which of the card fields the guest explicitly agreed to send (F-058 전송 필드 명시) */
  sharedFields: z.array(z.enum(["fullName", "company", "jobTitle", "department", "email", "phone", "address", "website"])).min(1),
  consent: z.object({ exchange: z.literal(true), policyVersion: z.string().optional() }),
  provenance: z.record(z.string(), z.object({ source: z.enum(["ocr", "user"]), confidence: z.number().min(0).max(1).optional() })).default({}),
  ocr: z
    .object({
      lines: z.array(z.object({ text: z.string().max(500), confidence: z.number().optional() })).max(80),
      language: z.string().max(10).optional(),
    })
    .optional(),
  message: z.string().trim().max(500).optional(),
  offer: z.string().trim().max(200).optional(),
  need: z.string().trim().max(200).optional(),
});
export type ReplyInput = z.infer<typeof replyInput>;

/**
 * F-054~F-060: guest reciprocates. Creates the sender's Contact + BusinessCard evidence + Encounter + Relationship
 * in one transaction, and a claim token for the guest (Claim comes AFTER exchange).
 * If the receiver is already signed in, the reverse relationship is created immediately.
 */
export async function replyExchange(tokenOrCode: string, ctx: Ctx, input: ReplyInput) {
  await rateLimit(`xch:reply:${ctx.ip}`, 20, 600);
  return tx(async (c) => applyReply(c, await findSession(tokenOrCode, c, true), ctx, input));
}

/** Lock-holding core of replyExchange; `s` must have been selected FOR UPDATE on `c`. Also used by F-039 proximity. */
export async function applyReply(c: pg.PoolClient, s: SessionRow, ctx: Ctx, input: ReplyInput) {
  {
    if (!acceptsReply(s.state, s.expires_at)) {
      if (s.expires_at.getTime() < Date.now()) throw gone("exchange_expired", "교환 링크가 만료되었습니다.");
      throw conflict("already_exchanged", "이미 교환이 완료된 링크입니다.");
    }
    if (s.use_count >= s.max_uses) throw conflict("exchange_full", "이 그룹 교환 링크의 인원이 가득 찼습니다.");
    if (ctx.userId && ctx.userId === s.sender_user_id) throw badRequest("self_exchange", "자기 자신과는 교환할 수 없습니다.");

    // Only the fields the guest explicitly approved leave the device boundary.
    const shared: Record<string, string | null> = {};
    for (const k of input.sharedFields) shared[k] = (input.card as Record<string, string | null | undefined>)[k] ?? null;
    if (!shared.fullName) shared.fullName = input.card.fullName;
    const provenance: Record<string, { source: string; confidence?: number }> = {};
    for (const k of Object.keys(shared)) provenance[k] = input.provenance[k] ?? { source: "user" };

    let businessCardId: string | null = null;
    if (input.ocr?.lines.length) {
      const bc = await one<{ id: string }>(
        `INSERT INTO business_cards (captured_by, raw_ocr, structured_data, confidence, source) VALUES ($1,$2,$3,$4,'guest_exchange') RETURNING id`,
        [s.sender_user_id, JSON.stringify({ lines: input.ocr.lines, language: input.ocr.language }), JSON.stringify(shared), JSON.stringify(Object.fromEntries(Object.entries(provenance).map(([k, v]) => [k, v.confidence ?? null])))],
        c,
      );
      businessCardId = bc!.id;
    }

    // Sender side: guest becomes a Contact of the sender
    const senderSide = await insertContact(
      c,
      s.sender_user_id,
      {
        fullName: shared.fullName!,
        company: shared.company,
        jobTitle: shared.jobTitle,
        department: shared.department,
        email: shared.email,
        phone: shared.phone,
        address: shared.address,
        website: shared.website,
        source: "exchange",
        provenance,
        businessCardId,
        encounter: { placeLabel: s.context?.placeLabel, note: input.message, eventId: s.context?.eventId },
      },
      { linkedUserId: ctx.userId, exchangeSessionId: s.id, encounterSource: "exchange" },
    );
    if (businessCardId) {
      await emit(c, "card.extraction.completed", "business_card", businessCardId, {
        card_id: businessCardId,
        fields: Object.keys(shared),
        confidence: Object.fromEntries(Object.entries(provenance).map(([k, v]) => [k, v.confidence ?? 1])),
      });
    }
    // Suggest a thank-you follow-up for the sender (draft only — never auto-sent)
    await c.query(
      `INSERT INTO followups (owner_user_id, contact_id, kind, title, body_draft, due_at, source) VALUES ($1,$2,'thank_you',$3,$4, now() + interval '1 day','ai_suggested')`,
      [s.sender_user_id, senderSide.contactId, `${shared.fullName}님께 감사 인사`, `${shared.fullName}님, 오늘 만나서 반가웠습니다. 나눈 이야기 이어서 연락드리겠습니다.`],
    );

    const relationshipIds = [senderSide.relationshipId];
    let claimToken: string | null = null;
    let receiverContactId: string | null = null;
    const senderCard = await getExchangeCard(s.sender_profile_id, c); // same connection: never borrow a 2nd one while holding the row lock
    const senderProfile = await loadProfile(s.sender_profile_id, c);

    if (ctx.userId) {
      // Signed-in receiver: reverse relationship right away
      const rev = await insertContact(c, ctx.userId, cardToContact(senderCard), { linkedUserId: s.sender_user_id, exchangeSessionId: s.id, encounterSource: "exchange" });
      relationshipIds.push(rev.relationshipId);
      receiverContactId = rev.contactId;
      await recordConsents(c, ctx.userId, [{ type: "exchange", granted: true }], { session: s.id, fields: input.sharedFields });
    } else {
      claimToken = generateToken();
      await c.query(
        `INSERT INTO guest_claims (exchange_session_id, claim_token_hash, draft_contact, expires_at) VALUES ($1,$2,$3,$4)`,
        [
          s.id,
          await hashToken(claimToken),
          JSON.stringify({
            guest: shared,
            offer: input.offer ?? null,
            need: input.need ?? null,
            provenance,
            consent: { exchange: true, at: new Date().toISOString(), fields: input.sharedFields },
            sender: { userId: s.sender_user_id, profileId: s.sender_profile_id, card: senderCard },
            senderContactId: senderSide.contactId,
            placeLabel: s.context?.placeLabel ?? null,
            eventId: s.context?.eventId ?? null,
          }),
          new Date(Date.now() + CLAIM_TTL_MS),
        ],
      );
    }

    // A reply implies the receiver opened the link (API clients / native apps may skip the landing GET).
    if (!["RECEIVER_OPENED", "CONSENT_PENDING"].includes(s.state)) {
      await setState(c, s, "RECEIVER_OPENED");
      await c.query("UPDATE exchange_sessions SET receiver_opened_at = COALESCE(receiver_opened_at, now()) WHERE id=$1", [s.id]);
    }
    const newUseCount = s.use_count + 1;
    if (!s.is_group || newUseCount >= s.max_uses) {
      await setState(c, s, "EXCHANGED");
      if (claimToken) await setState(c, s, "CLAIM_PENDING");
      await c.query("UPDATE exchange_sessions SET short_code=NULL WHERE id=$1", [s.id]);
    }
    await c.query("UPDATE exchange_sessions SET use_count=$2, updated_at=now() WHERE id=$1", [s.id, newUseCount]);
    await emit(c, "exchange.completed", "exchange_session", s.id, { relationship_ids: relationshipIds, encounter_id: senderSide.encounterId });
    await audit(c, { userId: ctx.userId }, "exchange.completed", "exchange_session", s.id, { guest: !ctx.userId, fields: input.sharedFields });
    await track(c, "guest_replied", { anonId: `session:${s.id}` }, { signed_in: !!ctx.userId, fields: input.sharedFields.length });

    return {
      exchanged: true,
      sessionId: s.id,
      claimToken,
      receiverContactId,
      sender: senderCard,
      senderName: senderProfile?.name ?? senderCard.name,
    };
  }
}

export function cardToContact(card: PublicCard) {
  const f = (t: string) => card.fields.find((x) => x.type === t)?.value ?? null;
  return {
    fullName: card.name,
    company: card.company,
    jobTitle: card.jobTitle,
    email: f("email"),
    phone: f("mobile") ?? f("phone"),
    address: f("address"),
    website: f("website"),
    source: "exchange" as const,
    provenance: { fullName: { source: "exchange" } },
  };
}

/** F-003 / F-061 계정 Claim: 게스트가 만든 카드/관계를 가입 후 소유. 데이터 유실 없이 귀속. */
export async function claimGuest(ctx: Ctx, claimToken: string) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  if (!isWellFormedToken(claimToken)) throw badRequest("invalid_claim");
  await rateLimit(`claim:${userId}`, 20, 600);
  return tx(async (c: pg.PoolClient) => {
    const g = await one<{ id: string; exchange_session_id: string | null; draft_contact: any; claimed_user_id: string | null; expires_at: Date }>(
      "SELECT * FROM guest_claims WHERE claim_token_hash=$1 FOR UPDATE",
      [await hashToken(claimToken)],
      c,
    );
    if (!g) throw notFound("claim");
    if (g.claimed_user_id) {
      if (g.claimed_user_id === userId) return { claimed: true, alreadyClaimed: true, profileId: await primaryProfileId(userId, c), senderContactId: null };
      throw conflict("already_claimed", "이미 다른 계정에서 소유한 카드입니다.");
    }
    if (g.expires_at.getTime() < Date.now()) throw gone("claim_expired", "Claim 기간이 지났습니다.");
    const d = g.draft_contact;
    if (d.sender?.userId === userId) throw badRequest("self_claim");

    // 1) Guest's own Living Card from the reviewed draft (if the user has none yet)
    let profileId = await primaryProfileId(userId, c);
    if (!profileId) {
      const fields: { type: "email" | "phone" | "website" | "address"; value: string; visibility: "business" }[] = [];
      if (d.guest.email) fields.push({ type: "email", value: d.guest.email, visibility: "business" });
      if (d.guest.phone) fields.push({ type: "phone", value: d.guest.phone, visibility: "business" });
      if (d.guest.website) fields.push({ type: "website", value: d.guest.website, visibility: "business" });
      if (d.guest.address) fields.push({ type: "address", value: d.guest.address, visibility: "business" });
      const p = await saveProfile(
        ctx,
        {
          name: d.guest.fullName,
          company: d.guest.company ?? null,
          jobTitle: d.guest.jobTitle ?? null,
          headline: null,
          bioShort: null,
          bioLong: null,
          keywords: [],
          industries: [],
          regions: [],
          theme: "ink",
          matchingOptIn: true,
          deep: {},
          fields,
          offers: d.offer ? [d.offer] : [],
          needs: d.need ? [d.need] : [],
          variants: [],
        },
        undefined,
        c,
      );
      profileId = p.id;
    }

    // 2) Reverse relationship: the sender becomes the claimant's contact
    const senderCard = d.sender.card as PublicCard;
    const rev = await insertContact(c, userId, { ...cardToContact(senderCard), source: "claim", encounter: { placeLabel: d.placeLabel ?? undefined, eventId: d.eventId ?? undefined } }, {
      linkedUserId: d.sender.userId,
      exchangeSessionId: g.exchange_session_id,
      encounterSource: "exchange",
    });

    // 3) Link the sender's contact record to the now-real user
    if (d.senderContactId) await c.query("UPDATE contacts SET linked_user_id=$1 WHERE id=$2", [userId, d.senderContactId]);

    await recordConsents(c, userId, [{ type: "exchange", granted: true }], { claimed_from: g.id, fields: d.consent?.fields ?? [] });
    await c.query("UPDATE guest_claims SET claimed_user_id=$1, claimed_at=now() WHERE id=$2", [userId, g.id]);
    if (g.exchange_session_id) {
      const s = await one<SessionRow>("SELECT * FROM exchange_sessions WHERE id=$1 FOR UPDATE", [g.exchange_session_id], c);
      if (s && canTransition(s.state, "CLAIMED")) await setState(c, s, "CLAIMED");
    }
    // F-064: privacy-safe referral attribution (sender brought this NEW account in via the exchange)
    if (d.sender?.userId) {
      await recordReferral(c, { referrerId: d.sender.userId, referredId: userId, source: "exchange_claim", touchpointAt: (g as { created_at?: Date }).created_at ?? new Date(), exchangeSessionId: g.exchange_session_id });
    }
    await emit(c, "guest.claimed", "guest_claim", g.id, { guest_claim_id: g.id, user_id: userId });
    await audit(c, ctx, "guest.claimed", "guest_claim", g.id);
    await track(c, "guest_claimed", { userId }, { from_session: !!g.exchange_session_id });
    return { claimed: true, alreadyClaimed: false, profileId, senderContactId: rev.contactId };
  });
}

export async function previewClaim(claimToken: string) {
  if (!isWellFormedToken(claimToken)) throw badRequest("invalid_claim");
  const g = await one<{ draft_contact: any; claimed_user_id: string | null; expires_at: Date }>(
    "SELECT draft_contact, claimed_user_id, expires_at FROM guest_claims WHERE claim_token_hash=$1",
    [await hashToken(claimToken)],
  );
  if (!g) throw notFound("claim");
  return {
    guest: g.draft_contact.guest as Record<string, string | null>,
    senderName: (g.draft_contact.sender?.card?.name as string) ?? null,
    claimed: Boolean(g.claimed_user_id),
    expiresAt: g.expires_at,
  };
}

export async function recentSessions(userId: string) {
  return q<any>(
    `SELECT id, state, selected_channel, is_group, use_count, expires_at, created_at FROM exchange_sessions WHERE sender_user_id=$1 ORDER BY created_at DESC LIMIT 20`,
    [userId],
  );
}
