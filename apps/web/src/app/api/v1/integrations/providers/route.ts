import { crm } from "@linkos/api";
import { route } from "@/lib/server";

// F-119~F-122 provider status (Microsoft, Salesforce, HubSpot, Dynamics)
export const GET = route(async ({ ctx }) => ({ providers: await crm.crmStatus(ctx.userId!) }));
