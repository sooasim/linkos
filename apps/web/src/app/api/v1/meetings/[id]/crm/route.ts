import { crm } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-088 CRM 연결 — attach the meeting summary to each participant's CRM record (Task / Note / Annotation)
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const { provider } = parse(z.object({ provider: z.enum(["salesforce", "hubspot", "dynamics"]) }), body);
  return crm.attachMeetingToCrm(ctx, params.id, provider);
});
