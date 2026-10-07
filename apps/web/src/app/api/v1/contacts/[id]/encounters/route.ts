import { relationship } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const schema = z.object({ placeLabel: z.string().max(200).optional(), note: z.string().max(2000).optional(), occurredAt: z.string().datetime().optional(), eventId: z.string().uuid().optional() });

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => relationship.addEncounter(ctx, params.id, parse(schema, body)), { status: 201 });
