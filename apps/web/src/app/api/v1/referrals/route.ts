import { growth } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => growth.myReferrals(ctx));
