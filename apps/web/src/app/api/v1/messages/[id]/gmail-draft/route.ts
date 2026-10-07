import { comms } from "@linkos/api";
import { route } from "@/lib/server";

// F-115 Gmail — save the draft into the user's Gmail Drafts (nothing is sent)
export const POST = route<{ id: string }>(async ({ ctx, params }) => comms.saveGmailDraft(ctx, params.id));
