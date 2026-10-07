import { crm } from "@linkos/api";
import { z } from "zod";
import { route } from "@/lib/server";

const provider = (p: string) => z.enum(crm.CRM_PROVIDERS).parse(p);
export const DELETE = route<{ provider: string }>(async ({ ctx, params }) => crm.disconnectProvider(ctx, provider(params.provider)));
