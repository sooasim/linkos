import { channels } from "@linkos/api";
import { route } from "@/lib/server";

// F-044: revoke a lost/handed-over tag — future taps show "비활성화된 태그".
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => channels.revokeNfcTag(ctx, params.id));
