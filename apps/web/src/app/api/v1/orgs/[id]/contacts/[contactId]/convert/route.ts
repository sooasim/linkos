import { org } from "@linkos/api";
import { route } from "@/lib/server";

// F-132 give my shared contact to the company (becomes a company-owned lead)
export const POST = route<{ id: string; contactId: string }>(async ({ ctx, params }) => org.convertToCompanyLead(ctx, params.id, params.contactId));
