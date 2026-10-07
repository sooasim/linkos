// connection module — 소개와 Connection Room (백서 19). 양측 동의 전 연락처 비공개.
import { type IntroState, canIntroTransition, contactsRevealed } from "@linkos/domain";
import { z } from "zod";
import { one, pool, q, tx } from "../lib/db";
import { badRequest, conflict, notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit } from "../lib/platform";

export const introInput = z.object({
  partyAContactId: z.string().uuid(),
  partyBContactId: z.string().uuid(),
  reason: z.string().trim().min(1).max(1000),
});

export async function createIntroduction(ctx: Ctx, input: z.infer<typeof introInput>) {
  if (!ctx.userId) throw unauthorized();
  if (input.partyAContactId === input.partyBContactId) throw badRequest("same_party");
  const owned = await q<{ id: string }>("SELECT id FROM contacts WHERE owner_user_id=$1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL", [ctx.userId, [input.partyAContactId, input.partyBContactId]]);
  if (owned.length !== 2) throw notFound("contact");
  const r = await one<{ id: string }>(
    "INSERT INTO introductions (introducer_user_id, party_a_contact_id, party_b_contact_id, reason) VALUES ($1,$2,$3,$4) RETURNING id",
    [ctx.userId, input.partyAContactId, input.partyBContactId, input.reason],
  );
  await audit(pool(), ctx, "intro.proposed", "introduction", r!.id);
  return getIntroduction(ctx, r!.id);
}

export async function getIntroduction(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const i = await one<any>(
    `SELECT i.*, a.full_name AS a_name, ac.name AS a_company, b.full_name AS b_name, bc.name AS b_company,
       (SELECT id FROM connection_rooms r WHERE r.introduction_id = i.id LIMIT 1) AS room_id
     FROM introductions i JOIN contacts a ON a.id=i.party_a_contact_id JOIN contacts b ON b.id=i.party_b_contact_id
     LEFT JOIN companies ac ON ac.id=a.company_id LEFT JOIN companies bc ON bc.id=b.company_id
     WHERE i.id=$1 AND i.introducer_user_id=$2`,
    [id, ctx.userId],
  );
  if (!i) throw notFound("introduction");
  return {
    id: i.id,
    state: i.state as IntroState,
    reason: i.reason,
    partyA: { contactId: i.party_a_contact_id, name: i.a_name, company: i.a_company, status: i.party_a_status },
    partyB: { contactId: i.party_b_contact_id, name: i.b_name, company: i.b_company, status: i.party_b_status },
    contactsRevealed: contactsRevealed(i.state),
    roomId: i.room_id,
    createdAt: i.created_at,
  };
}

export async function listIntroductions(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  const ids = await q<{ id: string }>("SELECT id FROM introductions WHERE introducer_user_id=$1 ORDER BY created_at DESC LIMIT 50", [ctx.userId]);
  return Promise.all(ids.map((r) => getIntroduction(ctx, r.id)));
}

/** The introducer records each party's answer after asking them (consent-based introduction). */
export async function recordIntroConsent(ctx: Ctx, id: string, party: "a" | "b", accepted: boolean) {
  if (!ctx.userId) throw unauthorized();
  await tx(async (c) => {
    const i = await one<any>("SELECT * FROM introductions WHERE id=$1 AND introducer_user_id=$2 FOR UPDATE", [id, ctx.userId], c);
    if (!i) throw notFound("introduction");
    if (["DECLINED", "ARCHIVED"].includes(i.state)) throw conflict("intro_closed");
    const col = party === "a" ? "party_a_status" : "party_b_status";
    await c.query(`UPDATE introductions SET ${col}=$2 WHERE id=$1`, [id, accepted ? "accepted" : "declined"]);
    const a = party === "a" ? (accepted ? "accepted" : "declined") : i.party_a_status;
    const b = party === "b" ? (accepted ? "accepted" : "declined") : i.party_b_status;
    let state: IntroState = i.state;
    if (a === "declined" || b === "declined") state = "DECLINED";
    else if (a === "accepted" && b === "accepted") state = "PARTY_B_ACCEPTED";
    else if (a === "accepted" || b === "accepted") state = "PARTY_A_ACCEPTED";
    if (state !== i.state && !(canIntroTransition(i.state, state) || (i.state === "INTRO_PROPOSED" && state === "PARTY_B_ACCEPTED"))) throw conflict("invalid_intro_transition");
    if (state === "PARTY_B_ACCEPTED") {
      const room = await one<{ id: string }>(
        "INSERT INTO connection_rooms (introduction_id, title, purpose, owner_user_id) VALUES ($1,$2,$3,$4) RETURNING id",
        [id, "Connection Room", i.reason, ctx.userId],
        c,
      );
      await c.query("INSERT INTO connection_room_messages (room_id, author_user_id, body) VALUES ($1,$2,$3)", [room!.id, ctx.userId, `소개 이유: ${i.reason}`]);
      state = "ROOM_CREATED";
    }
    await c.query("UPDATE introductions SET state=$2 WHERE id=$1", [id, state]);
    await audit(c, ctx, "intro.consent", "introduction", id, { party, accepted });
  });
  return getIntroduction(ctx, id);
}

export async function getConnectionRoom(ctx: Ctx, roomId: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<any>("SELECT * FROM connection_rooms WHERE id=$1 AND owner_user_id=$2", [roomId, ctx.userId]);
  if (!r) throw notFound("room");
  const intro = r.introduction_id ? await getIntroduction(ctx, r.introduction_id) : null;
  const messages = await q<any>("SELECT id, body, created_at, author_user_id FROM connection_room_messages WHERE room_id=$1 ORDER BY created_at", [roomId]);
  return { id: r.id, title: r.title, purpose: r.purpose, status: r.status, nextAction: r.next_action, introduction: intro, messages };
}

export async function postRoomMessage(ctx: Ctx, roomId: string, body: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one("SELECT 1 FROM connection_rooms WHERE id=$1 AND owner_user_id=$2", [roomId, ctx.userId]);
  if (!r) throw notFound("room");
  await q("INSERT INTO connection_room_messages (room_id, author_user_id, body) VALUES ($1,$2,$3)", [roomId, ctx.userId, body]);
}

export async function updateRoom(ctx: Ctx, roomId: string, patch: { nextAction?: string | null; status?: "active" | "won" | "archived" }) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<{ introduction_id: string | null }>(
    "UPDATE connection_rooms SET next_action = COALESCE($3, next_action), status = COALESCE($4, status) WHERE id=$1 AND owner_user_id=$2 RETURNING introduction_id",
    [roomId, ctx.userId, patch.nextAction ?? null, patch.status ?? null],
  );
  if (!r) throw notFound("room");
  if (patch.status && r.introduction_id) {
    const map = { active: "ACTIVE", won: "WON", archived: "ARCHIVED" } as const;
    await q("UPDATE introductions SET state=$2 WHERE id=$1", [r.introduction_id, map[patch.status]]);
  }
  return getConnectionRoom(ctx, roomId);
}
