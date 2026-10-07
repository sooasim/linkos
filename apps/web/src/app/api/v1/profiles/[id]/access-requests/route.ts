import { card } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// requestProfileAccess (F-035)
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const b = parse(z.object({ fields: z.array(z.string().max(40)).max(20).default([]), message: z.string().max(500).optional() }), body);
  return card.requestAccess(ctx, params.id, b.fields, b.message);
}, { status: 201 });
