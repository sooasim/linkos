import { saml } from "@linkos/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

// F-008 SAML 2.0 SP metadata (EntityDescriptor) for the org — the IdP admin imports this URL or file.
export const GET = route<{ orgId: string }>(async ({ params }) => {
  const xml = await saml.spMetadata(params.orgId);
  return new NextResponse(xml, { headers: { "content-type": "application/samlmetadata+xml; charset=utf-8", "cache-control": "public, max-age=300" } });
}, { auth: false });
