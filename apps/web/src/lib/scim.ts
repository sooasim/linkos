import "server-only";
import { enterprise, log } from "@linkos/api";
import { type NextRequest, NextResponse } from "next/server";

/** SCIM 2.0 handler wrapper (F-008): bearer SCIM token → org id, application/scim+json bodies, SCIM error schema. */
export function scim<P = Record<string, string>>(fn: (args: { orgId: string; req: NextRequest; params: P; body: unknown }) => Promise<{ status?: number; body?: unknown }>) {
  return async (req: NextRequest, context: { params: Promise<P> }) => {
    try {
      const orgId = await enterprise.scimAuth(req.headers.get("authorization"));
      let body: unknown = undefined;
      if (!["GET", "DELETE"].includes(req.method)) {
        const ct = req.headers.get("content-type") ?? "";
        if (!/application\/(scim\+)?json/.test(ct)) throw new enterprise.ScimError(415, "content-type must be application/scim+json");
        body = await req.json().catch(() => {
          throw new enterprise.ScimError(400, "invalid JSON", "invalidSyntax");
        });
      }
      const out = await fn({ orgId, req, params: await context.params, body });
      if (out.status === 204) return new NextResponse(null, { status: 204 });
      return NextResponse.json(out.body, { status: out.status ?? 200, headers: { "content-type": "application/scim+json" } });
    } catch (e) {
      const err = e instanceof enterprise.ScimError ? e : (() => {
        log("error", "scim.unhandled", { error: (e as Error)?.message });
        return new enterprise.ScimError(500, "internal error");
      })();
      return NextResponse.json(err.toJSON(), { status: err.status, headers: { "content-type": "application/scim+json" } });
    }
  };
}
