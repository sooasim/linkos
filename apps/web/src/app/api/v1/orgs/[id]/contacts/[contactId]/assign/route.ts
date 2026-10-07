import { org } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-077 담당자 재배정 (company-owned leads, manager+)
export const POST = route<{ id: string; contactId: string }>(async ({ ctx, params, body }) => org.assignLead(ctx, params.id, params.contactId, parse(z.object({ userId: z.string().uuid() }), body).userId));
