import { referral } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => referral.myReferrals(ctx));
