import { org } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-076 team-scoped notes (private notes are never returned here)
export const GET = route<{ id: string; contactId: string }>(async ({ ctx, params }) => ({ notes: await org.listTeamNotes(ctx, params.id, params.contactId) }));
export const POST = route<{ id: string; contactId: string }>(async ({ ctx, params, body }) => org.addTeamNote(ctx, params.id, params.contactId, parse(z.object({ body: z.string().trim().min(1).max(5000) }), body).body), { status: 201 });
