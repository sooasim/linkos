import { security } from "@linkos/api";
import { route } from "@/lib/server";

export const POST = route(async ({ ctx }) => ({ status: "ready", data: await security.exportMyData(ctx) }), { status: 202 });
