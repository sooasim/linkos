import { org } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ members: await org.listMembers(ctx, params.id) }));
