import { booth } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// booth team (owner + staff)
export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ team: await booth.listTeam(ctx, params.id) }));
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const b = parse(z.object({ userId: z.string().uuid(), staff: z.boolean() }), body);
  return booth.setStaff(ctx, params.id, b.userId, b.staff);
});
