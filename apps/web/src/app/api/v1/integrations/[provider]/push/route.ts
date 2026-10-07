import { crm } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const provider = (p: string) => z.enum(crm.CRM_PROVIDERS).parse(p);
// queue contact/lead pushes (idempotent per contact version); the worker processes them serially per account
export const POST = route<{ provider: string }>(async ({ ctx, params, body }) => crm.enqueueCrmPush(ctx, provider(params.provider), parse(crm.pushInput, body)), { status: 202 });
