import { crm } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-128 Sync Journal — external ids/etags, errors, retries, conflicts
export const GET = route(async ({ ctx, req }) => crm.syncJournal(ctx.userId!, parse(crm.journalQuery, Object.fromEntries(req.nextUrl.searchParams))));
