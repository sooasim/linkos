import { org } from "@linkos/api";
import { route } from "@/lib/server";

// F-004 join by verified email domain (auto → active, approval → pending)
export const POST = route<{ id: string }>(async ({ ctx, params }) => org.joinByDomain(ctx, params.id));
