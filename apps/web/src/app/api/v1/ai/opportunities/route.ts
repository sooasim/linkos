import { network } from "@linkos/api";
import { route } from "@/lib/server";

// F-099 Opportunity Detection (needs in notes/meetings/cards ↔ offers in my network)
export const GET = route(async ({ ctx }) => network.opportunities(ctx));
