import { ApiError, card, handoff } from "@linkos/api";
import { generateToken } from "@linkos/domain";
import { getViewer } from "@/lib/server";
import { GuestFlow } from "./GuestFlow";
import { LinkState } from "./LinkState";

export async function GuestLanding({ tokenOrCode }: { tokenOrCode: string }) {
  const { userId, ctx } = await getViewer();
  let landing: Awaited<ReturnType<typeof handoff.openGuestLanding>>;
  try {
    landing = await handoff.openGuestLanding(tokenOrCode, ctx, generateToken(16));
  } catch (e) {
    const code = e instanceof ApiError ? e.code : "error";
    return <LinkState code={code} />;
  }
  let viewerCard: Record<string, string> | null = null;
  if (userId) {
    const pid = await card.primaryProfileId(userId);
    const p = pid ? await card.loadProfile(pid) : null;
    if (p) {
      const f = (t: string) => p.fields.find((x) => x.type === t)?.value ?? "";
      viewerCard = { fullName: p.name, company: p.company ?? "", jobTitle: p.jobTitle ?? "", department: "", email: f("email"), phone: f("mobile") || f("phone"), address: f("address"), website: f("website") };
    }
  }
  return <GuestFlow token={tokenOrCode} landing={JSON.parse(JSON.stringify(landing))} signedIn={!!userId} viewerCard={viewerCard} />;
}
