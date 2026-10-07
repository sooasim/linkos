import { growth } from "@linkos/api";
import { route } from "@/lib/server";

// F-181 feature flags (admin)
export const GET = route(async ({ ctx }) => ({ flags: await growth.listFlags(ctx) }));
