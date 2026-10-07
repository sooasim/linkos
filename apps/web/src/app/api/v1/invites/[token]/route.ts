import { org } from "@linkos/api";
import { route } from "@/lib/server";

// public preview: org name + role only
export const GET = route<{ token: string }>(async ({ params }) => org.previewInvite(params.token), { auth: false });
export const POST = route<{ token: string }>(async ({ ctx, params }) => org.acceptInvite(ctx, params.token));
