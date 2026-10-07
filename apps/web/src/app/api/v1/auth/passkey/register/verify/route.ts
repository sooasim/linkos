import { passkey } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const POST = route(async ({ ctx, body }) => passkey.verifyRegistration(ctx, parse(passkey.registerVerifyInput, body)), { status: 201 });
