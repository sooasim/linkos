import "server-only";
import { org } from "@linkos/api";
import { getViewer } from "@/lib/server";

export type OrgInfo = Awaited<ReturnType<typeof org.getOrg>>;

/** Active workspace (F-129) for server components; null = personal workspace. */
export async function loadActiveOrg(): Promise<{ userId: string; org: OrgInfo | null }> {
  const { userId, ctx } = await getViewer();
  const id = await org.activeOrgId(userId!);
  return { userId: userId!, org: id ? await org.getOrg(ctx, id) : null };
}
