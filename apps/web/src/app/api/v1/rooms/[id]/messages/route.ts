import { connection } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  await connection.postRoomMessage(ctx, params.id, parse(z.object({ body: z.string().trim().min(1).max(4000) }), body).body);
  return { ok: true };
}, { status: 201 });
