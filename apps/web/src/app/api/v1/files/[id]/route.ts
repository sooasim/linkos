import { files } from "@linkos/api";
import { route } from "@/lib/server";
import { fileResponse } from "@/lib/upload";

// F-019/F-024/F-156 signed short-lived download (the HMAC signature is the capability). Quarantined files → 423.
export const GET = route<{ id: string }>(async ({ req, params }) => {
  const sp = req.nextUrl.searchParams;
  const o = await files.downloadSigned(params.id, sp.get("exp"), sp.get("sig"));
  return fileResponse(o, sp.get("download") === "1");
}, { auth: false });
