import { connection } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => connection.getConnectionRoom(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) =>
  connection.updateRoom(ctx, params.id, parse(z.object({ nextAction: z.string().max(300).nullish(), status: z.enum(["active", "won", "archived"]).optional() }), body)),
);
