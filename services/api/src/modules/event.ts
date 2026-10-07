// event module — Events & Networking: 행사 워크스페이스, 참가 opt-in, 행사 매칭(공유하기로 한 데이터만 사용)
import { generateShortCode } from "@linkos/domain";
import { z } from "zod";
import { one, q, tx } from "../lib/db";
import { ApiError, notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit } from "../lib/platform";
import { primaryProfileId } from "./card";
import { listMatches } from "./ai";

export const eventInput = z.object({
  name: z.string().trim().min(1).max(200),
  venue: z.string().trim().max(200).nullish(),
  startsAt: z.string().datetime().nullish(),
  endsAt: z.string().datetime().nullish(),
});

export async function createEvent(ctx: Ctx, input: z.infer<typeof eventInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  return tx(async (c) => {
    const e = await one<{ id: string; join_code: string }>(
      "INSERT INTO events (name, venue, starts_at, ends_at, owner_user_id, join_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, join_code",
      [input.name, input.venue ?? null, input.startsAt ?? null, input.endsAt ?? null, userId, generateShortCode()],
      c,
    );
    const pid = await primaryProfileId(userId, c);
    await c.query("INSERT INTO event_attendees (event_id, user_id, profile_id, opt_in, metadata) VALUES ($1,$2,$3,true,$4)", [e!.id, userId, pid, JSON.stringify({ role: "organizer" })]);
    await audit(c, ctx, "event.created", "event", e!.id);
    return { id: e!.id, joinCode: e!.join_code };
  });
}

export async function joinEvent(ctx: Ctx, joinCode: string, optIn: boolean) {
  if (!ctx.userId) throw unauthorized();
  const e = await one<{ id: string }>("SELECT id FROM events WHERE join_code=$1", [joinCode.toUpperCase()]);
  if (!e) throw notFound("event");
  const pid = await primaryProfileId(ctx.userId);
  if (!pid) throw new ApiError(422, "profile_required", "행사 참여 전 내 명함을 만들어 주세요.");
  const existing = await one<{ id: string }>("SELECT id FROM event_attendees WHERE event_id=$1 AND user_id=$2", [e.id, ctx.userId]);
  if (existing) await q("UPDATE event_attendees SET opt_in=$2, profile_id=$3 WHERE id=$1", [existing.id, optIn, pid]);
  else await q("INSERT INTO event_attendees (event_id, user_id, profile_id, opt_in) VALUES ($1,$2,$3,$4)", [e.id, ctx.userId, pid, optIn]);
  return { eventId: e.id, optIn };
}

export async function listMyEvents(userId: string) {
  return q<any>(
    `SELECT e.id, e.name, e.venue, e.starts_at, e.join_code, e.owner_user_id = $1 AS is_owner, ea.opt_in,
       (SELECT count(*)::int FROM event_attendees x WHERE x.event_id=e.id) AS attendees,
       (SELECT count(*)::int FROM encounters en WHERE en.event_id=e.id AND en.owner_user_id=$1) AS my_leads
     FROM events e JOIN event_attendees ea ON ea.event_id=e.id AND ea.user_id=$1 ORDER BY COALESCE(e.starts_at, now()) DESC`,
    [userId],
  );
}

export async function getEvent(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const e = await one<any>(
    `SELECT e.*, ea.opt_in FROM events e JOIN event_attendees ea ON ea.event_id=e.id AND ea.user_id=$2 WHERE e.id=$1`,
    [id, ctx.userId],
  );
  if (!e) throw notFound("event");
  const leads = await q<any>(
    `SELECT c.id, c.full_name, co.name AS company, en.occurred_at FROM encounters en JOIN contacts c ON c.id=en.contact_id LEFT JOIN companies co ON co.id=c.company_id
     WHERE en.event_id=$1 AND en.owner_user_id=$2 ORDER BY en.occurred_at DESC`,
    [id, ctx.userId],
  );
  const attendees = await one<{ n: number; opted: number }>("SELECT count(*)::int AS n, count(*) FILTER (WHERE opt_in)::int AS opted FROM event_attendees WHERE event_id=$1", [id]);
  return {
    id: e.id,
    name: e.name,
    venue: e.venue,
    startsAt: e.starts_at,
    joinCode: e.join_code,
    isOwner: e.owner_user_id === ctx.userId,
    optIn: e.opt_in,
    attendees: attendees?.n ?? 0,
    optedIn: attendees?.opted ?? 0,
    leads: leads.map((l) => ({ contactId: l.id, fullName: l.full_name, company: l.company, at: l.occurred_at })),
  };
}

export async function eventMatches(ctx: Ctx, id: string) {
  await getEvent(ctx, id);
  return listMatches(ctx, { eventId: id });
}
