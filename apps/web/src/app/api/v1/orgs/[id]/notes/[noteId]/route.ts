import { org } from "@linkos/api";
import { route } from "@/lib/server";

export const DELETE = route<{ id: string; noteId: string }>(async ({ ctx, params }) => org.deleteTeamNote(ctx, params.id, params.noteId));
