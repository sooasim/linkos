import "server-only";
// F-181 server helper for Server Components / route handlers (process-cached, kill switch honored).
import { growth } from "@linkos/api";
import { cookies } from "next/headers";
import { ANON_COOKIE, getViewer } from "./server";

export async function serverFlag(key: string): Promise<boolean> {
  const { userId } = await getViewer();
  const anonId = (await cookies()).get(ANON_COOKIE)?.value ?? null;
  return growth.flagEnabled(key, { userId, anonId });
}
