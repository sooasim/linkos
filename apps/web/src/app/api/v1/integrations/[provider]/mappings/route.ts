import { crm } from "@linkos/api";
import { CRM_OBJECTS } from "@linkos/domain";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const provider = (p: string) => z.enum(crm.CRM_PROVIDERS).parse(p);
// F-127 필드 매핑
export const GET = route<{ provider: string }>(async ({ ctx, params, req }) => crm.getFieldMapping(ctx.userId!, provider(params.provider), z.enum(CRM_OBJECTS).parse(req.nextUrl.searchParams.get("object") ?? "contact")));
export const PUT = route<{ provider: string }>(async ({ ctx, params, body }) => crm.saveFieldMapping(ctx, provider(params.provider), parse(crm.mappingInput, body)));
