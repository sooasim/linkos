import { crm } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const provider = (p: string) => z.enum(crm.CRM_PROVIDERS).parse(p);
// OAuth start: returns the provider authorization URL (signed state; Dynamics needs the org URL)
export const POST = route<{ provider: string }>(async ({ ctx, params, body }) => crm.crmAuthUrl(provider(params.provider), ctx.userId!, parse(crm.connectInput, body)));
