import { security } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => ({ entries: await security.myAuditLog(ctx.userId!) }));
