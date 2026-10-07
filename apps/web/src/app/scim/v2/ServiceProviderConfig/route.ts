import { enterprise } from "@linkos/api";
import { scim } from "@/lib/scim";

export const GET = scim(async () => ({ body: enterprise.scimServiceProviderConfig() }));
