import { assistantJobs } from "@linkos/api";
import { route } from "@/lib/server";

// X-006 one-tap re-connect message — saved as a DRAFT in /app/messages, never sent automatically (CLAUDE.md rule 8)
export const POST = route<{ contactId: string }>(async ({ ctx, params }) => assistantJobs.createReconnectDraft(ctx, params.contactId), { status: 201 });
