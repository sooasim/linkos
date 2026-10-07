import { enterprise } from "@linkos/api";
import { scim } from "@/lib/scim";

type P = { id: string };
export const GET = scim<P>(async ({ orgId, params }) => ({ body: await enterprise.scimGet(orgId, params.id) }));
export const PUT = scim<P>(async ({ orgId, params, body }) => ({ body: await enterprise.scimReplace(orgId, params.id, body) }));
export const PATCH = scim<P>(async ({ orgId, params, body }) => ({ body: await enterprise.scimPatch(orgId, params.id, body) }));
// deprovision: removes org membership (company leads reassigned); the person's own account is not deleted
export const DELETE = scim<P>(async ({ orgId, params }) => {
  await enterprise.scimDelete(orgId, params.id);
  return { status: 204 };
});
